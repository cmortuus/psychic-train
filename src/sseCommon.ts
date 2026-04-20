export type SseHandler = (event: string, data: unknown) => void;

export type StreamSseOptions = {
  /**
   * Number of times to transparently re-open the stream after an idle-timeout
   * or network error before surfacing the failure. Default 0 — most of our
   * streams are stateful (session, chat, autopilot) and retrying would
   * duplicate model work. Callers that know their stream is idempotent can
   * opt in.
   */
  retryOnIdle?: number;
};

const IDLE_TIMEOUT_MS = 45_000;

/**
 * Report a client-side stream failure to the server-side watchdog so the user
 * sees it in the Watchdog panel (auto-dismissable, deduped) instead of only as
 * a blocking toast. Fire-and-forget — never throws, never blocks the caller.
 */
function reportToWatchdog(payload: {
  event: string;
  message: string;
  code?: string;
  url?: string;
}): void {
  try {
    void fetch("/api/watchdog/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    // If fetch itself is unavailable or throws synchronously, swallow —
    // the user already has the toast; we're just trying to enrich the
    // watchdog panel.
  }
}

export async function streamSse(
  url: string,
  body: unknown,
  onEvent: SseHandler,
  signal?: AbortSignal,
  options: StreamSseOptions = {}
): Promise<void> {
  const maxRetries = Math.max(0, options.retryOnIdle ?? 0);
  let attempt = 0;
  while (true) {
    try {
      await runStreamOnce(url, body, onEvent, signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const isIdle = message.includes("went silent");
      if (isIdle && attempt < maxRetries) {
        attempt += 1;
        reportToWatchdog({
          event: "sse.idle_timeout.retry",
          message: `${url}: idle-timeout, retrying (${attempt}/${maxRetries})`,
          url
        });
        // Gentle backoff: 500ms, 1s, 2s, capped.
        const delay = Math.min(2000, 500 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      reportToWatchdog({
        event: isIdle ? "sse.idle_timeout" : "sse.error",
        message: `${url}: ${message}`,
        url
      });
      throw error;
    }
  }
}

async function runStreamOnce(
  url: string,
  body: unknown,
  onEvent: SseHandler,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    let errorMessage = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) errorMessage = payload.error;
    } catch {
      // fall through
    }
    throw new Error(errorMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Idle-timeout: if no bytes arrive from the server for IDLE_TIMEOUT_MS we
  // treat the connection as dead (server crashed, tsx watch restarted, a
  // proxy dropped the connection, ...) and surface a loud error so the UI
  // unsticks instead of spinning forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleExpired = false;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleExpired = true;
      reader.cancel().catch(() => undefined);
    }, IDLE_TIMEOUT_MS);
  };
  resetIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) onEvent(parsed.event, parsed.data);
      }
    }
    if (idleExpired) {
      throw new Error(
        "Stream went silent for more than 45s. The server is either stuck, restarted, or unreachable."
      );
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      reader.releaseLock();
    } catch {
      // reader may already be cancelled
    }
  }
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment / heartbeat
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}
