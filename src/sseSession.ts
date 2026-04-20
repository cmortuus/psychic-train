import { SseHandler, streamSse } from "./sseCommon";

export type { SseHandler };

export function streamSession(body: unknown, onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  return streamSse("/api/session/stream", body, onEvent, signal);
}
