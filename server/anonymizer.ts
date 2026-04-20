export type AnonymizeMap = {
  forward: Map<string, string>;
  reverse: Map<string, string>;
  counters: Map<string, number>;
};

export function createAnonymizeMap(): AnonymizeMap {
  return { forward: new Map(), reverse: new Map(), counters: new Map() };
}

type Pattern = { label: string; regex: RegExp };

const PATTERNS: Pattern[] = [
  // Absolute posix paths (including user homes on macOS / Linux)
  { label: "PATH", regex: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._\-/+]*)?/g },
  // Windows paths
  { label: "PATH", regex: /[A-Z]:\\[A-Za-z0-9._\\\- ]+/g },
  // Git SSH remote
  { label: "REMOTE", regex: /git@[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+\.git/g },
  // Git HTTPS remote
  { label: "REMOTE", regex: /https:\/\/(?:[A-Za-z0-9_.-]+@)?(?:github|gitlab|bitbucket)\.com\/[A-Za-z0-9_./-]+(?:\.git)?/g },
  // Email addresses
  { label: "EMAIL", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // OpenAI / Anthropic / generic sk_ tokens
  { label: "SECRET", regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g },
  // Generic Bearer tokens
  { label: "SECRET", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g }
];

export function getExtraPatterns(): Pattern[] {
  const raw = process.env.ANONYMIZE_PATTERNS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((literal) => ({
      label: "USER",
      regex: new RegExp(escapeRegex(literal), "g")
    }));
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nextToken(map: AnonymizeMap, label: string): string {
  const n = (map.counters.get(label) || 0) + 1;
  map.counters.set(label, n);
  return `<${label}_${n}>`;
}

export function sanitize(text: string, map: AnonymizeMap, extra: Pattern[] = []): string {
  let out = text;
  const all: Pattern[] = [...PATTERNS, ...extra];
  for (const { label, regex } of all) {
    out = out.replace(regex, (match) => {
      const existing = map.forward.get(match);
      if (existing) return existing;
      const token = nextToken(map, label);
      map.forward.set(match, token);
      map.reverse.set(token, match);
      return token;
    });
  }
  return out;
}

export function desanitize(text: string, map: AnonymizeMap): string {
  if (map.reverse.size === 0) return text;
  return text.replace(/<(PATH|REMOTE|EMAIL|SECRET|USER)_\d+>/g, (match) => {
    return map.reverse.get(match) ?? match;
  });
}
