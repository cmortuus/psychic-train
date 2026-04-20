import { z } from "zod";
import { AnonymizeMap, createAnonymizeMap, desanitize, getExtraPatterns, sanitize } from "./anonymizer.js";
import { logDebug, logError } from "./logger.js";
import { materializeFiles } from "./materialize.js";
import { countryOf, isNonUsCloud } from "./modelMeta.js";
import { preflightDaemons } from "./ollamaApi.js";
import { CancelledError, generateText } from "./providers.js";
import { AgentTurn, OperatorAction, SessionHooks, SessionRequest, SessionResult } from "./types.js";
import { resolveWorkspace } from "./workspace.js";

export { CancelledError };

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const writerFileSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const writerResponseSchema = z
  .object({
    summary: z.string().min(1),
    code: z.string().optional(),
    files: z.array(writerFileSchema).optional()
  })
  .refine(
    (value) => (value.code && value.code.length > 0) || (value.files && value.files.length > 0),
    { message: "writer must emit at least one of: code (string), files (non-empty array)" }
  );

export type WriterFile = z.infer<typeof writerFileSchema>;

const criticVerdictSchema: z.ZodType<"revise" | "approved", z.ZodTypeDef, unknown> = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "approved") {
    return "approved";
  }

  if (
    normalized === "revise" ||
    normalized === "rejected" ||
    normalized === "reject" ||
    normalized === "needs_revision" ||
    normalized === "needs-revision" ||
    normalized === "changes_requested" ||
    normalized === "changes-requested"
  ) {
    return "revise";
  }

  return normalized;
}, z.enum(["revise", "approved"]));

type CriticResponse = {
  summary: string;
  verdict: "revise" | "approved";
  required_changes: string[];
};

export const criticResponseSchema = z.object({
  summary: z.string().min(1),
  verdict: criticVerdictSchema,
  required_changes: z.array(z.string()).default([])
});

const operatorKindSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "terminal" || normalized === "run" || normalized === "command") {
    return "shell";
  }

  if (normalized === "repo" || normalized === "repository") {
    return "git";
  }

  if (normalized.startsWith("file")) {
    return "file";
  }

  return normalized;
}, z.enum(["git", "shell", "test", "file"]));

const operatorActionSchema = z.object({
  kind: operatorKindSchema,
  title: z.string().min(1),
  detail: z.string().min(1),
  command: z.string().min(1).optional()
});

export const operatorResponseSchema = z.object({
  summary: z.string().min(1),
  actions: z.array(operatorActionSchema).default([])
});

const writerSystemPrompt = [
  "You are the writing model in a two-agent coding system.",
  "Produce implementation output only as strict JSON.",
  "Keys: summary (required), files (preferred), code (legacy single-file fallback).",
  "summary: one paragraph describing the full set of files you are producing or changing.",
  "files: array of { path, content } objects — this is the primary shape. Use it for any project that has more than one file (tests, package.json, README, submodules, config). Paths must be relative to the workspace root; no absolute paths and no '..'.",
  "code: only use this when the whole output is a single file and you don't want to express a path. The orchestrator will treat it as a legacy entry point.",
  "Emit at least one of files or code. When modifying an existing project, return every file you are creating or changing; unchanged files can be omitted.",
  "Do not emit placeholders like \"TODO\" or \"<insert code here>\"; every file you list must be complete and compilable.",
  "When you receive critic feedback, revise the files directly and incorporate only justified changes."
].join(" ");

const criticSystemPrompt = [
  "You are a harsh, adversarial code reviewer in a two-agent coding system.",
  "Your default assumption is that the code is broken. Approve only after you have mentally executed at least three concrete scenarios and found no defects.",
  "For every review you MUST consider, in order, whether each of these categories could produce a failure or wrong result:",
  "(1) happy-path inputs,",
  "(2) empty / zero / null / missing inputs,",
  "(3) extreme, adversarial, or malformed inputs (huge sizes, unicode, injection, concurrent callers),",
  "(4) error paths (what happens when a dependency or syscall fails — does the code swallow, misreport, or corrupt state?),",
  "(5) platform / dependency assumptions (OS, Node version, missing libraries, network availability, file permissions),",
  "(6) subtle correctness bugs (off-by-one, integer overflow, precision, race conditions, locale, time zones).",
  "Name every concern as an entry in required_changes even if the writer can plausibly defend it — overshooting is safer than missing a bug.",
  "Your summary MUST briefly describe what you tested and why you did or did not approve; do not compliment the code without also stating what you verified.",
  "Respond only as strict JSON with keys: summary, verdict, required_changes.",
  "Use verdict=approved only after you've considered all six categories above and have a concrete reason each one is fine for this code."
].join(" ");

