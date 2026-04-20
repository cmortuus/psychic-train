import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";

type BrowseEntry = {
  name: string;
  isDirectory: boolean;
  path: string;
};

export type BrowseResult = {
  cwd: string;
  parent: string | null;
  entries: BrowseEntry[];
};

function getAllowedRoots(): string[] {
  const raw = process.env.BROWSE_ROOTS;
  if (raw) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(entry));
  }
  return [resolve(homedir())];
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

export async function browseDirectory(requested: string | null): Promise<BrowseResult> {
  const roots = getAllowedRoots();
  const defaultPath = roots[0];
  if (!defaultPath) {
    throw new Error("No browse roots configured.");
  }
  const trimmed = (requested || "").trim();
  const candidate = trimmed ? (isAbsolute(trimmed) ? resolve(trimmed) : resolve(defaultPath, trimmed)) : defaultPath;

  if (!isInsideAnyRoot(candidate, roots)) {
    throw new Error(
      `Path is outside the allowed browse roots (${roots.join(", ")}).`
    );
  }

  const info = await stat(candidate).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`Not a directory: ${candidate}`);
  }

  const raw = await readdir(candidate, { withFileTypes: true });
  const entries: BrowseEntry[] = raw
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: resolve(candidate, entry.name)
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const parentCandidate = dirname(candidate);
  const parent =
    parentCandidate !== candidate && isInsideAnyRoot(parentCandidate, roots)
      ? parentCandidate
      : null;

  return { cwd: candidate, parent, entries };
}
