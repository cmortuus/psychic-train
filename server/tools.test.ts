import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./tools.js";

describe("run_shell tool", () => {
  let workspace: { root: string };
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    workspace = { root: await mkdtemp(join(tmpdir(), "psychic-shell-")) };
  });

  afterEach(async () => {
    await rm(workspace.root, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("refuses when ALLOW_SHELL_EXEC is not true", async () => {
    delete process.env.ALLOW_SHELL_EXEC;
    const result = await executeTool({ type: "run_shell", command: "node", args: ["-v"] }, workspace);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/disabled/);
  });

  it("refuses commands outside the allowlist", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "npm,pnpm";
    const result = await executeTool({ type: "run_shell", command: "rm", args: ["-rf", "/"] }, workspace);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not in the shell allowlist/);
  });

  it("refuses git and points at run_git", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    const result = await executeTool({ type: "run_shell", command: "git", args: ["status"] }, workspace);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/run_git/);
  });

  it("executes an allowlisted command inside the workspace", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node";
    const result = await executeTool(
      { type: "run_shell", command: "node", args: ["-e", "process.stdout.write(process.cwd())"] },
      workspace
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(workspace.root);
  });

  it("refuses when args array is too long", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node";
    const big = Array.from({ length: 100 }, (_, i) => `a${i}`);
    const result = await executeTool({ type: "run_shell", command: "node", args: big }, workspace);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/100 args/);
  });

  it("refuses when an individual arg is too long", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node";
    const giant = "x".repeat(20_000);
    const result = await executeTool({ type: "run_shell", command: "node", args: [giant] }, workspace);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/arg\[0\] is 20000 chars/);
  });

  it("reports timeout when the command exceeds SHELL_TIMEOUT_MS", async () => {
    process.env.ALLOW_SHELL_EXEC = "true";
    process.env.SHELL_ALLOWLIST = "node";
    process.env.SHELL_TIMEOUT_MS = "200";
    const result = await executeTool(
      { type: "run_shell", command: "node", args: ["-e", "setTimeout(() => {}, 5000)"] },
      workspace
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/timed out/);
  });
});