const operatorSystemPrompt = [
  "You are the operator model in a three-agent coding system.",
  "You do not rewrite code. You produce next repo or terminal actions after the review loop finishes.",
  "Respond only as strict JSON with keys: summary, actions.",
  "Each action must include kind, title, detail, and optional command.",
  "Focus on concrete repo steps such as file edits, tests, git commands, or shell commands."
].join(" ");

const operatorReviewSystemPrompt = [
  "You are the operator acting as a harsh second reviewer in a consensus coding system.",
  "The critic already signed off. You are the final gate — trust nothing.",
  "Assume the code has at least one defect until you have concretely ruled defects out. Do not approve just because the critic did.",
  "Focus on higher-order concerns the critic often misses: missed requirements from the user's original request, integration and deployment failure modes, secret or PII leakage, data loss on error paths, backwards-incompatible changes, security footguns (path traversal, injection, unsafe eval, unbounded allocation), and observability gaps.",
  "Also repeat the critic's duty: (1) empty / null inputs, (2) adversarial / extreme inputs, (3) error paths, (4) platform and dependency assumptions, (5) subtle correctness bugs. If any category wasn't clearly handled, dissent.",
  "Your summary MUST state which requirements you re-checked against the user's original request and what specific failure mode, if any, you found.",
  "Respond only as strict JSON with keys: summary, verdict, required_changes.",
  "Use verdict=approved only when every concern above has been considered and you can name a reason each one is fine. Otherwise return verdict=revise with concrete bullet points."
].join(" ");

function resolveAnonymize(request: SessionRequest): boolean {
  // When any outbound model is a non-US cloud tag, force anonymize on regardless of preference.
  const outboundModels = [request.writer.model, request.critic.model];
  if (outboundModels.some(isNonUsCloud)) return true;
  if (typeof request.anonymize === "boolean") return request.anonymize;
  const env = process.env.ANONYMIZE_OUTBOUND;
  if (!env) return false;
  return env.toLowerCase() === "true" || env === "1";
}

function enforceUsOnly(request: SessionRequest): void {
  if (!request.usOnly) return;
  const offenders = [request.writer, request.critic]
    .filter((p) => isNonUsCloud(p.model))
    .map((p) => `${p.model} (${countryOf(p.model)})`);
  if (offenders.length > 0) {
    throw new Error(
      `Invalid request: usOnly is on but a non-US model was selected: ${offenders.join(", ")}.`
    );
  }
}

function enforceLocalOperator(request: SessionRequest): void {
  if (process.env.ENFORCE_LOCAL_OPERATOR?.toLowerCase() !== "true") return;
  if (!request.operator) return;
  if (request.operator.model.includes(":cloud")) {
    throw new Error(
      `Invalid request: operator must be local (got ${request.operator.model}); set ENFORCE_LOCAL_OPERATOR=false to bypass.`
    );
  }
}

