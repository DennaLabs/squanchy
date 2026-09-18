import { describe, expect, test } from "bun:test";
import { TOOL_DEFS, executeTool, type ToolCtx, type ToolOutcome } from "../src/agent/tools";
import type { GrepMatch, RepoSnapshot } from "../src/snapshot/snapshot";
import { fixtureBundle } from "./fixtures/pr-bundle";

function fakeSnapshot(): RepoSnapshot & { reads: string[] } {
  const reads: string[] = [];
  return {
    kind: "fs",
    reads,
    readFile: async (p) => {
      reads.push(p);
      return p === "src/app.ts" ? "line1\nline2 target\nline3\n" : null;
    },
    listDir: async (p) => (p === "src" ? ["app.ts", "util.ts"] : null),
    grep: async (pattern): Promise<GrepMatch[]> =>
      pattern === "target"
        ? [{ path: "src/app.ts", line: 2, text: "line2 target", before: ["line1"], after: ["line3"] }]
        : [],
    dispose: async () => {},
  };
}

function makeCtx(): { ctx: ToolCtx; snap: ReturnType<typeof fakeSnapshot>; snapshotCalls: number } {
  const snap = fakeSnapshot();
  const holder = { ctx: null as unknown as ToolCtx, snap, snapshotCalls: 0 };
  holder.ctx = {
    bundle: fixtureBundle,
    getSnapshot: async () => {
      holder.snapshotCalls++;
      return snap;
    },
  };
  return holder;
}

function textOf(out: ToolOutcome): string {
  if (out.kind === "finish") throw new Error("expected a text outcome");
  return out.text;
}

describe("TOOL_DEFS", () => {
  test("all six tools are defined with JSON schemas", () => {
    const names = TOOL_DEFS.map((t) => t.function.name).sort();
    expect(names).toEqual(["finish_review", "get_file_diff", "grep", "list_dir", "read_file", "submit_finding"]);
    for (const t of TOOL_DEFS) {
      expect(t.type).toBe("function");
      expect(t.function.parameters.type).toBe("object");
      expect(t.function.description.length).toBeGreaterThan(10);
    }
  });
});

describe("executeTool", () => {
  test("get_file_diff returns the patch from the bundle", async () => {
    const { ctx, snapshotCalls } = makeCtx();
    const out = await executeTool("get_file_diff", JSON.stringify({ path: "src/login.ts" }), ctx);
    expect(out.kind).toBe("result");
    expect(textOf(out)).toContain("```diff");
    expect(textOf(out)).toContain("SELECT");
    expect(snapshotCalls).toBe(0); // served from the bundle, no snapshot needed
  });

  test("get_file_diff on unknown file lists changed files", async () => {
    const { ctx } = makeCtx();
    const out = await executeTool("get_file_diff", JSON.stringify({ path: "ghost.ts" }), ctx);
    expect(out.kind).toBe("error");
    expect(textOf(out)).toContain("src/login.ts");
  });

  test("get_file_diff on patch-less file suggests read_file", async () => {
    const { ctx } = makeCtx();
    ctx.bundle = {
      ...fixtureBundle,
      files: [{ path: "logo.png", status: "added", additions: 0, deletions: 0 }],
    };
    const out = await executeTool("get_file_diff", JSON.stringify({ path: "logo.png" }), ctx);
    expect(out.kind).toBe("result");
    expect(textOf(out)).toContain("read_file");
  });

  test("read_file goes through the snapshot; missing file is an error", async () => {
    const { ctx, snap } = makeCtx();
    const ok = await executeTool("read_file", JSON.stringify({ path: "src/app.ts" }), ctx);
    expect(ok.kind).toBe("result");
    expect(textOf(ok)).toContain("line2 target");
    expect(snap.reads).toEqual(["src/app.ts"]);
    const miss = await executeTool("read_file", JSON.stringify({ path: "nope.ts" }), ctx);
    expect(miss.kind).toBe("error");
  });

  test("list_dir defaults to root and reports missing dirs", async () => {
    const { ctx } = makeCtx();
    const ok = await executeTool("list_dir", JSON.stringify({ path: "src" }), ctx);
    expect(textOf(ok)).toContain("app.ts");
    const missing = await executeTool("list_dir", "{}", ctx);
    expect(missing.kind).toBe("error");
  });

  test("grep formats matches; no matches says so", async () => {
    const { ctx } = makeCtx();
    const hit = await executeTool("grep", JSON.stringify({ pattern: "target" }), ctx);
    expect(hit.kind).toBe("result");
    expect(textOf(hit)).toContain("src/app.ts");
    expect(textOf(hit)).toContain("2: line2 target");
    const miss = await executeTool("grep", JSON.stringify({ pattern: "zzz" }), ctx);
    expect(textOf(miss)).toContain("no matches");
  });

  test("submit_finding validates and normalizes suggestion", async () => {
    const { ctx } = makeCtx();
    const ok = await executeTool(
      "submit_finding",
      JSON.stringify({ severity: "major", file: "src/login.ts", line: 3, comment: "bug" }),
      ctx,
    );
    expect(ok.kind).toBe("finding");
    if (ok.kind !== "finding") throw new Error("unreachable");
    expect(ok.finding.suggestion).toBeNull();
    expect(ok.finding.line).toBe(3);

    const bad = await executeTool(
      "submit_finding",
      JSON.stringify({ severity: "critical", file: "a", line: 1, comment: "x" }),
      ctx,
    );
    expect(bad.kind).toBe("error");
    expect(textOf(bad)).toContain("severity");

    const badLine = await executeTool(
      "submit_finding",
      JSON.stringify({ severity: "nit", file: "a", line: -2, comment: "x" }),
      ctx,
    );
    expect(badLine.kind).toBe("error");

    const nullLine = await executeTool(
      "submit_finding",
      JSON.stringify({ severity: "info", file: "a", line: null, comment: "x" }),
      ctx,
    );
    expect(nullLine.kind).toBe("finding");
  });

  test("finish_review passes overview through", async () => {
    const { ctx } = makeCtx();
    const withOv = await executeTool("finish_review", JSON.stringify({ overview: "does things" }), ctx);
    expect(withOv).toEqual({ kind: "finish", overview: "does things" });
    const noArgs = await executeTool("finish_review", "", ctx);
    expect(noArgs).toEqual({ kind: "finish", overview: null });
  });

  test("invalid JSON args and unknown tools are errors, not crashes", async () => {
    const { ctx } = makeCtx();
    expect((await executeTool("read_file", "{not json", ctx)).kind).toBe("error");
    expect((await executeTool("bogus_tool", "{}", ctx)).kind).toBe("error");
    expect((await executeTool("read_file", "{}", ctx)).kind).toBe("error"); // missing required path
  });

  test("snapshot failures surface as tool errors", async () => {
    const ctx: ToolCtx = {
      bundle: fixtureBundle,
      getSnapshot: async () => {
        throw new Error("git fetch exploded");
      },
    };
    const out = await executeTool("read_file", JSON.stringify({ path: "a" }), ctx);
    expect(out.kind).toBe("error");
    expect(textOf(out)).toContain("git fetch exploded");
  });
});
