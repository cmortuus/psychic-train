import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { getAllowedRoots, isInsideAnyRoot } from "./browse.js";
import { runTests } from "./testRunner.js";
import { Workspace, assertPathInsideWorkspace, resolveWorkspace } from "./workspace.js";

export const toolCallSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), content: z.string() }),
  z.object({
    type: z.literal("delegate_coding_task"),
    task: z.string().min(1),
    maxRounds: z.number().int().min(1).max(8).optional()
  }),
  z.object({ type: z.literal("set_workspace"), path: z.string().min(1) }),
  z.object({
    type: z.literal("clone_repo"),
    repoUrl: z.string().min(1),
    destination: z.string().min(1),
    setAsWorkspace: z.boolean().optional()
  }),
  z.object({
    type: z.literal("run_git"),
    args: z.array(z.string().min(1)).min(1)
  }),
  z.object({ type: z.literal("read_file"), path: z.string().min(1) }),
  z.object({
    type: z.literal("write_file"),
    path: z.string().min(1),
    content: z.string()
  }),
  z.object({ type: z.literal("list_dir"), path: z.string().default(".") }),
  z.object({
    type: z.literal("run_shell"),
    command: z.string().min(1),
    args: z.array(z.string()).default([])
  }),
  z.object({ type: z.literal("run_tests") })
]);

export type ToolCall = z.infer<typeof toolCallSchema>;

export type ToolResult = {
  ok: boolean;
  summary: string;
  detail?: string;
  workspace?: Workspace;
};

const GIT_ALLOWLIST = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "add",
  "commit",
  "ls-files",
  "rev-parse",
  "remote",
  "fetch",
  "pull",
  "stash"
]);

const GIT_DISALLOWED = new Set(["push", "reset", "rebase", "checkout", "clean", "rm"]);

const DEFAULT_SHELL_ALLOWLIST = new Set([
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "node",
  "tsc",
  "vitest",
  "pytest",
  "python",
  "python3",
  "cargo",
  "go",
  "make",
  "deno"
]);

function getShellAllowlist(): Set<string> {
  const raw = process.env.SHELL_ALLOWLIST;
  if (!raw) return DEFAULT_SHELL_ALLOWLIST;
  const entries = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return entries.length === 0 ? DEFAULT_SHELL_ALLOWLIST : new Set(entries);
}

function shellEnabled(): boolean {
  return (process.env.ALLOW_SHELL_EXEC || "").toLowerCase() === "true";
}

