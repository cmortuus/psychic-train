import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { AutopilotRequest, ShellDisabledError, runAutopilot } from "./autopilot.js";
import { browseDirectory } from "./browse.js";
import { executeTool, toolCallSchema } from "./tools.js";
import { dismissWatchdogItem, startWatchdog, watchdogReport } from "./watchdog.js";
import { resolveWorkspace } from "./workspace.js";
import { ChatMessage, ChatRequest, runChatTurn } from "./chatRunner.js";
import { mergedCatalog } from "./cloudCatalog.js";
import { logError, logInfo } from "./logger.js";
import { DaemonUnreachableError, fetchOllamaTags } from "./ollamaApi.js";
import { CancelledError } from "./providers.js";
import { runDualAgentSession } from "./runSession.js";
import { serveStatic } from "./static.js";
import { ProviderConfig, SessionRequest } from "./types.js";

const port = Number(process.env.PORT || 8787);
const staticRoot = resolve(process.cwd(), process.env.STATIC_ROOT || "dist");

startWatchdog();

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    logInfo("http.request", {
      method: req.method,
      path: req.url || "",
      status: 204,
      durationMs: Date.now() - startedAt
    });
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.url) {
    logError("http.request.invalid", {
      method: req.method || "",
      reason: "missing_url"
    });
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    logInfo("http.request", {
      method: req.method,
      path: req.url,
      status: 200,
      durationMs: Date.now() - startedAt
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/api/watchdog/report") {
    const items = watchdogReport();
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === "POST" && req.url === "/api/watchdog/dismiss") {
    try {
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.id !== "string" || !body.id) {
        throw new Error("Invalid request: id is required");
      }
      const removed = dismissWatchdogItem(body.id);
      sendJson(res, 200, { ok: true, removed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 500;
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/tool/run") {
    try {
      const body = await readJsonBody(req);
      if (!isRecord(body)) {
        throw new Error("Invalid request: expected an object body");
      }
      const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
      if (!workspaceRoot) {
        throw new Error("Invalid request: workspaceRoot is required");
      }
      const toolCall = toolCallSchema.safeParse(body.toolCall);
      if (!toolCall.success) {
        throw new Error(`Invalid request: toolCall — ${toolCall.error.issues[0]?.message || "malformed"}`);
      }
      const workspace = await resolveWorkspace(workspaceRoot);
      const result = await executeTool(toolCall.data, workspace);
      logInfo("tool.run", {
        type: toolCall.data.type,
        ok: result.ok,
        workspace: workspaceRoot
      });
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 500;
      logError("tool.error", { status, message });
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/catalog") {
    try {
      const catalog = await mergedCatalog();
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, 200, { catalog });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("catalog.error", { message });
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (req.method === "GET" && req.url && req.url.startsWith("/api/browse")) {
    try {
      const path = new URL(req.url, "http://x").searchParams.get("path");
      const result = await browseDirectory(path);
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("browse.error", { message });
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "GET" && req.url && req.url.startsWith("/api/models")) {
    const baseUrl =
      new URL(req.url, "http://x").searchParams.get("baseUrl") ||
      process.env.OLLAMA_BASE_URL ||
      "http://127.0.0.1:11434";
    try {
      const tags = await fetchOllamaTags(baseUrl);
      const models = tags.map((tag) => tag.name).sort();
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, 200, { models, baseUrl });
    } catch (error) {
      const status = error instanceof DaemonUnreachableError ? 502 : 500;
      const message = error instanceof Error ? error.message : "Unknown error";
      const code = error instanceof DaemonUnreachableError ? error.code : undefined;
      logError("models.error", { status, message, baseUrl });
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, status, { error: message, ...(code ? { code } : {}) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/session/stream") {
    try {
      const body = await readJsonBody(req);
      const parsed = parseSessionRequest(body);
      logInfo("session.start", {
        promptLength: parsed.prompt.length,
        maxRounds: parsed.maxRounds,
        writerModel: parsed.writer.model,
        criticModel: parsed.critic.model,
        streaming: true
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.writeHead(200);

      const abortController = new AbortController();
      const onClientClose = () => abortController.abort();
      req.on("close", onClientClose);

      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      try {
        const result = await runDualAgentSession(
          parsed,
          {
            onTurn(turn) { send("turn", turn); },
            onRoundStart(details) {
              logInfo("session.round.start", details);
              send("round_start", details);
            },
            onRoundComplete(details) {
              logInfo("session.round.complete", details);
              send("round_complete", details);
            },
            onParseFailure(details) {
              logError("session.parse_failure", details);
              send("parse_failure", details);
            },
            onRefusalFallback(details) {
              logInfo("session.refusal_fallback", details);
              send("refusal_fallback", details);
            },
            onFilesMaterialized(details) {
              logInfo("session.files_materialized", {
                writtenCount: details.written.length,
                skippedCount: details.skipped.length,
                workspaceRoot: details.workspaceRoot
              });
              send("files_materialized", details);
            }
          },
          abortController.signal
        );
        logInfo("session.complete", {
          status: result.status,
          transcriptTurns: result.transcript.length,
          finalCodeLength: result.finalCode.length
        });
        send("done", result);
      } catch (error) {
        if (error instanceof CancelledError) {
          logInfo("session.cancelled", {});
          send("cancelled", { message: error.message });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          const code = error instanceof DaemonUnreachableError ? error.code : undefined;
          logError("session.error", { message, ...(code ? { code } : {}) });
          send("error", { message, ...(code ? { code } : {}) });
        }
      } finally {
        req.off("close", onClientClose);
        res.end();
        logInfo("http.request", {
          method: req.method,
          path: req.url,
          status: 200,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 500;
      logError("session.error", { status, message });
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/session") {
    try {
      const body = await readJsonBody(req);
      const parsed = parseSessionRequest(body);
      logInfo("session.start", {
        promptLength: parsed.prompt.length,
        maxRounds: parsed.maxRounds,
        writerModel: parsed.writer.model,
        criticModel: parsed.critic.model
      });
      const result = await runDualAgentSession(parsed, {
        onRoundStart(details) {
          logInfo("session.round.start", details);
        },
        onRoundComplete(details) {
          logInfo("session.round.complete", details);
        },
        onParseFailure(details) {
          logError("session.parse_failure", details);
        }
      });
      logInfo("session.complete", {
        status: result.status,
        transcriptTurns: result.transcript.length,
        finalCodeLength: result.finalCode.length
      });
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      let status = 500;
      let code: string | undefined;
      if (message.startsWith("Invalid request")) {
        status = 400;
      } else if (error instanceof DaemonUnreachableError) {
        status = 502;
        code = error.code;
      }
      logError("session.error", {
        status,
        message,
        ...(code ? { code } : {})
      });
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status,
        durationMs: Date.now() - startedAt
      });
      sendJson(res, status, { error: message, ...(code ? { code } : {}) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/autopilot/stream") {
    try {
      const body = await readJsonBody(req);
      const parsed = parseAutopilotRequest(body);
      logInfo("autopilot.start", {
        promptLength: parsed.prompt.length,
        workspaceRoot: parsed.workspaceRoot,
        maxIterations: parsed.maxIterations
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.writeHead(200);

      const abortController = new AbortController();
      const onClientClose = () => abortController.abort();
      req.on("close", onClientClose);

      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      try {
        const result = await runAutopilot(
          parsed,
          {
            onIterationStart(iteration, taskPrompt) { send("iteration_start", { iteration, taskPrompt }); },
            onIterationComplete(iteration) { send("iteration_complete", { iteration }); },
            onSessionTurn(turn) { send("session_turn", turn); },
            onTestResult(result) { send("test_result", result); },
            onCommit(details) { send("commit", details); },
            onNote(message) { send("note", { message }); }
          },
          abortController.signal
        );
        logInfo("autopilot.complete", {
          status: result.status,
          iterations: result.iterations,
          committed: Boolean(result.committed)
        });
        send("done", result);
      } catch (error) {
        if (error instanceof CancelledError) {
          send("cancelled", { message: error.message });
        } else if (error instanceof ShellDisabledError) {
          send("error", { message: error.message, code: error.code });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          const code = error instanceof DaemonUnreachableError ? error.code : undefined;
          logError("autopilot.error", { message, ...(code ? { code } : {}) });
          send("error", { message, ...(code ? { code } : {}) });
        }
      } finally {
        req.off("close", onClientClose);
        res.end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 500;
      logError("autopilot.error", { status, message });
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat/stream") {
    try {
      const body = await readJsonBody(req);
      const parsed = parseChatRequest(body);
      logInfo("chat.start", {
        turnMessages: parsed.messages.length,
        workspace: parsed.workspaceRoot,
        operatorModel: parsed.operator.model
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.writeHead(200);

      const abortController = new AbortController();
      const onClientClose = () => abortController.abort();
      req.on("close", onClientClose);

      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      try {
        const result = await runChatTurn(
          parsed,
          {
            onAssistantMessage(content) { send("assistant_message", { content }); },
            onToolCall(call) { send("tool_call", call); },
            onToolResult(r) { send("tool_result", r); },
            onWorkspaceChange(ws) { send("workspace_changed", { root: ws.root }); },
            onDelegateEvent(event, data) { send(`delegate_${event}`, data); }
          },
          abortController.signal
        );
        send("done", { messages: result.messages, workspaceRoot: result.workspaceRoot });
      } catch (error) {
        if (error instanceof CancelledError) {
          send("cancelled", { message: error.message });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          const code = error instanceof DaemonUnreachableError ? error.code : undefined;
          logError("chat.error", { message, ...(code ? { code } : {}) });
          send("error", { message, ...(code ? { code } : {}) });
        }
      } finally {
        req.off("close", onClientClose);
        res.end();
        logInfo("http.request", {
          method: req.method,
          path: req.url,
          status: 200,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 500;
      logError("chat.error", { status, message });
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "GET" && !req.url.startsWith("/api/")) {
    res.removeHeader("Content-Type");
    const outcome = await serveStatic(req.url, staticRoot, res);
    if (outcome === "served") {
      logInfo("http.request", {
        method: req.method,
        path: req.url,
        status: 200,
        durationMs: Date.now() - startedAt
      });
      return;
    }
    res.setHeader("Content-Type", "application/json");
  }

  logInfo("http.request", {
    method: req.method || "",
    path: req.url,
    status: 404,
    durationMs: Date.now() - startedAt
  });
  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  logInfo("server.start", {
    port,
    logLevel: process.env.LOG_LEVEL || "info"
  });
});

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    throw new Error("Invalid request: empty body");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid request: body must be valid JSON");
  }
}

function parseSessionRequest(value: unknown): SessionRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid request: expected an object body");
  }

  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const maxRounds = typeof value.maxRounds === "number" ? value.maxRounds : 4;

  if (!prompt) {
    throw new Error("Invalid request: prompt is required");
  }

  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    throw new Error("Invalid request: maxRounds must be an integer >= 0 (0 = unlimited)");
  }

  return {
    prompt,
    maxRounds,
    ...(Number.isInteger(value.minRounds) && (value.minRounds as number) >= 1
      ? { minRounds: value.minRounds as number }
      : {}),
    ...(typeof value.anonymize === "boolean" ? { anonymize: value.anonymize } : {}),
    ...(typeof value.usOnly === "boolean" ? { usOnly: value.usOnly } : {}),
    ...(value.mode === "consensus" || value.mode === "writer_critic" ? { mode: value.mode } : {}),
    ...(typeof value.workspaceRoot === "string" && value.workspaceRoot.trim()
      ? { workspaceRoot: value.workspaceRoot.trim() }
      : {}),
    writer: parseProvider(value.writer, "writer"),
    critic: parseProvider(value.critic, "critic"),
    ...(value.operator ? { operator: parseProvider(value.operator, "operator") } : {})
  };
}

function parseProvider(value: unknown, label: string): ProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid request: ${label} must be an object`);
  }

  const provider = value.provider;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : undefined;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey : undefined;

  if (provider !== "ollama") {
    throw new Error(`Invalid request: ${label}.provider must be "ollama"`);
  }

  if (!model) {
    throw new Error(`Invalid request: ${label}.model is required`);
  }

  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      throw new Error(`Invalid request: ${label}.baseUrl must be a valid URL`);
    }
  }

  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAutopilotRequest(value: unknown): AutopilotRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid request: expected an object body");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) {
    throw new Error("Invalid request: prompt is required");
  }
  const workspaceRoot = typeof value.workspaceRoot === "string" ? value.workspaceRoot.trim() : "";
  if (!workspaceRoot) {
    throw new Error("Invalid request: workspaceRoot is required");
  }
  const req: AutopilotRequest = {
    prompt,
    workspaceRoot,
    writer: parseProvider(value.writer, "writer"),
    critic: parseProvider(value.critic, "critic"),
    ...(value.operator ? { operator: parseProvider(value.operator, "operator") } : {}),
    ...(Number.isInteger(value.maxIterations) && (value.maxIterations as number) >= 1
      ? { maxIterations: value.maxIterations as number }
      : {}),
    ...(Number.isInteger(value.minRounds) && (value.minRounds as number) >= 1
      ? { minRounds: value.minRounds as number }
      : {}),
    ...(Number.isInteger(value.maxRounds) && (value.maxRounds as number) >= 0
      ? { maxRounds: value.maxRounds as number }
      : {}),
    ...(typeof value.anonymize === "boolean" ? { anonymize: value.anonymize } : {}),
    ...(typeof value.usOnly === "boolean" ? { usOnly: value.usOnly } : {}),
    ...(value.mode === "consensus" || value.mode === "writer_critic" ? { mode: value.mode } : {})
  };
  return req;
}

function parseChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid request: expected an object body");
  }
  const messagesRaw = value.messages;
  if (!Array.isArray(messagesRaw)) {
    throw new Error("Invalid request: messages must be an array");
  }
  const messages: ChatMessage[] = messagesRaw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid request: messages[${index}] must be an object`);
    }
    const role = entry.role;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (role === "user" || role === "system") return { role, content };
    if (role === "assistant") return { role: "assistant", content };
    if (role === "tool") return { role: "tool", content, ok: Boolean(entry.ok) };
    throw new Error(`Invalid request: messages[${index}].role is unknown`);
  });
  const workspaceRoot = typeof value.workspaceRoot === "string" && value.workspaceRoot.trim()
    ? value.workspaceRoot.trim()
    : process.cwd();
  return {
    messages,
    workspaceRoot,
    operator: parseProvider(value.operator, "operator"),
    writer: parseProvider(value.writer, "writer"),
    critic: parseProvider(value.critic, "critic")
  };
}
