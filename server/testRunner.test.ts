import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjectType, runTests } from "./testRunner.js";

describe("testRunner.detectProjectType", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "psychic-detect-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects node via package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
    expect(await detectProjectType({ root: dir })).toBe("node");
  });

  it("detects python via pyproject.toml", async () => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
    expect(await detectProjectType({ root: dir })).toBe("python");
  });

  it("detects rust via Cargo.toml", async () => {
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    expect(await detectProjectType({ root: dir })).toBe("rust");
  });

  it("detects go via go.mod", async () => {
    await writeFile(join(dir, "go.mod"), "module x\n");
    expect(await detectProjectType({ root: dir })).toBe("go");
  });

  it("falls back to make when a Makefile exists", async () => {
    await writeFile(join(dir, "Makefile"), "test:\n\techo ok\n");
    expect(await detectProjectType({ root: dir })).toBe("make");
  });

  it("returns null for an empty directory", async () => {
    expect(await detectProjectType({ root: dir })).toBe(null);
  });
});

describe("testRunner.runTests", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "psychic-run-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("returns passed: false with a clear summary when no project is detected", async () => {
    const result = await runTests({ root: dir });
    expect(result.passed).toBe(false);
    expect(result.projectType).toBe(null);
    expect(result.summary).toMatch(/Could not detect project type/);
  });

  it("reports pass when the detected command exits 0", async () => {
    // Minimal node project whose `npm test` alias runs a trivially-passing command.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", private: true, scripts: { test: "node -e \"process.exit(0)\"" } })
    );
    const result = await runTests({ root: dir });
    expect(result.projectType).toBe("node");
    expect(result.passed).toBe(true);
  }, 30_000);

  it("reports fail + captures failing-test hints on exit != 0", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        private: true,
        scripts: { test: "node -e \"console.log('FAIL  my-test');process.exit(1)\"" }
      })
    );
    const result = await runTests({ root: dir });
    expect(result.passed).toBe(false);
    expect(result.failingTests?.some((t) => t.includes("my-test"))).toBe(true);
  }, 30_000);
});
