import { describe, expect, it, vi } from "vitest";
import {
  criticResponseSchema,
  extractJsonObject,
  looksLikeRefusal,
  operatorResponseSchema,
  repairControlCharsInJsonStrings,
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
  it("accepts empty code when files[] has at least one entry", () => {
    const parsed = writerResponseSchema.parse({
      summary: "ok",
      code: "",
      files: [{ path: "a.txt", content: "" }]
    });
    expect(parsed.files?.length).toBe(1);
  });

  it("rejects a response with neither code nor files", () => {
    expect(() => writerResponseSchema.parse({ summary: "ok" })).toThrow(/at least one/);
  });

  it("rejects empty summary", () => {
    expect(() => writerResponseSchema.parse({ summary: "", code: "x" })).toThrow();
  });

  it("accepts optional files[] alongside code", () => {
    const parsed = writerResponseSchema.parse({
      summary: "multi",
      code: "entry",
      files: [
        { path: "src/a.ts", content: "a" },
        { path: "src/b.ts", content: "b" }
      ]
    });
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files?.[0]).toEqual({ path: "src/a.ts", content: "a" });
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

describe("writerResponseSchema parse robustness", () => {
  it("recovers from raw newlines inside the content field via repair pass", async () => {
    // Simulate what gpt-oss does on multi-file writer output: emits literal LFs
    // inside string values instead of \\n escape sequences.
    const broken = [
      '{"summary":"ok","files":[{"path":"index.js","content":"const greet = ',
      '() => {\n  console.log(\'hi\');\n}\nexport default greet;"}]}'
    ].join("");
    // Direct JSON.parse should fail on this.
    expect(() => JSON.parse(broken)).toThrow();
    const repaired = repairControlCharsInJsonStrings(broken);
    const parsed = writerResponseSchema.parse(JSON.parse(repaired));
    expect(parsed.files?.[0]?.path).toBe("index.js");
    expect(parsed.files?.[0]?.content).toContain("console.log");
  });
});

describe("repairControlCharsInJsonStrings", () => {
  it("escapes raw newlines inside a string literal", () => {
    const input = '{"content":"line1\nline2"}';
    const repaired = repairControlCharsInJsonStrings(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).content).toBe("line1\nline2");
  });

  it("escapes tabs and carriage returns", () => {
    const input = '{"c":"a\tb\rc"}';
    const repaired = repairControlCharsInJsonStrings(input);
    const parsed = JSON.parse(repaired);
    expect(parsed.c).toBe("a\tb\rc");
  });

  it("leaves already-escaped sequences alone", () => {
    const input = '{"c":"line1\\nline2"}';
    expect(repairControlCharsInJsonStrings(input)).toBe(input);
  });

  it("does not touch whitespace outside string literals", () => {
    const input = '{\n  "a": 1,\n  "b": "x"\n}';
    const repaired = repairControlCharsInJsonStrings(input);
    // Newlines between tokens must survive as-is so JSON.parse can read them.
    expect(repaired).toContain("\n  ");
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: "x" });
  });

  it("handles escaped backslashes correctly at string ends", () => {
    const input = '{"path":"C:\\\\Users\\\\alice","next":"ok"}';
    expect(repairControlCharsInJsonStrings(input)).toBe(input);
    expect(JSON.parse(input).path).toBe("C:\\Users\\alice");
  });
});

