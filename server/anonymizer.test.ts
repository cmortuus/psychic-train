import { describe, expect, it } from "vitest";
import { createAnonymizeMap, desanitize, sanitize } from "./anonymizer.js";

describe("anonymizer", () => {
  it("replaces absolute posix paths with stable tokens", () => {
    const map = createAnonymizeMap();
    const out = sanitize(
      "open /Users/alice/code/project and /Users/alice/code/project again",
      map
    );
    expect(out).toMatch(/<PATH_1>/);
    expect(out.match(/<PATH_1>/g)?.length).toBe(2);
    expect(out).not.toContain("/Users/alice");
  });

  it("replaces git remotes", () => {
    const map = createAnonymizeMap();
    const out = sanitize(
      "clone git@github.com:cmortuus/psychic-train.git",
      map
    );
    expect(out).toContain("<REMOTE_1>");
    expect(out).not.toContain("cmortuus");
  });

  it("replaces common secret token formats", () => {
    const map = createAnonymizeMap();
    const out = sanitize("token=sk-abcdefghijklmnopqrstuvwxyz12345", map);
    expect(out).toContain("<SECRET_1>");
    expect(out).not.toContain("sk-abcdefghij");
  });

  it("replaces email addresses", () => {
    const map = createAnonymizeMap();
    const out = sanitize("email alice@example.com for details", map);
    expect(out).toContain("<EMAIL_1>");
    expect(out).not.toContain("alice@example.com");
  });

  it("assigns distinct tokens to distinct values and reuses tokens for repeats", () => {
    const map = createAnonymizeMap();
    const input = "/Users/alice/a and /Users/bob/b and /Users/alice/a again";
    const out = sanitize(input, map);
    const uniquePaths = new Set(out.match(/<PATH_\d+>/g));
    expect(uniquePaths.size).toBe(2);
  });

  it("desanitize reverses a sanitized string end-to-end", () => {
    const map = createAnonymizeMap();
    const original = "clone git@github.com:cmortuus/psychic-train.git into /Users/alice/work";
    const sanitized = sanitize(original, map);
    expect(sanitized).not.toBe(original);
    expect(desanitize(sanitized, map)).toBe(original);
  });

  it("desanitize leaves unknown placeholder tokens untouched", () => {
    const map = createAnonymizeMap();
    sanitize("/Users/alice/x", map);
    const hallucinated = "model returned <PATH_99> which is unknown";
    expect(desanitize(hallucinated, map)).toBe(hallucinated);
  });
});