export async function runDualAgentSession(
  request: SessionRequest,
  hooks: SessionHooks = {},
  signal?: AbortSignal
): Promise<SessionResult> {
  enforceLocalOperator(request);
  enforceUsOnly(request);
  const anonymize = resolveAnonymize(request);
  const anonMap: AnonymizeMap | null = anonymize ? createAnonymizeMap() : null;
  const extraPatterns = anonymize ? getExtraPatterns() : [];
  const maybeSanitize = (text: string) => (anonMap ? sanitize(text, anonMap, extraPatterns) : text);
  const maybeDesanitize = (text: string) => (anonMap ? desanitize(text, anonMap) : text);

  const transcript: AgentTurn[] = [];
  let currentCode = "";
  let currentSummary = "";
  let pendingChanges: string[] = [];
  let operatorPlan: SessionResult["operatorPlan"];
  let latestWriterFiles: Array<{ path: string; content: string }> | undefined;

  const baseUrls = [request.writer, request.critic, request.operator]
    .filter((config): config is NonNullable<typeof config> => Boolean(config))
    .map((config) => config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL);
  await preflightDaemons(baseUrls);

  const cancelledResult = (): SessionResult => {
    const cancelledTurn: AgentTurn = {
      role: "system",
      round: Math.max(1, transcript.length),
      summary: "Session cancelled."
    };
    transcript.push(cancelledTurn);
    hooks.onTurn?.(cancelledTurn);
    return {
      transcript,
      finalCode: currentCode,
      finalFiles: finalFilesOf(latestWriterFiles, currentCode),
      status: "cancelled",
      ...(operatorPlan ? { operatorPlan } : {})
    };
  };

  const desanitizeStringsIn = <T>(value: T): T => {
    if (!anonMap) return value;
    if (typeof value === "string") return maybeDesanitize(value) as unknown as T;
    if (Array.isArray(value)) return value.map(desanitizeStringsIn) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        out[key] = desanitizeStringsIn(v);
      }
      return out as unknown as T;
    }
    return value;
  };

  const consensusMode = request.mode === "consensus" && Boolean(request.operator);
  const minRounds = Math.max(1, request.minRounds || 1);
  const unlimitedRounds =
    consensusMode || !Number.isFinite(request.maxRounds) || request.maxRounds <= 0;
  let round = 0;
  while (true) {
    round += 1;
    if (!unlimitedRounds && round > request.maxRounds) break;
    if (signal?.aborted) {
      return cancelledResult();
    }
    const writerPrompt = buildWriterPrompt(request.prompt, currentCode, currentSummary, pendingChanges);
    hooks.onRoundStart?.({
      agent: "writer",
      round,
      model: request.writer.model
    });
    const writerStartedAt = Date.now();
    const writerDataRaw = await generateStructured(
      request.writer,
      [
        { role: "system", content: writerSystemPrompt },
        { role: "user", content: maybeSanitize(writerPrompt) }
      ],
      writerResponseSchema,
      "writer",
      round,
      hooks,
      signal
    );
    const writerData = desanitizeStringsIn(writerDataRaw);
    hooks.onRoundComplete?.({
      agent: "writer",
      round,
      model: request.writer.model,
      durationMs: Date.now() - writerStartedAt
    });
    latestWriterFiles = writerData.files;
    currentCode = writerData.code || (writerData.files?.[0]?.content ?? "");
    currentSummary = writerData.summary;

    const writerTurn: AgentTurn = {
      role: "writer",
      round,
      summary: writerData.summary,
      ...(currentCode ? { code: currentCode } : {})
    };
    transcript.push(writerTurn);
    hooks.onTurn?.(writerTurn);

    const criticPrompt = buildCriticPrompt(request.prompt, currentCode, round);
    hooks.onRoundStart?.({
      agent: "critic",
      round,
      model: request.critic.model
    });
    const criticStartedAt = Date.now();
    const criticRaw = (await generateStructured(
      request.critic,
      [
        { role: "system", content: criticSystemPrompt },
        { role: "user", content: maybeSanitize(criticPrompt) }
      ],
      criticResponseSchema,
      "critic",
      round,
      hooks,
      signal
    )) as CriticResponse;
    const criticData = desanitizeStringsIn(criticRaw);
    hooks.onRoundComplete?.({
      agent: "critic",
      round,
      model: request.critic.model,
      durationMs: Date.now() - criticStartedAt
    });

    const criticTurn: AgentTurn = {
      role: "critic",
      round,
      summary: criticData.summary,
      verdict: criticData.verdict
    };
    transcript.push(criticTurn);
    hooks.onTurn?.(criticTurn);

    if (criticData.verdict === "approved") {
      const consensus = request.mode === "consensus" && request.operator;
      if (consensus) {
        hooks.onRoundStart?.({
          agent: "operator",
          round,
          model: request.operator!.model
        });
        const operatorReviewStartedAt = Date.now();
        const operatorReview = (await generateStructured(
          request.operator!,
          [
            { role: "system", content: operatorReviewSystemPrompt },
            { role: "user", content: maybeSanitize(buildOperatorReviewPrompt(request.prompt, currentCode, round)) }
          ],
          criticResponseSchema,
          "operator",
          round,
          hooks,
          signal
        )) as CriticResponse;
        const operatorReviewData = desanitizeStringsIn(operatorReview);
        hooks.onRoundComplete?.({
          agent: "operator",
          round,
          model: request.operator!.model,
          durationMs: Date.now() - operatorReviewStartedAt
        });
        const operatorReviewTurn: AgentTurn = {
          role: "operator",
          round,
          summary: operatorReviewData.summary,
          verdict: operatorReviewData.verdict
        };
        transcript.push(operatorReviewTurn);
        hooks.onTurn?.(operatorReviewTurn);

        if (operatorReviewData.verdict === "revise") {
          pendingChanges = [
            ...(criticData.required_changes ?? []),
            ...(operatorReviewData.required_changes ?? []).map((c) => `[operator] ${c}`)
          ];
          continue;
        }
      }

      if (round < minRounds) {
        const note = `[min rounds] Reviewers approved, but the session requires at least ${minRounds} rounds; propose any remaining improvements and keep iterating.`;
        pendingChanges = [note, ...(criticData.required_changes ?? [])];
        const keepGoing: AgentTurn = {
          role: "system",
          round,
          summary: `Approved but below minRounds (${round}/${minRounds}); continuing.`
        };
        transcript.push(keepGoing);
        hooks.onTurn?.(keepGoing);
        continue;
      }

      const materializedDetails = await maybeMaterialize(request, latestWriterFiles, hooks);
      if (materializedDetails) {
        const writeTurn: AgentTurn = {
          role: "system",
          round,
          summary:
            `Materialized ${materializedDetails.written.length} file(s) into ${materializedDetails.workspaceRoot}` +
            (materializedDetails.skipped.length
              ? ` (skipped ${materializedDetails.skipped.length})`
              : "")
        };
        transcript.push(writeTurn);
        hooks.onTurn?.(writeTurn);
      }

      operatorPlan = request.operator
        ? await runOperatorStage(request, currentCode, round, hooks, transcript, signal)
        : undefined;
      const systemTurn: AgentTurn = {
        role: "system",
        round,
        summary: consensus ? "Writer, critic, and operator all approved." : "Both agents reached approval."
      };
      transcript.push(systemTurn);
      hooks.onTurn?.(systemTurn);
      return {
        transcript,
        finalCode: currentCode,
        finalFiles: finalFilesOf(latestWriterFiles, currentCode),
        status: "approved",
        ...(operatorPlan ? { operatorPlan } : {})
      };
    }

    pendingChanges = criticData.required_changes ?? [];
  }

  const finalSystemTurn: AgentTurn = {
    role: "system",
    round: request.maxRounds,
    summary: "Stopped after hitting the round limit without approval."
  };
  transcript.push(finalSystemTurn);
  hooks.onTurn?.(finalSystemTurn);

  return {
    transcript,
    finalCode: currentCode,
    finalFiles: finalFilesOf(latestWriterFiles, currentCode),
    status: "max_rounds",
    ...(operatorPlan ? { operatorPlan } : {})
  };
}