function shellTimeoutMs(): number {
  const raw = Number(process.env.SHELL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

const MAX_FILE_READ_BYTES = 256 * 1024;
const MAX_FILE_WRITE_BYTES = 1 * 1024 * 1024;

export async function runGitAllowlisted(
  workspace: Workspace,
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean; aborted: boolean }> {
  const first = args[0] || "";
  if (GIT_DISALLOWED.has(first)) {
    throw new Error(`git ${first} is blocked by the operator tool allowlist.`);
  }
  if (!GIT_ALLOWLIST.has(first)) {
    throw new Error(
      `git ${first} is not in the operator allowlist. Allowed: ${[...GIT_ALLOWLIST].join(", ")}.`
    );
  }

  return runCommand("git", args, workspace.root, undefined, signal);
}

export async function executeTool(
  call: ToolCall,
  workspace: Workspace,
  signal?: AbortSignal
): Promise<ToolResult> {
  switch (call.type) {
    case "message":
      return { ok: true, summary: call.content };
    case "set_workspace": {
      const next = await resolveWorkspace(call.path);
      return {
        ok: true,
        summary: `Workspace set to ${next.root}.`,
        workspace: next
      };
    }
    case "clone_repo": {
      if (!isAbsolute(call.destination)) {
        return { ok: false, summary: `clone_repo destination must be an absolute path. Received: ${call.destination}` };
      }
      const destination = resolvePath(call.destination);
      const roots = await getAllowedRoots();
      if (!isInsideAnyRoot(destination, roots)) {
        return {
          ok: false,
          summary: `Refused: clone destination ${destination} is outside the allowed browse roots (${roots.join(", ")}). Set BROWSE_ROOTS to expand the sandbox.`
        };
      }
      const destParent = dirname(destination);
      await mkdir(destParent, { recursive: true }).catch(() => undefined);
      const result = await runCommand("git", ["clone", call.repoUrl, destination], destParent, undefined, signal);
      if (result.code !== 0) {
        return {
          ok: false,
          summary: `git clone failed (exit ${result.code}).`,
          detail: result.stderr || result.stdout
        };
      }
      const next = call.setAsWorkspace ? await resolveWorkspace(destination) : undefined;
      return {
        ok: true,
        summary: `Cloned ${call.repoUrl} to ${destination}${next ? " (workspace updated)" : ""}.`,
        detail: result.stdout + result.stderr,
        ...(next ? { workspace: next } : {})
      };
    }
    case "run_git": {
      const result = await runGitAllowlisted(workspace, call.args, signal);
      return {
        ok: result.code === 0,
        summary: `git ${call.args.join(" ")} (exit ${result.code})`,
        detail: (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")).trim()
      };
    }
    case "read_file": {
      const absolute = await assertPathInsideWorkspace(workspace, call.path);
      const buf = await readFile(absolute);
      if (buf.byteLength > MAX_FILE_READ_BYTES) {
        return {
          ok: false,
          summary: `File too large to read (${buf.byteLength} bytes, limit ${MAX_FILE_READ_BYTES}).`
        };
      }
      return {
        ok: true,
        summary: `Read ${absolute} (${buf.byteLength} bytes).`,
        detail: buf.toString("utf8")
      };
    }
    case "write_file": {
      if (call.content.length > MAX_FILE_WRITE_BYTES) {
        return {
          ok: false,
          summary: `Refused: content exceeds ${MAX_FILE_WRITE_BYTES} bytes.`
        };
      }
      const absolute = await assertPathInsideWorkspace(workspace, call.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, call.content, "utf8");
      return {
        ok: true,
        summary: `Wrote ${absolute} (${call.content.length} bytes).`
      };
    }
    case "list_dir": {
      const absolute = await assertPathInsideWorkspace(workspace, call.path || ".");
      const entries = await readdir(absolute, { withFileTypes: true });
      const listing = entries
        .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
        .sort()
        .join("\n");
      return { ok: true, summary: `${entries.length} entries in ${absolute}.`, detail: listing };
    }
    case "run_shell": {
      if (!shellEnabled()) {
        return {
          ok: false,
          summary: "run_shell is disabled. Set ALLOW_SHELL_EXEC=true to enable."
        };
      }
      if (call.command === "git") {
        return {
          ok: false,
          summary: "Use run_git for git subcommands (allowlisted)."
        };
      }
      const allow = getShellAllowlist();
      if (!allow.has(call.command)) {
        return {
          ok: false,
          summary: `Command ${call.command} is not in the shell allowlist (${Array.from(allow).join(", ")}). Override via SHELL_ALLOWLIST env.`
        };
      }
      const timeoutMs = shellTimeoutMs();
      const result = await runCommand(call.command, call.args, workspace.root, timeoutMs, signal);
      const detailParts: string[] = [];
      if (result.stdout.trim()) detailParts.push(result.stdout.trim());
      if (result.stderr.trim()) detailParts.push(`[stderr]\n${result.stderr.trim()}`);
      if (result.timedOut) detailParts.push(`[timeout] exceeded ${timeoutMs}ms`);
      if (result.aborted) detailParts.push(`[aborted] client cancelled the request`);
      return {
        ok: !result.timedOut && !result.aborted && result.code === 0,
        summary: `${call.command} ${call.args.join(" ")}`.trim() + ` (exit ${result.code}${result.timedOut ? ", timed out" : ""}${result.aborted ? ", aborted" : ""})`,
        detail: detailParts.join("\n")
      };
    }
    case "run_tests": {
      if (!shellEnabled()) {
        return {
          ok: false,
          summary: "run_tests requires ALLOW_SHELL_EXEC=true (it shells out to the detected test runner)."
        };
      }
      const result = await runTests(workspace, signal);
      const detailParts: string[] = [];
      detailParts.push(`project: ${result.projectType ?? "unknown"}`);
      detailParts.push(`command: ${result.command || "(none)"}`);
      if (result.failingTests && result.failingTests.length) {
        detailParts.push(`failing:\n- ${result.failingTests.join("\n- ")}`);
      }
      if (result.rawOutput) detailParts.push(result.rawOutput);
      return {
        ok: result.passed,
        summary: result.summary,
        detail: detailParts.join("\n")
      };
    }
    case "delegate_coding_task":
      return { ok: true, summary: `Delegating coding task: ${call.task}` };
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", code: -1, timedOut: false, aborted: true });
      return;
    }
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 2_000).unref();
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: code ?? -1, timedOut, aborted });
    });
  });
}
