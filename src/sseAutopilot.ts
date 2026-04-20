import { SseHandler, streamSse } from "./sseCommon";

export type AutopilotSseHandler = SseHandler;

export function streamAutopilot(body: unknown, onEvent: AutopilotSseHandler, signal?: AbortSignal): Promise<void> {
  return streamSse("/api/autopilot/stream", body, onEvent, signal);
}
