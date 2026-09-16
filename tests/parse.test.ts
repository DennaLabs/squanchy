import { describe, expect, test } from "bun:test";
import { parseReviewResult, filterFindingsToDiff } from "../src/review/parse";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewResult } from "../src/types";

const valid: ReviewResult = {
  overview: null,
  findings: [
    { severity: "vulnerability", file: "src/login.ts", line: 3, comment: "SQL injection", suggestion: "use a parameterized query" },
    { severity: "nit", file: "README.md", line: null, comment: "typo", suggestion: null },
  ],
};

describe("parseReviewResult", () => {
  test("clean JSON parses", () => {
    const r = parseReviewResult(JSON.stringify(valid));
    expect(r.findings.length).toBe(2);
  });

  test("fenced JSON parses", () => {
    const r = parseReviewResult("```json\n" + JSON.stringify(valid) + "\n```");
    expect(r.findings.length).toBe(2);
  });

  test("bad severity throws", () => {
    const bad = { overview: null, findings: [{ ...valid.findings[0], severity: "critical" }] };
    expect(() => parseReviewResult(JSON.stringify(bad))).toThrow();
  });

  test("line null allowed", () => {
    const r = parseReviewResult(JSON.stringify(valid));
    expect(r.findings[1].line).toBeNull();
  });

  test("garbage throws", () => {
    expect(() => parseReviewResult("not json at all")).toThrow();
  });
});

describe("filterFindingsToDiff", () => {
  test("drops findings on files not in the bundle", () => {
    const result = {
      overview: null,
      findings: [...valid.findings, { severity: "major" as const, file: "ghost.ts", line: 1, comment: "boo", suggestion: null }],
    };
    const filtered = filterFindingsToDiff(result, fixtureBundle);
    expect(filtered.findings.length).toBe(2);
    expect(filtered.findings.some((f) => f.file === "ghost.ts")).toBe(false);
  });
});
