import { SseHandler, streamSse } from "./sseCommon";

export type ChatSseHandler = SseHandler;

export function streamChat(body: unknown, onEvent: ChatSseHandler, signal?: AbortSignal): Promise<void> {
  return streamSse("/api/chat/stream", body, onEvent, signal);
}
