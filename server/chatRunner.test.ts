import { describe, expect, it } from "vitest";
import { _testing } from "./chatRunner.js";

describe("chatRunner.parseToolCall", () => {
  it("accepts a well-formed message tool call", () => {
    const call = _testing.parseToolCall('{"type":"message","content":"hi"}');
    expect(call.type).toBe("message");
    if (call.type === "message") expect(call.content).toBe("hi");
  });

  it("recovers a tool call truncated mid-string via jsonrepair", () => {
    // Truncated before the closing quote+brace. jsonrepair should close it.
    const raw = '{"type":"message","content":"hello there';
    const call = _testing.parseToolCall(raw);
    expect(call.type).toBe("message");
  });

  it("strips surrounding prose and recovers the JSON body", () => {
    const raw = 'Sure — here goes:\n\n{"type":"list_dir","path":"."}\n\nLet me know.';
    const call = _testing.parseToolCall(raw);
    expect(call.type).toBe("list_dir");
  });

  it("throws a descriptive error when no JSON is present", () => {
    expect(() => _testing.parseToolCall("no json here")).toThrow(/could not be parsed/i);
  });
});
