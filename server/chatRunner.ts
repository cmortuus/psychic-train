import { z } from "zod";
import { preflightDaemons } from "./ollamaApi.js";
import { CancelledError, generateText } from "./providers.js";
import { runDualAgentSession } from "./runSession.js";
import { ToolCall, executeTool, toolCallSchema } from "./tools.js";
import { ProviderConfig, SessionRequest } from "./types.js";
import { Workspace } from "./workspace.js";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export type ChatMessage =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string; toolCall?: ToolCall }
  | { role: "tool"; content: string; ok: boolean };

export type ChatRequest = {
  messages: ChatMessage[];
  workspaceRoot: string;
  operator: ProviderConfig;
  writer: ProviderConfig;
  critic: ProviderConfig;
};

export type ChatHooks = {
  onAssistantMessage?: (content: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: { ok: boolean; summary: string; detail?: string }) => void;
  onWorkspaceChange?: (workspace: Workspace) => void;
  onDelegateEvent?: (event: string, data: unknown) => void;
};

const CHAT_SYSTEM_PROMPT = [
  "You are the operator in a multi-agent coding system.",
  "You converse with the user and coordinate writer and critic models to complete coding work.",
  "Every reply MUST be strict JSON with a \"type\" field and nothing else — no prose, no code fences, no commentary.",
  "Allowed shapes:",
  '{"type":"message","content":"..."} — plain reply to the user.',
  '{"type":"delegate_coding_task","task":"...","maxRounds":4} — hand a coding task to the writer/critic loop.',
  '{"type":"set_workspace","path":"/abs/path"} — change the active workspace (must already exist).',
  '{"type":"clone_repo","repoUrl":"...","destination":"/abs/path","setAsWorkspace":true} — git clone into an absolute destination.',
  '{"type":"run_git","args":["status"]} — run one git subcommand; allowlist: status, diff, log, show, branch, add, commit, ls-files, rev-parse, remote, fetch, pull, stash.',
  '{"type":"read_file","path":"./rel/or/abs"} — read a text file in the workspace.',
  '{"type":"write_file","path":"./rel","content":"..."} — write a text file in the workspace.',
  '{"type":"list_dir","path":"."} — list directory contents in the workspace.',
  '{"type":"run_shell","command":"npm","args":["test"]} — run an allowlisted shell command (npm/yarn/pnpm/bun/node/tsc/vitest/pytest/python/cargo/go/make/deno) inside the workspace. Requires ALLOW_SHELL_EXEC=true on the server; git is blocked here (use run_git).',
  '{"type":"run_tests"} — auto-detect the project type (package.json / pyproject.toml / Cargo.toml / go.mod / deno.json / Makefile) and run its tests. Returns {passed, failingTests[]?, output}. Also needs ALLOW_SHELL_EXEC=true.',
  "After a tool runs, you will receive its result as a tool message; decide the next JSON action.",
  "Use delegate_coding_task only when the user clearly asks for new code; otherwise explain what you can do or run a tool first.",
  "Finish every exchange with a message action so the user knows the turn is complete."
].join(" ");

const MAX_TOOL_STEPS = 8;

export async function runChatTurn(
  request: ChatRequest,
  hooks: ChatHooks = {},
  signal?: AbortSignal
): Promise<{ messages: ChatMessage[]; workspaceRoot: string }> {
  await preflightDaemons([
    request.operator.baseUrl,
    request.writer.baseUrl,
    request.critic.baseUrl
  ].filter((x): x is string => Boolean(x)));

  let workspace: Workspace = { root: request.workspaceRoot };
  const conversation: ChatMessage[] = [...request.messages];

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    if (signal?.aborted) throw new CancelledError();

    const raw = await generateText(
      request.operator,
      [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "system", content: `Current workspace: ${workspace.root}` },
        ...conversation.map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content: renderMessage(m)
        }))
      ],
      signal
    );

    const call = parseToolCall(raw.text);

    if (call.type === "message") {
      conversation.push({ role: "assistant", content: call.content, toolCall: call });
      hooks.onAssistantMessage?.(call.content);
      return { messages: conversation, workspaceRoot: workspace.root };
    }

    conversation.push({
      role: "assistant",
      content: `(calling tool: ${call.type})`,
      toolCall: call
    });
    hooks.onToolCall?.(call);

    const result = await runToolWithDelegate(call, workspace, request, hooks, signal);
    if (result.workspace) {
      workspace = result.workspace;
      hooks.onWorkspaceChange?.(workspace);
    }
    hooks.onToolResult?.({ ok: result.ok, summary: result.summary, detail: result.detail });

    conversation.push({
      role: "tool",
      content: formatToolResult(call, result.summary, result.detail),
      ok: result.ok
    });
  }

  const abortMsg = "Tool step limit reached. Reply with a plain message next.";
  conversation.push({ role: "system", content: abortMsg });
  hooks.onAssistantMessage?.(abortMsg);
  return { messages: conversation, workspaceRoot: workspace.root };
}

async function runToolWithDelegate(
  call: ToolCall,
  workspace: Workspace,
  request: ChatRequest,
  hooks: ChatHooks,
  signal?: AbortSignal
): Promise<{ ok: boolean; summary: string; detail?: string; workspace?: Workspace }> {
  if (call.type !== "delegate_coding_task") {
    return executeTool(call, workspace);
  }

  const sessionRequest: SessionRequest = {
    prompt: call.task,
    maxRounds: call.maxRounds ?? 4,
    writer: request.writer,
    critic: request.critic
  };

  try {
    const result = await runDualAgentSession(
      sessionRequest,
      {
        onTurn(turn) { hooks.onDelegateEvent?.("turn", turn); },
        onRoundStart(d) { hooks.onDelegateEvent?.("round_start", d); },
        onRoundComplete(d) { hooks.onDelegateEvent?.("round_complete", d); },
        onParseFailure(d) { hooks.onDelegateEvent?.("parse_failure", d); }
      },
      signal
    );
    const summary = `Delegated task ${result.status}. ${result.transcript.length} turns.`;
    return {
      ok: result.status === "approved",
      summary,
      detail:
        result.status === "approved"
          ? `Final code:\n${result.finalCode}`
          : result.finalCode
            ? `Status: ${result.status}\nLatest code:\n${result.finalCode}`
            : `Status: ${result.status}`
    };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, summary: `Delegation failed: ${message}` };
  }
}

function parseToolCall(rawText: string): ToolCall {
  const jsonText = extractJsonObject(rawText.trim());
  const parsed = JSON.parse(jsonText);
  return toolCallSchema.parse(parsed);
}

function renderMessage(message: ChatMessage): string {
  if (message.role === "assistant") {
    return message.toolCall ? JSON.stringify(message.toolCall) : message.content;
  }
  if (message.role === "tool") {
    return `Tool result (${message.ok ? "ok" : "error"}):\n${message.content}`;
  }
  return message.content;
}

function formatToolResult(call: ToolCall, summary: string, detail?: string): string {
  const head = `[${call.type}] ${summary}`;
  return detail ? `${head}\n${detail}` : head;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("Operator reply did not contain JSON.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") { depth += 1; continue; }
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Operator reply JSON was not complete.");
}

export const _testing = { extractJsonObject, parseToolCall: (t: string) => parseToolCall(t) };
export type { ToolCall };
export { z };
