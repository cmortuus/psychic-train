import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
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
  z.object({ type: z.literal("list_dir"), path: z.string().default(".") })
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

const MAX_FILE_READ_BYTES = 256 * 1024;
const MAX_FILE_WRITE_BYTES = 1 * 1024 * 1024;

export async function runGitAllowlisted(
  workspace: Workspace,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  const first = args[0] || "";
  if (GIT_DISALLOWED.has(first)) {
    throw new Error(`git ${first} is blocked by the operator tool allowlist.`);
  }
  if (!GIT_ALLOWLIST.has(first)) {
    throw new Error(
      `git ${first} is not in the operator allowlist. Allowed: ${[...GIT_ALLOWLIST].join(", ")}.`
    );
  }

  return runCommand("git", args, workspace.root);
}

export async function executeTool(
  call: ToolCall,
  workspace: Workspace
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
      const destParent = dirname(call.destination);
      await mkdir(destParent, { recursive: true }).catch(() => undefined);
      const result = await runCommand("git", ["clone", call.repoUrl, call.destination], destParent);
      if (result.code !== 0) {
        return {
          ok: false,
          summary: `git clone failed (exit ${result.code}).`,
          detail: result.stderr || result.stdout
        };
      }
      const next = call.setAsWorkspace ? await resolveWorkspace(call.destination) : undefined;
      return {
        ok: true,
        summary: `Cloned ${call.repoUrl} to ${call.destination}${next ? " (workspace updated)" : ""}.`,
        detail: result.stdout + result.stderr,
        ...(next ? { workspace: next } : {})
      };
    }
    case "run_git": {
      const result = await runGitAllowlisted(workspace, call.args);
      return {
        ok: result.code === 0,
        summary: `git ${call.args.join(" ")} (exit ${result.code})`,
        detail: (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")).trim()
      };
    }
    case "read_file": {
      const absolute = assertPathInsideWorkspace(workspace, call.path);
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
      const absolute = assertPathInsideWorkspace(workspace, call.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, call.content, "utf8");
      return {
        ok: true,
        summary: `Wrote ${absolute} (${call.content.length} bytes).`
      };
    }
    case "list_dir": {
      const absolute = assertPathInsideWorkspace(workspace, call.path || ".");
      const entries = await readdir(absolute, { withFileTypes: true });
      const listing = entries
        .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
        .sort()
        .join("\n");
      return { ok: true, summary: `${entries.length} entries in ${absolute}.`, detail: listing };
    }
    case "delegate_coding_task":
      return { ok: true, summary: `Delegating coding task: ${call.task}` };
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
