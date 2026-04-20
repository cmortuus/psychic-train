import { spawn } from "node:child_process";
import { logDebug } from "./logger.js";
import { ProviderConfig } from "./types.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ProviderResponse = {
  text: string;
};

export async function generateText(
  config: ProviderConfig,
  messages: ChatMessage[]
): Promise<ProviderResponse> {
  return callOllama(config, messages);
}

async function callOllama(
  config: ProviderConfig,
  messages: ChatMessage[]
): Promise<ProviderResponse> {
  const prompt = buildOllamaPrompt(messages);
  const env = {
    ...process.env,
    ...(config.baseUrl ? { OLLAMA_HOST: config.baseUrl } : {}),
    ...(config.apiKey ? { OLLAMA_API_KEY: config.apiKey } : {})
  };

  logDebug("ollama.command.start", {
    model: config.model,
    host: config.baseUrl || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    promptPreview: prompt.replace(/\s+/g, " ").slice(0, 200),
    apiKey: env.OLLAMA_API_KEY || ""
  });

  const result = await runOllamaCommand(config.model, prompt, env);
  const text = result.trim();
  if (!text) {
    throw new Error(`Ollama returned an empty response for model ${config.model}`);
  }

  logDebug("ollama.command.complete", {
    model: config.model,
    outputPreview: text.replace(/\s+/g, " ").slice(0, 200)
  });

  return { text };
}

function buildOllamaPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      return `${role}:\n${message.content.trim()}`;
    })
    .join("\n\n");
}

const DEFAULT_OLLAMA_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 3_000;

function ollamaTimeoutMs(): number {
  const raw = process.env.OLLAMA_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_OLLAMA_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OLLAMA_TIMEOUT_MS;
}

function runOllamaCommand(
  model: string,
  prompt: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const timeoutMs = ollamaTimeoutMs();

  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["run", model, "--format", "json", "--hidethinking", "--think=false", "--nowordwrap"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if ("code" in error && error.code === "ENOENT") {
        reject(new Error("`ollama` is not installed or not available on PATH"));
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ollama run ${model} timed out after ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`ollama run ${model} failed: ${detail}`));
        return;
      }

      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
