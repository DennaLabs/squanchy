import { describe, expect, test } from "bun:test";
import { renderReport, wrapText } from "../src/report/render";
import type { Depth, ReviewResult } from "../src/types";

const result: ReviewResult = {
  overview: "This PR adds login.\n\nPosted: https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  findings: [
    { severity: "nit", file: "a.ts", line: 5, comment: "naming", suggestion: null },
    {
      severity: "vulnerability",
      file: "src/login.ts",
      line: 3,
      comment: "SQL injection: user input is interpolated into the query",
      suggestion: "db.run('SELECT ?', [q])",
    },
    { severity: "major", file: "c.ts", line: null, comment: "race condition", suggestion: null },
    { severity: "minor", file: "d.ts", line: 9, comment: "missing validation", suggestion: null },
    { severity: "info", file: "e.ts", line: null, comment: "fyi", suggestion: null },
  ],
};

const meta = {
  repo: "acme/widgets",
  prNumber: 42,
  title: "Add login endpoint",
  mode: "report" as const,
  model: "test/model",
  depths: ["vulnerabilities", "major"] as Depth[],
  seconds: 38,
  headSha: "bbb222",
  postedUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
};

const plain = renderReport(result, { color: false, width: 80, meta });

describe("renderReport (plain)", () => {
  test("no ANSI escapes when color is off", () => {
    expect(plain).not.toContain("\x1b[");
    expect(plain).not.toContain("\x1b]8;");
  });

  test("header shows PR, title and meta details", () => {
    expect(plain.startsWith("┌ squanchy review — acme/widgets#42")).toBe(true);
    expect(plain).toContain("Add login endpoint");
    expect(plain).toContain("report · test/model · depths: vulnerabilities,major · 38s");
    expect(plain).toContain("posted: https://github.com/acme/widgets/pull/42");
  });

  test("overview included, Posted suffix stripped", () => {
    expect(plain).toContain("This PR adds login.");
    expect(plain).not.toContain("Posted: https://");
    expect(plain).toContain("overview");
  });

  test("summary counts line with glyphs", () => {
    expect(plain).toContain("▲ 1 vulnerability");
    expect(plain).toContain("✖ 1 major");
    expect(plain).toContain("◆ 1 minor");
    expect(plain).toContain("▸ 1 nit");
    expect(plain).toContain("○ 1 info");
  });

  test("severities ordered vulnerability > major > minor > nit > info", () => {
    const v = plain.indexOf("▲ VULNERABILITY");
    const ma = plain.indexOf("✖ MAJOR");
    const mi = plain.indexOf("◆ MINOR");
    const n = plain.indexOf("▸ NIT");
    const i = plain.indexOf("○ INFO");
    expect(v).toBeGreaterThan(-1);
    expect(v).toBeLessThan(ma);
    expect(ma).toBeLessThan(mi);
    expect(mi).toBeLessThan(n);
    expect(n).toBeLessThan(i);
  });

  test("finding block has location, comment and suggestion", () => {
    expect(plain).toContain("│ src/login.ts:3");
    expect(plain).toContain("SQL injection: user input is interpolated into the query");
    expect(plain).toContain("suggestion:");
    expect(plain).toContain("db.run('SELECT ?', [q])");
  });

  test("footer reminder", () => {
    expect(plain).toContain("you are always in control of approving this PR");
  });

  test("LGTM state when no findings", () => {
    const out = renderReport({ overview: null, findings: [] }, { color: false, width: 80 });
    expect(out).toContain("no findings — LGTM");
    expect(out).not.toContain("▲");
  });

  test("long comments wrap inside the block", () => {
    const long = renderReport(
      {
        overview: null,
        findings: [
          {
            severity: "major",
            file: "x.ts",
            line: 1,
            comment: "word ".repeat(60).trim(),
            suggestion: null,
          },
        ],
      },
      { color: false, width: 40 },
    );
    const bodyLines = long.split("\n").filter((l) => l.startsWith("│ word") || l === "│ word");
    expect(bodyLines.length).toBeGreaterThan(3);
    for (const l of long.split("\n")) expect(l.length).toBeLessThanOrEqual(42);
  });

  test("works without meta", () => {
    const out = renderReport(result, { color: false, width: 80 });
    expect(out).toContain("squanchy review");
    expect(out).toContain("▲ VULNERABILITY");
  });
});

describe("renderReport (color)", () => {
  const colored = renderReport(result, { color: true, width: 80, meta });

  test("severity colors: magenta, red, orange-256, yellow", () => {
    expect(colored).toContain("\x1b[35m"); // magenta (vulnerability)
    expect(colored).toContain("\x1b[31m"); // red (major)
    expect(colored).toContain("\x1b[38;5;208m"); // orange (minor)
    expect(colored).toContain("\x1b[33m"); // yellow (nit)
  });

  test("file:line becomes an OSC-8 link to the blob at head sha", () => {
    expect(colored).toContain("\x1b]8;;https://github.com/acme/widgets/blob/bbb222/src/login.ts#L3\x07");
    expect(colored).toContain("\x1b]8;;https://github.com/acme/widgets/blob/bbb222/c.ts\x07"); // line null -> no anchor
  });

  test("LGTM is green", () => {
    const out = renderReport({ overview: null, findings: [] }, { color: true, width: 80 });
    expect(out).toContain("\x1b[32m");
  });
});

describe("wrapText", () => {
  test("greedy word wrap", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  test("hard-splits words longer than width", () => {
    expect(wrapText("aaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aa"]);
  });

  test("preserves explicit newlines and empty lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});