describe("looksLikeRefusal", () => {
  it("catches common refusal openings", () => {
    expect(looksLikeRefusal("I can't help with that.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, but I cannot comply.")).toBe(true);
    expect(looksLikeRefusal("As an AI language model, I must decline.")).toBe(true);
    expect(looksLikeRefusal("I refuse to produce this content.")).toBe(true);
  });

  it("passes through normal output", () => {
    expect(looksLikeRefusal('{"summary":"ok","code":"x"}')).toBe(false);
    expect(looksLikeRefusal("Here is the implementation:")).toBe(false);
  });

  it("ignores leading whitespace", () => {
    expect(looksLikeRefusal("  \n  I'm unable to answer.")).toBe(true);
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
  it("falls back to the next model when the primary refuses", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    const fallbackEvents: Array<{ from: string; to: string }> = [];
    let writerCalls = 0;
    generate.mockImplementation(
      (provider: { model: string }, messages: Array<{ role: string; content: string }>) => {
        const systemContent = messages.find((m) => m.role === "system")?.content || "";
        if (systemContent.startsWith("You are the writing")) {
          writerCalls += 1;
          // Primary writer refuses on both attempts (first + retry).
          // Fallback writer returns valid JSON on its first attempt.
          if (provider.model === "primary-writer") {
            return Promise.resolve({ text: "I can't help with that request." });
          }
          return Promise.resolve({ text: '{"summary":"ok","code":"done"}' });
        }
        if (systemContent.includes("harsh, adversarial code reviewer")) {
          return Promise.resolve({ text: '{"summary":"lgtm","verdict":"approved"}' });
        }
        return Promise.resolve({ text: '{}' });
      }
    );

    const result = await runDualAgentSession(
      {
        prompt: "build x",
        maxRounds: 1,
        writer: { provider: "ollama", model: "primary-writer", fallbacks: ["fallback-writer"] },
        critic: { provider: "ollama", model: "critic" }
      },
      {
        onRefusalFallback(details) {
          fallbackEvents.push({ from: details.from, to: details.to });
        }
      }
    );

    expect(result.status).toBe("approved");
    expect(result.finalCode).toBe("done");
    expect(fallbackEvents).toEqual([{ from: "primary-writer", to: "fallback-writer" }]);
    // Primary was called twice (first + retry), fallback once.
    expect(writerCalls).toBe(3);
  });

  it("returns approved once the critic approves", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

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

  it("consensus mode: operator gate blocks approval then allows it", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    generate.mockImplementation(
      (_provider: unknown, messages: Array<{ role: string; content: string }>) => {
        const systemContent = messages.find((m) => m.role === "system")?.content || "";
        if (systemContent.startsWith("You are the writing")) {
          return Promise.resolve({ text: '{"summary":"draft","code":"const x = 1;"}' });
        }
        if (systemContent.includes("harsh, adversarial code reviewer")) {
          return Promise.resolve({ text: '{"summary":"lgtm","verdict":"approved"}' });
        }
        if (systemContent.includes("operator acting as a harsh second reviewer")) {
          const calls = generate.mock.calls.filter((c: unknown[]) => {
            const msgs = c[1] as Array<{ role: string; content: string }>;
            const sys = msgs.find((m) => m.role === "system")?.content || "";
            return sys.includes("operator acting as a harsh second reviewer");
          }).length;
          return Promise.resolve({
            text:
              calls <= 1
                ? '{"summary":"needs caching","verdict":"revise","required_changes":["add cache"]}'
                : '{"summary":"ok","verdict":"approved"}'
          });
        }
        if (systemContent.startsWith("You are the operator model")) {
          return Promise.resolve({ text: '{"summary":"shipping plan","actions":[]}' });
        }
        return Promise.resolve({ text: '{}' });
      }
    );

    const result = await runDualAgentSession({
      prompt: "do it",
      maxRounds: 4,
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" },
      operator: { provider: "ollama", model: "o" },
      mode: "consensus"
    });

    expect(result.status).toBe("approved");
    const roles = result.transcript.map((t) => t.role);
    // writer r1, critic r1, operator-review r1 (revise), writer r2, critic r2, operator-review r2 (approve), operator-plan, system
    expect(roles).toContain("operator");
    const approvalNote = result.transcript[result.transcript.length - 1];
    expect(approvalNote.summary).toContain("all approved");
  });

  it("honors minRounds: demotes early approval into a keep-going round", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    generate.mockImplementation(
      (_provider: unknown, messages: Array<{ role: string; content: string }>) => {
        const systemContent = messages.find((m) => m.role === "system")?.content || "";
        if (systemContent.startsWith("You are the writing")) {
          return Promise.resolve({ text: '{"summary":"draft","code":"x"}' });
        }
        if (systemContent.includes("harsh, adversarial code reviewer")) {
          return Promise.resolve({ text: '{"summary":"lgtm","verdict":"approved"}' });
        }
        return Promise.resolve({ text: '{}' });
      }
    );

    const result = await runDualAgentSession({
      prompt: "do it",
      maxRounds: 6,
      minRounds: 3,
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" }
    });

    expect(result.status).toBe("approved");
    const writerRounds = result.transcript.filter((t) => t.role === "writer").length;
    expect(writerRounds).toBe(3);
    const belowMinNotes = result.transcript.filter(
      (t) => t.role === "system" && t.summary.includes("below minRounds")
    ).length;
    expect(belowMinNotes).toBe(2);
  });

  it("consensus mode runs past maxRounds until everyone approves", async () => {
    const { generateText } = await import("./providers.js");
    const { runDualAgentSession } = await import("./runSession.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    // Force 10 writer rounds before the operator approves. maxRounds is only 2 —
    // writer_critic would stop at round 2; consensus must ignore the cap.
    generate.mockImplementation(
      (_provider: unknown, messages: Array<{ role: string; content: string }>) => {
        const systemContent = messages.find((m) => m.role === "system")?.content || "";
        if (systemContent.startsWith("You are the writing")) {
          return Promise.resolve({ text: '{"summary":"draft","code":"x"}' });
        }
        if (systemContent.includes("harsh, adversarial code reviewer")) {
          return Promise.resolve({ text: '{"summary":"lgtm","verdict":"approved"}' });
        }
        if (systemContent.includes("operator acting as a harsh second reviewer")) {
          const reviewCalls = generate.mock.calls.filter((c: unknown[]) => {
            const msgs = c[1] as Array<{ role: string; content: string }>;
            const sys = msgs.find((m) => m.role === "system")?.content || "";
            return sys.includes("operator acting as a harsh second reviewer");
          }).length;
          return Promise.resolve({
            text:
              reviewCalls <= 9
                ? '{"summary":"still no","verdict":"revise","required_changes":["keep at it"]}'
                : '{"summary":"finally","verdict":"approved"}'
          });
        }
        if (systemContent.startsWith("You are the operator model")) {
          return Promise.resolve({ text: '{"summary":"plan","actions":[]}' });
        }
        return Promise.resolve({ text: '{}' });
      }
    );

    const result = await runDualAgentSession({
      prompt: "loop test",
      maxRounds: 2,
      mode: "consensus",
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" },
      operator: { provider: "ollama", model: "o" }
    });

    expect(result.status).toBe("approved");
    const writerRounds = result.transcript.filter((t) => t.role === "writer").length;
    expect(writerRounds).toBeGreaterThan(2);
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