function finalFilesOf(
  files: Array<{ path: string; content: string }> | undefined,
  code: string
): Array<{ path: string; content: string }> {
  if (files && files.length > 0) return files;
  if (code && code.length > 0) return [{ path: "index.txt", content: code }];
  return [];
}

async function runOperatorStage(
  request: SessionRequest,
  finalCode: string,
  round: number,
  hooks: SessionHooks,
  transcript: AgentTurn[],
  signal?: AbortSignal
) {
  if (!request.operator) {
    return undefined;
  }

  hooks.onRoundStart?.({
    agent: "operator",
    round,
    model: request.operator.model
  });
  const startedAt = Date.now();
  const operatorData = await generateStructured(
    request.operator,
    [
      { role: "system", content: operatorSystemPrompt },
      {
        role: "user",
        content: buildOperatorPrompt(request.prompt, finalCode)
      }
    ],
    operatorResponseSchema,
    "operator",
    round,
    hooks,
    signal
  );
  hooks.onRoundComplete?.({
    agent: "operator",
    round,
    model: request.operator.model,
    durationMs: Date.now() - startedAt
  });

  const operatorTurn: AgentTurn = {
    role: "operator",
    round,
    summary: operatorData.summary
  };
  transcript.push(operatorTurn);
  hooks.onTurn?.(operatorTurn);

  return {
    summary: operatorData.summary,
    actions: operatorData.actions as OperatorAction[]
  };
}

