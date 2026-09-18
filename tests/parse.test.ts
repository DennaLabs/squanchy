import { describe, expect, test } from "bun:test";
import { filterFindingsToDiff } from "../src/review/parse";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewResult } from "../src/types";

const valid: ReviewResult = {
  overview: null,
  findings: [
    { severity: "vulnerability", file: "src/login.ts", line: 3, comment: "SQL injection", suggestion: "use a parameterized query" },
    { severity: "nit", file: "README.md", line: null, comment: "typo", suggestion: null },
  ],
};

describe("filterFindingsToDiff", () => {
  test("drops findings on files not in the bundle", () => {
    const result: ReviewResult = {
      overview: null,
      findings: [...valid.findings, { severity: "major", file: "ghost.ts", line: 1, comment: "boo", suggestion: null }],
    };
    const filtered = filterFindingsToDiff(result, fixtureBundle);
    expect(filtered.findings.length).toBe(2);
    expect(filtered.findings.some((f) => f.file === "ghost.ts")).toBe(false);
  });

  test("keeps overview", () => {
    const filtered = filterFindingsToDiff({ ...valid, overview: "hi" }, fixtureBundle);
    expect(filtered.overview).toBe("hi");
  });
});
