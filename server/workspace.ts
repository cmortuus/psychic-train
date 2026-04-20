import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

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
  // Canonical (symlink-resolved) root: every downstream containment check
  // compares realpaths, so a symlink that crosses the boundary cannot slip
  // past a string prefix test.
  const canonical = await realpath(normalized).catch(() => normalized);
  return { root: canonical };
}

/**
 * Resolve `path` relative to the workspace and follow every symlink that
 * already exists, then assert the final canonical path lives inside the
 * workspace root. Paths that don't exist yet (e.g. a new file about to be
 * created) are handled by canonicalising the nearest existing ancestor and
 * rejoining the missing tail — that prevents an attacker from creating a
 * symlink at a path the operator will later write to.
 */
export async function assertPathInsideWorkspace(
  workspace: Workspace,
  path: string
): Promise<string> {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace.root, path);
  const canonical = await canonicalizePath(target);
  if (canonical !== workspace.root && !canonical.startsWith(workspace.root + sep)) {
    throw new Error(
      `Path ${canonical} is outside the current workspace ${workspace.root}.`
    );
  }
  return canonical;
}

export async function canonicalizePath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // target doesn't exist — walk up to the nearest existing ancestor,
    // realpath that, then rejoin the unresolved tail.
  }
  const tail: string[] = [];
  let current = target;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding any existing ancestor.
      return target;
    }
    try {
      const resolvedParent = await realpath(parent);
      tail.unshift(basename(current));
      return resolve(resolvedParent, ...tail);
    } catch {
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