function buildWriterPrompt(
  userPrompt: string,
  currentCode: string,
  currentSummary: string,
  pendingChanges: string[]
): string {
  if (!currentCode) {
    return [
      `User request:\n${userPrompt}`,
      "Write the first complete draft."
    ].join("\n\n");
  }

  return [
    `User request:\n${userPrompt}`,
    `Current summary:\n${currentSummary}`,
    `Current code:\n${currentCode}`,
    `Critic feedback:\n${pendingChanges.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
  ].join("\n\n");
}

function buildCriticPrompt(userPrompt: string, code: string, round: number): string {
  return [
    `User request:\n${userPrompt}`,
    `Review round: ${round}`,
    `Candidate code:\n${code}`,
    "Stress-test this code before approving. Walk through each of the six categories from your system prompt (happy path, empty/null, adversarial, error paths, platform assumptions, subtle correctness). For each, name either the concrete failure mode or the specific reason it doesn't apply. Do not approve without that pass."
  ].join("\n\n");
}

async function maybeMaterialize(
  request: SessionRequest,
  files: Array<{ path: string; content: string }> | undefined,
  hooks: SessionHooks
) {
  if (!request.workspaceRoot || !files || files.length === 0) return null;
  const workspace = await resolveWorkspace(request.workspaceRoot).catch(() => null);
  if (!workspace) return null;
  const result = await materializeFiles(workspace, files);
  if (result.written.length === 0 && result.skipped.length === 0) return null;
  const details = { ...result, workspaceRoot: workspace.root };
  hooks.onFilesMaterialized?.(details);
  return details;
}

function buildOperatorReviewPrompt(userPrompt: string, code: string, round: number): string {
  return [
    `User request:\n${userPrompt}`,
    `Review round: ${round}`,
    `Candidate code:\n${code}`,
    "The critic just approved this — do not take that at face value. Re-check the code against the original user request and the six failure categories from your system prompt. Name what you verified; dissent if any category was waved through."
  ].join("\n\n");
}

function buildOperatorPrompt(userPrompt: string, code: string): string {
  return [
    `User request:\n${userPrompt}`,
    `Approved code:\n${code}`,
    "Produce the next repo or terminal actions to integrate or ship this change."
  ].join("\n\n");
}

async function generateStructured<T>(
  provider: SessionRequest["writer"],
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  schema: z.ZodSchema<T>,
  label: "writer" | "critic" | "operator",
  round: number,
  hooks: SessionHooks,
  signal?: AbortSignal
): Promise<T> {
  const chain = [provider.model, ...(provider.fallbacks ?? [])];
  let lastRefusalText: string | null = null;
  let lastRefusalReason: string | null = null;

  for (let idx = 0; idx < chain.length; idx += 1) {
    const currentProvider = { ...provider, model: chain[idx] as string };
    try {
      return await attemptStructured(currentProvider, messages, schema, label, round, hooks, signal);
    } catch (error) {
      if (!(error instanceof RefusalError)) throw error;
      lastRefusalText = error.rawText;
      lastRefusalReason = error.reason;
      const next = chain[idx + 1];
      if (next) {
        hooks.onRefusalFallback?.({
          agent: label,
          round,
          from: chain[idx] as string,
          to: next,
          reason: error.reason
        });
        continue;
      }
      throw new Error(
        `Failed to parse ${label} response after fallback chain (${chain.join(" → ")}): ${
          lastRefusalReason ?? "refusal"
        }. Raw excerpt: ${excerptOf(lastRefusalText)}`
      );
    }
  }

  // Unreachable; the loop either returns or throws. Kept for type-narrowing.
  throw new Error(`Fallback chain exhausted for ${label}`);
}

class RefusalError extends Error {
  readonly code = "refusal";
  constructor(readonly rawText: string, readonly reason: string) {
    super(`Model refused or produced unparseable output: ${reason}`);
    this.name = "RefusalError";
  }
}

async function attemptStructured<T>(
  provider: SessionRequest["writer"],
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  schema: z.ZodSchema<T>,
  label: "writer" | "critic" | "operator",
  round: number,
  hooks: SessionHooks,
  signal?: AbortSignal
): Promise<T> {
  const firstRaw = await generateText(provider, messages, signal);
  const firstAttempt = tryParseJson(firstRaw.text, schema);
  if (firstAttempt.ok) {
    return firstAttempt.value;
  }

  logDebug("session.parse_failure_full", {
    agent: label,
    round,
    attempt: 1,
    length: firstRaw.text.length,
    full: firstRaw.text.slice(0, 4000)
  });
  hooks.onParseFailure?.({
    agent: label,
    round,
    excerpt: firstAttempt.excerpt
  });

  const retryMessages = [
    ...messages,
    { role: "assistant" as const, content: firstRaw.text },
    {
      role: "user" as const,
      content: [
        "Your previous reply was not valid JSON matching the required schema.",
        `Reason: ${firstAttempt.reason}.`,
        "Respond again with strict JSON only, no prose or code fences."
      ].join(" ")
    }
  ];

  const retryRaw = await generateText(provider, retryMessages, signal);
  const retryAttempt = tryParseJson(retryRaw.text, schema);
  if (retryAttempt.ok) {
    return retryAttempt.value;
  }

  logError("session.parse_failure_final", {
    agent: label,
    round,
    length: retryRaw.text.length,
    full: retryRaw.text.slice(0, 4000),
    reason: retryAttempt.reason
  });
  hooks.onParseFailure?.({
    agent: label,
    round,
    excerpt: retryAttempt.excerpt
  });

  if (looksLikeRefusal(firstRaw.text) || looksLikeRefusal(retryRaw.text)) {
    throw new RefusalError(retryRaw.text, retryAttempt.reason);
  }

  throw new Error(
    `Failed to parse ${label} response after retry: ${retryAttempt.reason}. Raw excerpt: ${retryAttempt.excerpt}`
  );
}

const REFUSAL_HEAD_PHRASES = [
  "i can't",
  "i cant",
  "i cannot",
  "i won't",
  "i wont",
  "i will not",
  "i'm sorry",
  "im sorry",
  "i am sorry",
  "i'm afraid",
  "im afraid",
  "i am afraid",
  "i'm unable",
  "im unable",
  "i am unable",
  "i'm not able",
  "im not able",
  "i am not able",
  "sorry, i",
  "sorry i",
  "sorry, but",
  "sorry but",
  "as an ai",
  "as a language model",
  "as an assistant"
];

const REFUSAL_BODY_PATTERNS: RegExp[] = [
  /\brefuse to (?:help|assist|comply|produce|generate)\b/i,
  /\b(?:do|does) not (?:feel comfortable|assist|help|produce|generate)\b/i
];

export function looksLikeRefusal(rawText: string): boolean {
  const normalized = rawText
    .trim()
    .replace(/\u2019/g, "'") // curly apostrophe → straight
    .toLowerCase();
  if (!normalized) return false;
  const head = normalized.slice(0, 500);
  if (REFUSAL_HEAD_PHRASES.some((phrase) => head.startsWith(phrase))) return true;
  return REFUSAL_BODY_PATTERNS.some((pattern) => pattern.test(head));
}

function excerptOf(rawText: string | null): string {
  if (!rawText) return "(no output)";
  return rawText.replace(/\s+/g, " ").slice(0, 300);
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; excerpt: string };

function tryParseJson<T>(rawText: string, schema: z.ZodSchema<T>): ParseResult<T> {
  const trimmed = rawText.trim();
  const excerpt = rawText.replace(/\s+/g, " ").slice(0, 300);

  try {
    const jsonText = extractJsonObject(trimmed);
    const parsed = JSON.parse(jsonText);
    return { ok: true, value: schema.parse(parsed) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown parsing error";
    return { ok: false, reason, excerpt };
  }
}

export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error("Response did not contain a JSON object");
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error("Response did not contain a complete JSON object");
}
