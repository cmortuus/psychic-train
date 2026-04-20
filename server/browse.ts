import { readdir, realpath, stat } from "node:fs/promises";
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
  totalEntries: number;
  truncated: boolean;
};

const MAX_ENTRIES = (() => {
  const raw = Number(process.env.BROWSE_MAX_ENTRIES);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

export async function getAllowedRoots(): Promise<string[]> {
  const raw = process.env.BROWSE_ROOTS;
  const configured = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolve(entry))
    : [resolve(homedir())];
  // Resolve symlinks once up-front so containment checks compare realpaths.
  return Promise.all(
    configured.map((entry) => realpath(entry).catch(() => entry))
  );
}

export function isInsideAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

export async function browseDirectory(requested: string | null): Promise<BrowseResult> {
  const roots = await getAllowedRoots();
  const defaultPath = roots[0];
  if (!defaultPath) {
    throw new Error("No browse roots configured.");
  }
  const trimmed = (requested || "").trim();
  const raw = trimmed
    ? isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(defaultPath, trimmed)
    : defaultPath;

  // Resolve symlinks before the containment check so a link inside a root
  // pointing outside it cannot smuggle us out of the sandbox.
  const canonical = await realpath(raw).catch(() => raw);

  if (!isInsideAnyRoot(canonical, roots)) {
    throw new Error(
      `Path is outside the allowed browse roots (${roots.join(", ")}).`
    );
  }

  const info = await stat(canonical).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`Not a directory: ${canonical}`);
  }

  const rawEntries = await readdir(canonical, { withFileTypes: true });
  const allEntries: BrowseEntry[] = rawEntries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: resolve(canonical, entry.name)
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const totalEntries = allEntries.length;
  const truncated = totalEntries > MAX_ENTRIES;
  const entries = truncated ? allEntries.slice(0, MAX_ENTRIES) : allEntries;

  const parentCandidate = dirname(canonical);
  const parentCanonical = await realpath(parentCandidate).catch(() => parentCandidate);
  const parent =
    parentCanonical !== canonical && isInsideAnyRoot(parentCanonical, roots)
      ? parentCanonical
      : null;

  return { cwd: canonical, parent, entries, totalEntries, truncated };
}
