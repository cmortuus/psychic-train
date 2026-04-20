import { ServerResponse } from "node:http";

const DEFAULT_INTERVAL_MS = 15_000;

export function startSseHeartbeat(res: ServerResponse, intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    try {
      // SSE comment frames — clients ignore them but they keep the connection warm
      // and make reader.read() return regularly so a silent server-side hang surfaces
      // quickly on the client.
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      // best-effort
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
