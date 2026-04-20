import { z } from "zod";
import { preflightDaemons } from "./ollamaApi.js";
import { generateText } from "./providers.js";
import { AgentTurn, OperatorAction, SessionHooks, SessionRequest, SessionResult } from "./types.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export const writerResponseSchema = z.object({
  summary: z.string().min(1),
  code: z.string()
});

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
  "Produce implementation output only as strict JSON with keys: summary, code.",
  "The code should be complete enough to satisfy the user's request.",
  "When you receive critic feedback, revise the code directly and incorporate only justified changes."
].join(" ");

const criticSystemPrompt = [
  "You are the critic model in a two-agent coding system.",
  "Review the proposed code for correctness, completeness, edge cases, and internal consistency.",
  "Respond only as strict JSON with keys: summary, verdict, required_changes.",
  "Use verdict=approved only when you are satisfied the code is ready."
].join(" ");

const operatorSystemPrompt = [
  "You are the operator model in a three-agent coding system.",
  "You do not rewrite code. You produce next repo or terminal actions after the review loop finishes.",
  "Respond only as strict JSON with keys: summary, actions.",
  "Each action must include kind, title, detail, and optional command.",
  "Focus on concrete repo steps such as file edits, tests, git commands, or shell commands."
].join(" ");

export async function runDualAgentSession(
  request: SessionRequest,
  hooks: SessionHooks = {}
): Promise<SessionResult> {
  const transcript: AgentTurn[] = [];
  let currentCode = "";
  let currentSummary = "";
  let pendingChanges: string[] = [];
  let operatorPlan: SessionResult["operatorPlan"];

  const baseUrls = [request.writer, request.critic, request.operator]
    .filter((config): config is NonNullable<typeof config> => Boolean(config))
    .map((config) => config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL);
  await preflightDaemons(baseUrls);

  for (let round = 1; round <= request.maxRounds; round += 1) {
    const writerPrompt = buildWriterPrompt(request.prompt, currentCode, currentSummary, pendingChanges);
    hooks.onRoundStart?.({
      agent: "writer",
      round,
      model: request.writer.model
    });
    const writerStartedAt = Date.now();
    const writerData = await generateStructured(
      request.writer,
      [
        { role: "system", content: writerSystemPrompt },
        { role: "user", content: writerPrompt }
      ],
      writerResponseSchema,
      "writer",
      round,
      hooks
    );
    hooks.onRoundComplete?.({
      agent: "writer",
      round,
      model: request.writer.model,
      durationMs: Date.now() - writerStartedAt
    });
    currentCode = writerData.code;
    currentSummary = writerData.summary;

    const writerTurn: AgentTurn = {
      role: "writer",
      round,
      summary: writerData.summary,
      code: writerData.code
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
    const criticData = (await generateStructured(
      request.critic,
      [
        { role: "system", content: criticSystemPrompt },
        { role: "user", content: criticPrompt }
      ],
      criticResponseSchema,
      "critic",
      round,
      hooks
    )) as CriticResponse;
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
      operatorPlan = request.operator
        ? await runOperatorStage(request, currentCode, round, hooks, transcript)
        : undefined;
      const systemTurn: AgentTurn = {
        role: "system",
        round,
        summary: "Both agents reached approval."
      };
      transcript.push(systemTurn);
      hooks.onTurn?.(systemTurn);
      return {
        transcript,
        finalCode: currentCode,
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
    status: "max_rounds",
    ...(operatorPlan ? { operatorPlan } : {})
  };
}

async function runOperatorStage(
  request: SessionRequest,
  finalCode: string,
  round: number,
  hooks: SessionHooks,
  transcript: AgentTurn[]
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
    hooks
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
    `Candidate code:\n${code}`
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
  hooks: SessionHooks
): Promise<T> {
  const firstRaw = await generateText(provider, messages);
  const firstAttempt = tryParseJson(firstRaw.text, schema);
  if (firstAttempt.ok) {
    return firstAttempt.value;
  }

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

  const retryRaw = await generateText(provider, retryMessages);
  const retryAttempt = tryParseJson(retryRaw.text, schema);
  if (retryAttempt.ok) {
    return retryAttempt.value;
  }

  hooks.onParseFailure?.({
    agent: label,
    round,
    excerpt: retryAttempt.excerpt
  });
  throw new Error(
    `Failed to parse ${label} response after retry: ${retryAttempt.reason}. Raw excerpt: ${retryAttempt.excerpt}`
  );
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
