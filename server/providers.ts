import { logDebug } from "./logger.js";
import { ProviderConfig } from "./types.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ProviderResponse = {
  text: string;
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_GENERATE_TIMEOUT_MS = 180_000;
const DEFAULT_NUM_PREDICT = 8192;

export class CancelledError extends Error {
  readonly code = "cancelled";
  constructor() {
    super("Session cancelled");
    this.name = "CancelledError";
  }
}

export async function generateText(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ProviderResponse> {
  if (config.provider !== "ollama") {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }
  return callOllamaHttp(config, messages, signal);
}

function ollamaTimeoutMs(): number {
  const raw = process.env.OLLAMA_TIMEOUT_MS;
  if (!raw) return DEFAULT_GENERATE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GENERATE_TIMEOUT_MS;
}

function numPredict(): number {
  const raw = process.env.OLLAMA_NUM_PREDICT;
  if (!raw) return DEFAULT_NUM_PREDICT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NUM_PREDICT;
}

async function callOllamaHttp(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ProviderResponse> {
  let predictBudget = numPredict();
  // Retry once at 2× budget if the model got cut off by the predict cap (done_reason="length")
  // and produced no visible content — typical for reasoning models that spent the whole budget thinking.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callOllamaHttpOnce(config, messages, predictBudget, signal);
    if (result.text) return { text: result.text };
    if (result.doneReason === "length" && attempt === 0) {
      predictBudget = Math.min(predictBudget * 2, 32_768);
      logDebug("ollama.http.retry_longer", {
        model: config.model,
        nextNumPredict: predictBudget
      });
      continue;
    }
    throw new Error(
      `Ollama returned an empty response for model ${config.model} (done_reason=${result.doneReason || "unknown"})`
    );
  }
  throw new Error(`Ollama returned an empty response for model ${config.model}`);
}

type OllamaChatRaw = { text: string; doneReason: string | null };

async function callOllamaHttpOnce(
  config: ProviderConfig,
  messages: ChatMessage[],
  predictBudget: number,
  signal?: AbortSignal
): Promise<OllamaChatRaw> {
  if (signal?.aborted) throw new CancelledError();

  const baseUrl =
    (config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");

  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      num_predict: predictBudget
    }
  };

  logDebug("ollama.http.start", {
    model: config.model,
    host: baseUrl,
    messageCount: messages.length,
    numPredict: predictBudget
  });

  const timeout = ollamaTimeoutMs();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`timeout-${timeout}`)), timeout);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (signal?.aborted) throw new CancelledError();
    if (error instanceof Error && /timeout-/.test(error.message)) {
      throw new Error(`ollama ${config.model} timed out after ${timeout}ms`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`ollama ${config.model} HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`);
  }

  const payload = (await response.json()) as {
    message?: { content?: string };
    error?: string;
    done_reason?: string;
  };

  if (payload.error) {
    throw new Error(`ollama ${config.model} error: ${payload.error}`);
  }

  const text = (payload.message?.content || "").trim();
  logDebug("ollama.http.complete", {
    model: config.model,
    length: text.length,
    doneReason: payload.done_reason || "unknown"
  });
  return { text, doneReason: payload.done_reason ?? null };
}
