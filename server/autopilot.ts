import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AgentTurn, SessionHooks } from "./types.js";
import { CancelledError } from "./providers.js";
import { runDualAgentSession } from "./runSession.js";
import { runTests, TestRunResult } from "./testRunner.js";
import { Workspace, resolveWorkspace } from "./workspace.js";
import { ProviderConfig, SessionRequest } from "./types.js";

export type AutopilotRequest = {
  prompt: string;
  workspaceRoot: string;
  writer: ProviderConfig;
  critic: ProviderConfig;
  operator?: ProviderConfig;
  maxIterations?: number;
  anonymize?: boolean;
  usOnly?: boolean;
  mode?: "writer_critic" | "consensus";
};

export type AutopilotStatus =
  | "approved"
  | "budget_exhausted"
  | "shell_disabled"
  | "cancelled"
  | "failed";

export type AutopilotResult = {
  status: AutopilotStatus;
  iterations: number;
  finalCode: string;
  lastTestResult?: TestRunResult;
  committed?: boolean;
  reason?: string;
};

export type AutopilotHooks = {
  onIterationStart?: (iteration: number, taskPrompt: string) => void;
  onIterationComplete?: (iteration: number) => void;
  onSessionTurn?: (turn: AgentTurn) => void;
  onTestResult?: (result: TestRunResult) => void;
  onCommit?: (details: { hash?: string; message: string; output: string }) => void;
  onNote?: (message: string) => void;
};

const DEFAULT_MAX_ITERATIONS = 10;

export class ShellDisabledError extends Error {
  readonly code = "shell_disabled";
  constructor() {
    super("Autopilot requires ALLOW_SHELL_EXEC=true so it can run tests.");
    this.name = "ShellDisabledError";
  }
}

function shellEnabled(): boolean {
  return (process.env.ALLOW_SHELL_EXEC || "").toLowerCase() === "true";
}

function maxIterations(request: AutopilotRequest): number {
  const envCap = Number(process.env.AUTOPILOT_MAX_ITERATIONS);
  const cap = Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_MAX_ITERATIONS;
  const requested = Number(request.maxIterations);
  const hasRequested = Number.isFinite(requested) && requested > 0;
  return hasRequested ? Math.min(requested, cap) : cap;
}

function runGitCapture(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function ensureGitRepo(workspace: Workspace, hooks: AutopilotHooks): Promise<void> {
  const gitDir = await stat(join(workspace.root, ".git")).catch(() => null);
  if (gitDir && gitDir.isDirectory()) return;
  hooks.onNote?.("No .git directory found — running `git init`.");
  const result = await runGitCapture(["init"], workspace.root);
  if (result.code !== 0) {
    throw new Error(`git init failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function buildIterationPrompt(
  originalPrompt: string,
  iteration: number,
  lastTestResult: TestRunResult | undefined
): string {
  if (iteration === 1 || !lastTestResult) {
    return originalPrompt;
  }
  const failingList = lastTestResult.failingTests?.length
    ? lastTestResult.failingTests.map((t) => `- ${t}`).join("\n")
    : "(none extracted)";
  return [
    `Original task:\n${originalPrompt}`,
    `Iteration ${iteration} — the previous attempt's tests failed.`,
    `Test command: ${lastTestResult.command}`,
    `Failing tests:\n${failingList}`,
    `Test runner output (truncated):\n${lastTestResult.rawOutput.slice(0, 4000)}`,
    "Fix every failing test. Do not change unrelated code. Return the full updated file set."
  ].join("\n\n");
}

export async function runAutopilot(
  request: AutopilotRequest,
  hooks: AutopilotHooks = {},
  signal?: AbortSignal
): Promise<AutopilotResult> {
  if (!shellEnabled()) {
    throw new ShellDisabledError();
  }
  if (!request.workspaceRoot) {
    throw new Error("Autopilot requires a workspaceRoot.");
  }

  const workspace = await resolveWorkspace(request.workspaceRoot);
  await ensureGitRepo(workspace, hooks);

  const cap = maxIterations(request);
  let lastTestResult: TestRunResult | undefined;
  let lastFinalCode = "";

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    if (signal?.aborted) {
      return {
        status: "cancelled",
        iterations: iteration - 1,
        finalCode: lastFinalCode,
        lastTestResult
      };
    }

    const taskPrompt = buildIterationPrompt(request.prompt, iteration, lastTestResult);
    hooks.onIterationStart?.(iteration, taskPrompt);

    const sessionRequest: SessionRequest = {
      prompt: taskPrompt,
      maxRounds: 4,
      writer: request.writer,
      critic: request.critic,
      ...(request.operator ? { operator: request.operator } : {}),
      ...(typeof request.anonymize === "boolean" ? { anonymize: request.anonymize } : {}),
      ...(typeof request.usOnly === "boolean" ? { usOnly: request.usOnly } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      workspaceRoot: workspace.root
    };

    const sessionHooks: SessionHooks = {
      onTurn(turn) { hooks.onSessionTurn?.(turn); }
    };

    const sessionResult = await runDualAgentSession(sessionRequest, sessionHooks, signal).catch((error) => {
      if (error instanceof CancelledError) throw error;
      throw error;
    });

    lastFinalCode = sessionResult.finalCode || lastFinalCode;

    if (sessionResult.status === "cancelled") {
      return {
        status: "cancelled",
        iterations: iteration,
        finalCode: lastFinalCode,
        lastTestResult
      };
    }

    if (sessionResult.status !== "approved") {
      hooks.onNote?.(`Session ended with status ${sessionResult.status} on iteration ${iteration}.`);
      return {
        status: "failed",
        iterations: iteration,
        finalCode: lastFinalCode,
        lastTestResult,
        reason: `Session status: ${sessionResult.status}`
      };
    }

    const testResult = await runTests(workspace, signal);
    lastTestResult = testResult;
    hooks.onTestResult?.(testResult);

    if (testResult.passed) {
      const commitMessage = `autopilot: ${request.prompt.slice(0, 80).replace(/\s+/g, " ")} [iter ${iteration}]`;
      await runGitCapture(["add", "."], workspace.root);
      const commit = await runGitCapture(["commit", "-m", commitMessage], workspace.root);
      const committed = commit.code === 0;
      if (committed) {
        hooks.onCommit?.({ message: commitMessage, output: (commit.stdout + commit.stderr).trim() });
      } else {
        hooks.onNote?.(
          `git commit exited ${commit.code}: ${commit.stderr.trim() || commit.stdout.trim()}`
        );
      }
      hooks.onIterationComplete?.(iteration);
      return {
        status: "approved",
        iterations: iteration,
        finalCode: lastFinalCode,
        lastTestResult: testResult,
        committed
      };
    }

    hooks.onIterationComplete?.(iteration);
  }

  return {
    status: "budget_exhausted",
    iterations: cap,
    finalCode: lastFinalCode,
    lastTestResult,
    reason: `Autopilot stopped after ${cap} iteration(s) without green tests.`
  };
}
