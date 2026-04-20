import { describe, expect, it, vi } from "vitest";
import {
  criticResponseSchema,
  extractJsonObject,
  operatorResponseSchema,
  writerResponseSchema
} from "./runSession.js";

describe("extractJsonObject", () => {
  it("returns the whole string when it is a plain JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("trims prose before and after the object", () => {
    expect(extractJsonObject('Here you go: {"a":1}\nThanks!')).toBe('{"a":1}');
  });

  it("handles code fences and markdown wrappers", () => {
    const text = '```json\n{"a":1,"b":2}\n```';
    expect(extractJsonObject(text)).toBe('{"a":1,"b":2}');
  });

  it("respects nested braces", () => {
    const text = '{"outer":{"inner":{"x":1}},"y":2} tail';
    expect(extractJsonObject(text)).toBe('{"outer":{"inner":{"x":1}},"y":2}');
  });

  it("ignores braces inside strings", () => {
    const text = '{"s":"a }{ b","n":1}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"s":"he said \\"hi\\" and left"}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("throws when no opening brace is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/did not contain a JSON object/);
  });

  it("throws when braces never balance", () => {
    expect(() => extractJsonObject('{"a":1')).toThrow(/complete JSON object/);
  });
});

describe("writerResponseSchema", () => {
  it("accepts empty code", () => {
    const parsed = writerResponseSchema.parse({ summary: "ok", code: "" });
    expect(parsed.code).toBe("");
  });

  it("rejects empty summary", () => {
    expect(() => writerResponseSchema.parse({ summary: "", code: "x" })).toThrow();
  });
});

describe("criticResponseSchema.verdict", () => {
  it("normalizes rejected -> revise", () => {
    const parsed = criticResponseSchema.parse({
      summary: "needs work",
      verdict: "rejected",
      required_changes: ["fix"]
    });
    expect(parsed.verdict).toBe("revise");
  });

  it("normalizes needs_revision -> revise", () => {
    const parsed = criticResponseSchema.parse({
      summary: "ok",
      verdict: "needs_revision"
    });
    expect(parsed.verdict).toBe("revise");
  });

  it("normalizes changes-requested -> revise", () => {
    const parsed = criticResponseSchema.parse({
      summary: "ok",
      verdict: "changes-requested"
    });
    expect(parsed.verdict).toBe("revise");
  });

  it("passes APPROVED through (case insensitive)", () => {
    const parsed = criticResponseSchema.parse({ summary: "ok", verdict: "APPROVED" });
    expect(parsed.verdict).toBe("approved");
  });

  it("defaults required_changes to []", () => {
    const parsed = criticResponseSchema.parse({ summary: "ok", verdict: "approved" });
    expect(parsed.required_changes).toEqual([]);
  });

  it("rejects unknown verdicts", () => {
    expect(() =>
      criticResponseSchema.parse({ summary: "ok", verdict: "looks good" })
    ).toThrow();
  });
});

describe("operatorResponseSchema.kind", () => {
  it("normalizes terminal/run/command -> shell", () => {
    for (const kind of ["terminal", "run", "command"]) {
      const parsed = operatorResponseSchema.parse({
        summary: "go",
        actions: [{ kind, title: "t", detail: "d" }]
      });
      expect(parsed.actions[0]?.kind).toBe("shell");
    }
  });

  it("normalizes repo/repository -> git", () => {
    for (const kind of ["repo", "repository"]) {
      const parsed = operatorResponseSchema.parse({
        summary: "go",
        actions: [{ kind, title: "t", detail: "d" }]
      });
      expect(parsed.actions[0]?.kind).toBe("git");
    }
  });

  it("normalizes file-system/filesystem -> file", () => {
    const parsed = operatorResponseSchema.parse({
      summary: "go",
      actions: [{ kind: "filesystem", title: "t", detail: "d" }]
    });
    expect(parsed.actions[0]?.kind).toBe("file");
  });
});

vi.mock("./providers.js", () => ({
  generateText: vi.fn()
}));

vi.mock("./ollamaApi.js", () => ({
  preflightDaemons: vi.fn().mockResolvedValue(undefined),
  DaemonUnreachableError: class extends Error {}
}));

describe("runDualAgentSession", () => {
  it("returns approved once the critic approves", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;

    generate
      .mockResolvedValueOnce({ text: '{"summary":"first pass","code":"console.log(1)"}' })
      .mockResolvedValueOnce({ text: '{"summary":"LGTM","verdict":"approved"}' });

    const result = await runDualAgentSession({
      prompt: "do a thing",
      maxRounds: 3,
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" }
    });

    expect(result.status).toBe("approved");
    expect(result.finalCode).toBe("console.log(1)");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("stops at max_rounds when the critic never approves", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    generate.mockImplementation(
      (_provider: unknown, messages: Array<{ role: string; content: string }>) => {
        const system = messages[0];
        if (system?.role === "system" && system.content.startsWith("You are the writing")) {
          return Promise.resolve({ text: '{"summary":"draft","code":"x"}' });
        }
        return Promise.resolve({
          text: '{"summary":"not yet","verdict":"revise","required_changes":["try harder"]}'
        });
      }
    );

    const result = await runDualAgentSession({
      prompt: "do a thing",
      maxRounds: 2,
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" }
    });

    expect(result.status).toBe("max_rounds");
    expect(generate).toHaveBeenCalledTimes(4);
  });
});
