import { access, constants, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type Workspace = {
  root: string;
};

export async function resolveWorkspace(path: string): Promise<Workspace> {
  if (!path || typeof path !== "string") {
    throw new Error("Workspace path is required.");
  }
  if (!isAbsolute(path)) {
    throw new Error(`Workspace must be an absolute path. Received: ${path}`);
  }
  const normalized = resolve(path);
  const info = await stat(normalized).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`Workspace does not exist or is not a directory: ${normalized}`);
  }
  await access(normalized, constants.R_OK).catch(() => {
    throw new Error(`Workspace is not readable: ${normalized}`);
  });
  return { root: normalized };
}

export function assertPathInsideWorkspace(workspace: Workspace, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace.root, path);
  if (absolute !== workspace.root && !absolute.startsWith(workspace.root + "/")) {
    throw new Error(
      `Path ${absolute} is outside the current workspace ${workspace.root}.`
    );
  }
  return absolute;
}
