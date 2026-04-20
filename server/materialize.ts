import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Workspace, assertPathInsideWorkspace } from "./workspace.js";

export type FilePayload = { path: string; content: string };

export type MaterializeResult = {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
};

const MAX_FILES = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function materializeFiles(
  workspace: Workspace,
  files: FilePayload[]
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], skipped: [] };
  if (!Array.isArray(files) || files.length === 0) return result;

  if (files.length > MAX_FILES) {
    throw new Error(`Refusing to materialize ${files.length} files (limit ${MAX_FILES}).`);
  }

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      result.skipped.push({ path: String(file?.path ?? ""), reason: "malformed entry" });
      continue;
    }
    const trimmedPath = file.path.trim();
    if (!trimmedPath || trimmedPath.includes("..")) {
      result.skipped.push({ path: trimmedPath || "<empty>", reason: "path contains '..'" });
      continue;
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
      result.skipped.push({ path: trimmedPath, reason: `content exceeds ${MAX_FILE_BYTES} bytes` });
      continue;
    }
    let absolute: string;
    try {
      absolute = assertPathInsideWorkspace(workspace, trimmedPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "path rejected";
      result.skipped.push({ path: trimmedPath, reason });
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
    result.written.push(absolute);
  }

  return result;
}
