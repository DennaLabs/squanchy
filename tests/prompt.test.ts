import { describe, expect, test } from "bun:test";
import { buildFirstUserMessage, buildSystemPrompt, INLINE_DIFF_BUDGET } from "../src/review/prompt";
import type { PrBundle } from "../src/github/pr";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewOptions } from "../src/types";

const baseOptions: ReviewOptions = {
  repo: fixtureBundle.repo,
  prNumber: 42,
  mode: "report",
  model: "test-model",
  depths: ["vulnerabilities"],
};

describe("buildSystemPrompt", () => {
  test("contains requested focus text only", () => {
    const system = buildSystemPrompt(baseOptions);
    expect(system).toContain("Security vulnerabilities");
    expect(system).not.toContain("Nits only");
  });

  test("multiple depths all appear", () => {
    const system = buildSystemPrompt({ ...baseOptions, depths: ["vulnerabilities", "nits"] });
    expect(system).toContain("Security vulnerabilities");
    expect(system).toContain("Nits only");
  });

  test("mentions the agent workflow tools", () => {
    const system = buildSystemPrompt(baseOptions);
    for (const tool of ["get_file_diff", "read_file", "list_dir", "grep", "submit_finding", "finish_review"]) {
      expect(system).toContain(tool);
    }
  });
});

describe("buildFirstUserMessage", () => {
  test("contains PR metadata, every file path and patch", () => {
    const user = buildFirstUserMessage(fixtureBundle, baseOptions, null);
    expect(user).toContain("src/login.ts");
    expect(user).toContain("README.md");
    expect(user).toContain("+db.run(`SELECT ${q}`);");
    expect(user).toContain("Add login endpoint");
    expect(user).toContain("dev1");
    expect(user).toContain(fixtureBundle.headSha);
  });

  test("user-provided overview appears verbatim", () => {
    const user = buildFirstUserMessage(fixtureBundle, { ...baseOptions, overview: "refactors auth flow" }, null);
    expect(user).toContain("refactors auth flow");
  });

  test("repo context injected when present, absent when null", () => {
    const withCtx = buildFirstUserMessage(fixtureBundle, baseOptions, "# stack: bun+ts");
    expect(withCtx).toContain("# stack: bun+ts");
    expect(withCtx).toContain("Repository context");
    const without = buildFirstUserMessage(fixtureBundle, baseOptions, null);
    expect(without).not.toContain("Repository context");
  });

  test("PR body included when present", () => {
    const user = buildFirstUserMessage(fixtureBundle, baseOptions, null);
    expect(user).toContain("Implements POST /login");
  });

  test("files beyond the inline budget point at get_file_diff", () => {
    const big: PrBundle = {
      ...fixtureBundle,
      files: [
        { path: "a.ts", status: "added", additions: 1, deletions: 0, patch: "x".repeat(INLINE_DIFF_BUDGET) },
        { path: "b.ts", status: "added", additions: 1, deletions: 0, patch: "+small" },
      ],
    };
    const user = buildFirstUserMessage(big, baseOptions, null);
    expect(user).toContain("x".repeat(100));
    expect(user).not.toContain("+small");
    expect(user).toContain("diff not inlined for size — fetch it with get_file_diff");
  });

  test("patch-less files point at read_file", () => {
    const bin: PrBundle = {
      ...fixtureBundle,
      files: [{ path: "logo.png", status: "added", additions: 0, deletions: 0 }],
    };
    const user = buildFirstUserMessage(bin, baseOptions, null);
    expect(user).toContain("use read_file");
  });

  test("truncated bundle adds a note", () => {
    const user = buildFirstUserMessage({ ...fixtureBundle, truncated: true }, baseOptions, null);
    expect(user).toContain("dropped by the size budget");
  });
});
