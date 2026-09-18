import { describe, expect, test } from "bun:test";
import { enforceDiffBudget, linesInDiff, type PrFile } from "../src/github/pr";

function mkFile(path: string, patchLen: number): PrFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "x".repeat(patchLen),
  };
}

describe("enforceDiffBudget", () => {
  test("small PR untouched", () => {
    const files = [mkFile("a.ts", 100), mkFile("b.ts", 200)];
    const { files: out, truncated } = enforceDiffBudget(files, 100_000);
    expect(truncated).toBe(false);
    expect(out[0].patch).toBe(files[0].patch);
    expect(out[1].patch).toBe(files[1].patch);
  });

  test("over-budget files are truncated or patch-less", () => {
    const files = [mkFile("a.ts", 60_000), mkFile("b.ts", 60_000), mkFile("c.ts", 60_000)];
    const { files: out, truncated } = enforceDiffBudget(files, 100_000);
    expect(truncated).toBe(true);
    expect(out[0].patch).toBe(files[0].patch); // kept whole
    expect(out[1].patch!.endsWith("[squanchy: patch truncated]")).toBe(true);
    expect(out[1].patch!.length).toBeLessThanOrEqual(60_000);
    expect(out[2].patch).toBeUndefined();
    const total = out.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(100_000);
  });

  test("files without patch pass through", () => {
    const files: PrFile[] = [{ path: "bin.dat", status: "modified", additions: 0, deletions: 0 }];
    const { files: out, truncated } = enforceDiffBudget(files, 100);
    expect(truncated).toBe(false);
    expect(out[0].patch).toBeUndefined();
  });
});

describe("linesInDiff", () => {
  test("counts context and added lines on the new side", () => {
    const patch = ["@@ -1,3 +10,4 @@", " ctx1", "+added", " ctx2", "-removed"].join("\n");
    expect([...linesInDiff(patch)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("multiple hunks", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "+b", "@@ -50,2 +80,3 @@", " c", "+d", "+e"].join("\n");
    expect([...linesInDiff(patch)].sort((a, b) => a - b)).toEqual([1, 2, 80, 81, 82]);
  });

  test("hunk with zero new lines", () => {
    const patch = ["@@ -5,3 +0,0 @@", "-x", "-y", "-z"].join("\n");
    expect(linesInDiff(patch).size).toBe(0);
  });

  test("empty patch", () => {
    expect(linesInDiff("").size).toBe(0);
  });

  test("no-newline markers do not consume line numbers", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join(
      "\n",
    );
    expect([...linesInDiff(patch)]).toEqual([1]);
  });
});
