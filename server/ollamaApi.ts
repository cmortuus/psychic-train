const DEFAULT_PREFLIGHT_TIMEOUT_MS = 3_000;

export class DaemonUnreachableError extends Error {
  readonly code = "daemon_unreachable";
  constructor(readonly baseUrl: string, cause?: unknown) {
    super(`Ollama daemon not reachable at ${baseUrl}. Is \`ollama serve\` running?`);
    this.name = "DaemonUnreachableError";
    if (cause && cause instanceof Error) {
      this.stack += `\nCaused by: ${cause.message}`;
    }
  }
}

type OllamaTag = {
  name: string;
  modified_at?: string;
  size?: number;
};

export async function fetchOllamaTags(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PREFLIGHT_TIMEOUT_MS
): Promise<OllamaTag[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new DaemonUnreachableError(baseUrl, new Error(`HTTP ${response.status}`));
    }
    const data = (await response.json()) as { models?: OllamaTag[] };
    return data.models || [];
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      throw error;
    }
    throw new DaemonUnreachableError(baseUrl, error);
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightDaemons(baseUrls: string[]): Promise<void> {
  const unique = Array.from(new Set(baseUrls));
  await Promise.all(unique.map((url) => fetchOllamaTags(url)));
}
