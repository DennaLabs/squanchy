import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { postPrReview } from "../src/github/pr";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewResult } from "../src/types";

function fakeOctokit(capture: { payload?: Record<string, unknown> }): Octokit {
  return {
    pulls: {
      createReview: async (payload: Record<string, unknown>) => {
        capture.payload = payload;
        return { data: { html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-9" } };
      },
    },
  } as unknown as Octokit;
}

const result: ReviewResult = {
  overview: "A short overview",
  findings: [
    // fixture patch for src/login.ts: @@ -1,4 +1,6 @@ with 5 body lines -> new lines 1..5 (one removed? no: ctx,+,+,ctx = 4 new lines? compute: ctx(1) +(2) +(3) ctx(4) => {1,2,3,4})
    { severity: "vulnerability", file: "src/login.ts", line: 3, comment: "SQL injection", suggestion: "use params" },
    { severity: "major", file: "src/login.ts", line: 9999, comment: "not in diff", suggestion: null },
    { severity: "nit", file: "README.md", line: null, comment: "file-level nit", suggestion: null },
  ],
};

describe("postPrReview", () => {
  test("valid line goes inline, invalid demoted to body, event is COMMENT", async () => {
    const capture: { payload?: Record<string, unknown> } = {};
    const out = await postPrReview(fakeOctokit(capture), fixtureBundle, result);
    expect(out.htmlUrl).toContain("pullrequestreview-9");
    const p = capture.payload!;
    expect(p.event).toBe("COMMENT");
    expect(p.commit_id).toBe(fixtureBundle.headSha);
    const comments = p.comments as { path: string; line: number; body: string }[];
    expect(comments.length).toBe(1);
    expect(comments[0].path).toBe("src/login.ts");
    expect(comments[0].line).toBe(3);
    expect(comments[0].body).toContain("SQL injection");
    expect(comments[0].body).toContain("use params");
    const body = p.body as string;
    expect(body).toContain("A short overview");
    expect(body).toContain("3 finding(s)");
    expect(body).toContain("not in diff"); // demoted, not dropped
    expect(body).toContain("file-level nit"); // line:null findings live in the body
    expect(body).toContain("always in control");
  });

  test("empty findings still posts a summary review", async () => {
    const capture: { payload?: Record<string, unknown> } = {};
    await postPrReview(fakeOctokit(capture), fixtureBundle, { overview: null, findings: [] });
    expect((capture.payload!.comments as unknown[]).length).toBe(0);
    expect(capture.payload!.event).toBe("COMMENT");
  });
});
