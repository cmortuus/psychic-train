import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Workspace } from "./workspace.js";

export type ProjectType = "node" | "python" | "rust" | "go" | "make" | "deno" | null;

export type TestRunResult = {
  passed: boolean;
  command: string;
  summary: string;
  rawOutput: string;
  failingTests?: string[];
  projectType: ProjectType;
  timedOut: boolean;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function detectProjectType(workspace: Workspace): Promise<ProjectType> {
  if (await fileExists(join(workspace.root, "package.json"))) return "node";
  if (await fileExists(join(workspace.root, "pyproject.toml"))) return "python";
  if (await fileExists(join(workspace.root, "Cargo.toml"))) return "rust";
  if (await fileExists(join(workspace.root, "go.mod"))) return "go";
  if (await fileExists(join(workspace.root, "deno.json")) || (await fileExists(join(workspace.root, "deno.jsonc")))) {
    return "deno";
  }
  const makefile = await statOrNull(join(workspace.root, "Makefile"));
  if (makefile && makefile.isFile()) return "make";
  return null;
}

type CommandSpec = { command: string; args: string[] };

async function resolveTestCommand(workspace: Workspace, projectType: ProjectType): Promise<CommandSpec | null> {
  switch (projectType) {
    case "node": {
      try {
        const pkg = JSON.parse(await readFile(join(workspace.root, "package.json"), "utf8"));
        if (pkg?.scripts?.test) {
          return { command: "npm", args: ["test", "--silent"] };
        }
      } catch {
        // ignore
      }
      return { command: "npm", args: ["test", "--silent"] };
    }
    case "python":
      return { command: "pytest", args: [] };
    case "rust":
      return { command: "cargo", args: ["test"] };
    case "go":
      return { command: "go", args: ["test", "./..."] };
    case "deno":
      return { command: "deno", args: ["test"] };
    case "make":
      return { command: "make", args: ["test"] };
    default:
      return null;
  }
}

function timeoutMs(): number {
  const raw = Number(process.env.SHELL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

function extractFailingNodeTests(output: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /^\s*(?:✕|×|FAIL|failing)\s+(.+)$/gim,
    /^\s*(?:FAIL)\s+(.+)$/gim,
    /^\s{2,}(?:\d+\)\s+)?(.+)\s+FAILED$/gim
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name) names.add(name);
    }
  }
  return Array.from(names).slice(0, 20);
}

export async function runTests(
  workspace: Workspace,
  signal?: AbortSignal
): Promise<TestRunResult> {
  const projectType = await detectProjectType(workspace);
  const spec = await resolveTestCommand(workspace, projectType);
  if (!spec) {
    return {
      passed: false,
      command: "",
      summary: "Could not detect project type (no package.json / pyproject.toml / Cargo.toml / go.mod / deno.json / Makefile).",
      rawOutput: "",
      projectType,
      timedOut: false
    };
  }

  const limit = timeoutMs();
  const { command, args } = spec;
  const result = await new Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const child = spawn(command, args, { cwd: workspace.root });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    }, limit);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
  }).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: -1,
    timedOut: false
  }));

  const rawOutput = (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();
  const passed = !result.timedOut && result.code === 0;
  const failingTests = passed ? undefined : extractFailingNodeTests(rawOutput);
  const summary = passed
    ? `${command} ${args.join(" ")} — passed`
    : result.timedOut
      ? `${command} ${args.join(" ")} — timed out after ${limit}ms`
      : `${command} ${args.join(" ")} — exit ${result.code}${failingTests && failingTests.length ? `, ${failingTests.length} failing test(s)` : ""}`;

  return {
    passed,
    command: `${command} ${args.join(" ")}`.trim(),
    summary,
    rawOutput,
    ...(failingTests && failingTests.length ? { failingTests } : {}),
    projectType,
    timedOut: result.timedOut
  };
}
