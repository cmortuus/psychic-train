import { jsonrepair } from "jsonrepair";
import { z } from "zod";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; excerpt: string };

/**
 * Walk the text starting at the first `{` and return the substring that
 * closes the outermost balanced brace. Throws if no JSON object is found
 * or if braces never balance (e.g. truncated output).
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error("Response did not contain a JSON object");
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error("Response did not contain a complete JSON object");
}

/**
 * Escape raw control chars inside JSON string literals so `JSON.parse`
 * will accept output from models that emit bare newlines / tabs inside
 * strings.
 */
export function repairControlCharsInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") { out += "\\r"; continue; }
    if (ch === "\t") { out += "\\t"; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

function collectJsonCandidates(text: string): string[] {
  const seen = new Set<string>();
  const push = (value: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!seen.has(trimmed)) seen.add(trimmed);
  };

  try {
    push(extractJsonObject(text));
  } catch {
    // fall back to loose extractions
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    push(text.slice(firstBrace, lastBrace + 1));
  }
  if (firstBrace !== -1) {
    // Handles truncation: jsonrepair will close the unclosed braces.
    push(text.slice(firstBrace));
  }

  return Array.from(seen);
}

/**
 * Try progressively more lenient strategies to turn `rawText` into a value
 * matching `schema`. Returns a structured ok/err result rather than throwing
 * so callers can drive retries and error reporting.
 */
export function tryParseJson<S extends z.ZodTypeAny>(
  rawText: string,
  schema: S
): ParseResult<z.infer<S>> {
  const trimmed = rawText.trim();
  const excerpt = rawText.replace(/\s+/g, " ").slice(0, 300);

  const candidates = collectJsonCandidates(trimmed);
  if (candidates.length === 0) {
    return { ok: false, reason: "Response did not contain a JSON object", excerpt };
  }

  let firstError: unknown = null;

  for (const candidate of candidates) {
    try {
      return { ok: true, value: schema.parse(JSON.parse(candidate)) };
    } catch (error) {
      if (firstError === null) firstError = error;
    }

    try {
      const repaired = repairControlCharsInJsonStrings(candidate);
      if (repaired !== candidate) {
        return { ok: true, value: schema.parse(JSON.parse(repaired)) };
      }
    } catch {
      // fall through
    }

    try {
      const repaired = jsonrepair(candidate);
      return { ok: true, value: schema.parse(JSON.parse(repaired)) };
    } catch {
      // try next candidate
    }
  }

  const reason = firstError instanceof Error ? firstError.message : "Unknown parsing error";
  return { ok: false, reason, excerpt };
}
