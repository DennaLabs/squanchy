import { describe, expect, test } from "bun:test";
import { renderReport } from "../src/report/render";
import type { ReviewResult } from "../src/types";

describe("renderReport", () => {
  test("empty findings", () => {
    expect(renderReport({ overview: null, findings: [] })).toContain("No findings. LGTM.");
  });

  test("overview first, severities ordered", () => {
    const result: ReviewResult = {
      overview: "This PR adds login.",
      findings: [
        { severity: "nit", file: "a.ts", line: 5, comment: "naming", suggestion: null },
        { severity: "vulnerability", file: "b.ts", line: 10, comment: "sqli", suggestion: "use params" },
        { severity: "major", file: "c.ts", line: null, comment: "race", suggestion: null },
      ],
    };
    const out = renderReport(result);
    expect(out.startsWith("OVERVIEW")).toBe(true);
    const vIdx = out.indexOf("b.ts:10");
    const mIdx = out.indexOf("c.ts");
    const nIdx = out.indexOf("a.ts:5");
    expect(vIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(nIdx);
    expect(out).toContain("VULNERABILITY");
    expect(out).toContain("suggestion: use params");
  });
});
