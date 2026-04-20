import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./providers.js", () => ({
  generateText: vi.fn(),
  CancelledError: class extends Error {}
}));

vi.mock("./ollamaApi.js", () => ({
  preflightDaemons: vi.fn().mockResolvedValue(undefined),
  DaemonUnreachableError: class extends Error {}
}));

describe("runAutopilot", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "psychic-autopilot-"));
    process.env = { ...savedEnv };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("refuses to start when ALLOW_SHELL_EXEC is off", async () => {
    delete process.env.ALLOW_SHELL_EXEC;
    const { runAutopilot, ShellDisabledError } = await import("./autopilot.js");
    await expect(
      runAutopilot({
        prompt: "x",
        workspaceRoot: dir,
        writer: { provider: "ollama", model: "w" },
        critic: { provider: "ollama", model: "c" }
      })
    ).rejects.toBeInstanceOf(ShellDisabledError);
  });

  it("recovers from a first-iteration test failure and commits on the second", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node,npm";
    process.env.AUTOPILOT_MAX_ITERATIONS = "4";

    // Prepare workspace so detectProjectType -> 'node'. We use two
    // separate test scripts that the writer will swap via its files[]:
    //   iteration 1 writes package.json with a failing script;
    //   iteration 2 writes package.json with a passing script.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "tmp", private: true, scripts: { test: "node -e \"process.exit(1)\"" } })
    );

    const { generateText } = await import("./providers.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    let writerCalls = 0;
    generate.mockImplementation(
      (_provider: unknown, messages: Array<{ role: string; content: string }>) => {
        const systemContent = messages.find((m) => m.role === "system")?.content || "";
        if (systemContent.startsWith("You are the writing")) {
          writerCalls += 1;
          const passing = writerCalls >= 2;
          const pkg = {
            name: "tmp",
            private: true,
            scripts: { test: passing ? "node -e \"process.exit(0)\"" : "node -e \"process.exit(1)\"" }
          };
          return Promise.resolve({
            text: JSON.stringify({
              summary: passing ? "Green" : "Attempt",
              code: JSON.stringify(pkg),
              files: [{ path: "package.json", content: JSON.stringify(pkg) }]
            })
          });
        }
        if (systemContent.includes("harsh, adversarial code reviewer")) {
          return Promise.resolve({ text: JSON.stringify({ summary: "ok", verdict: "approved" }) });
        }
        return Promise.resolve({ text: "{}" });
      }
    );

    const { runAutopilot } = await import("./autopilot.js");
    const events: string[] = [];
    const result = await runAutopilot(
      {
        prompt: "make the tests pass",
        workspaceRoot: dir,
        writer: { provider: "ollama", model: "w" },
        critic: { provider: "ollama", model: "c" }
      },
      {
        onIterationStart: (iteration) => events.push(`iter:${iteration}`),
        onTestResult: (r) => events.push(`test:${r.passed}`),
        onCommit: () => events.push("commit")
      }
    );

    expect(result.status).toBe("approved");
    expect(result.iterations).toBe(2);
    expect(result.committed).toBe(true);
    expect(events).toContain("iter:1");
    expect(events).toContain("iter:2");
    expect(events).toContain("test:false");
    expect(events).toContain("test:true");
    expect(events).toContain("commit");
  }, 60_000);

  it("bails with test_timeout after consecutive test timeouts", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node,npm";
    process.env.SHELL_TIMEOUT_MS = "200";
    process.env.AUTOPILOT_MAX_ITERATIONS = "5";

    // Hanging test command so runTests always times out.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "tmp",
        private: true,
        scripts: { test: "node -e \"setTimeout(() => {}, 60_000)\"" }
      })
    );

    const { generateText } = await import("./providers.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();
    generate.mockImplementation((_provider: unknown, messages: Array<{ role: string; content: string }>) => {
      const systemContent = messages.find((m) => m.role === "system")?.content || "";
      if (systemContent.startsWith("You are the writing")) {
        const pkg = {
          name: "tmp",
          private: true,
          scripts: { test: "node -e \"setTimeout(() => {}, 60_000)\"" }
        };
        return Promise.resolve({
          text: JSON.stringify({
            summary: "hangs",
            code: JSON.stringify(pkg),
            files: [{ path: "package.json", content: JSON.stringify(pkg) }]
          })
        });
      }
      if (systemContent.includes("harsh, adversarial code reviewer")) {
        return Promise.resolve({ text: JSON.stringify({ summary: "ok", verdict: "approved" }) });
      }
      return Promise.resolve({ text: "{}" });
    });

    const { runAutopilot } = await import("./autopilot.js");
    const notes: string[] = [];
    const result = await runAutopilot(
      {
        prompt: "hang forever",
        workspaceRoot: dir,
        writer: { provider: "ollama", model: "w" },
        critic: { provider: "ollama", model: "c" }
      },
      { onNote: (m) => notes.push(m) }
    );

    expect(result.status).toBe("test_timeout");
    // Two consecutive timeouts trip the bail, so we should not exhaust
    // the full AUTOPILOT_MAX_ITERATIONS=5.
    expect(result.iterations).toBe(2);
    expect(notes.some((n) => /timed out/i.test(n))).toBe(true);
  }, 60_000);

  it("returns budget_exhausted when tests never pass", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node,npm";
    process.env.AUTOPILOT_MAX_ITERATIONS = "2";

    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "tmp", private: true, scripts: { test: "node -e \"process.exit(1)\"" } })
    );

    const { generateText } = await import("./providers.js");
    const generate = generateText as unknown as ReturnType<typeof vi.fn>;
    generate.mockReset();

    generate.mockImplementation((_provider: unknown, messages: Array<{ role: string; content: string }>) => {
      const systemContent = messages.find((m) => m.role === "system")?.content || "";
      if (systemContent.startsWith("You are the writing")) {
        const pkg = { name: "tmp", private: true, scripts: { test: "node -e \"process.exit(1)\"" } };
        return Promise.resolve({
          text: JSON.stringify({
            summary: "still red",
            code: JSON.stringify(pkg),
            files: [{ path: "package.json", content: JSON.stringify(pkg) }]
          })
        });
      }
      if (systemContent.includes("harsh, adversarial code reviewer")) {
        return Promise.resolve({ text: JSON.stringify({ summary: "ok", verdict: "approved" }) });
      }
      return Promise.resolve({ text: "{}" });
    });

    const { runAutopilot } = await import("./autopilot.js");
    const result = await runAutopilot({
      prompt: "impossible",
      workspaceRoot: dir,
      writer: { provider: "ollama", model: "w" },
      critic: { provider: "ollama", model: "c" }
    });

    expect(result.status).toBe("budget_exhausted");
    expect(result.iterations).toBe(2);
  }, 60_000);
});
