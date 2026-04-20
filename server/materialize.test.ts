import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeFiles } from "./materialize.js";

describe("materializeFiles", () => {
  let workspace: { root: string };

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "psychic-mat-"));
    workspace = { root: await realpath(dir) };
  });

  afterEach(async () => {
    await rm(workspace.root, { recursive: true, force: true });
  });

  it("writes relative files and reports them as absolute paths", async () => {
    const result = await materializeFiles(workspace, [
      { path: "src/index.ts", content: "export const x = 1;\n" },
      { path: "README.md", content: "# Hi\n" }
    ]);
    expect(result.written).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(await readFile(join(workspace.root, "src/index.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(await readFile(join(workspace.root, "README.md"), "utf8")).toBe("# Hi\n");
  });

  it("rejects paths that try to escape the workspace", async () => {
    const result = await materializeFiles(workspace, [
      { path: "../evil.txt", content: "x" }
    ]);
    expect(result.written).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/\.\./);
  });

  it("skips malformed entries without throwing", async () => {
    const result = await materializeFiles(workspace, [
      { path: "ok.txt", content: "fine" },
      { path: "", content: "nope" }
    ] as Array<{ path: string; content: string }>);
    expect(result.written).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it("refuses batches larger than the cap", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    await expect(materializeFiles(workspace, many)).rejects.toThrow(/Refusing/);
  });

  it("skips files above the per-file byte cap", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const result = await materializeFiles(workspace, [
      { path: "huge.txt", content: big },
      { path: "small.txt", content: "ok" }
    ]);
    expect(result.written).toEqual(expect.arrayContaining([expect.stringContaining("small.txt")]));
    expect(result.written.some((p) => p.endsWith("huge.txt"))).toBe(false);
    expect(result.skipped[0]?.path).toBe("huge.txt");
  });
});
