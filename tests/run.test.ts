import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { runReview, type RunReviewDeps } from "../src/review/run";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewOptions, ReviewResult } from "../src/types";

function fakeOctokit(): Octokit {
  const rawFiles = fixtureBundle.files.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  return {
    pulls: {
      get: async () => ({
        data: {
          title: fixtureBundle.title,
          body: fixtureBundle.body,
          user: { login: fixtureBundle.author },
          base: { sha: fixtureBundle.baseSha },
          head: { sha: fixtureBundle.headSha },
        },
      }),
    },
    paginate: {
      iterator: () =>
        (async function* () {
          yield { data: rawFiles };
        })(),
    },
    rest: { pulls: { listFiles: {} } },
  } as unknown as Octokit;
}

const options: ReviewOptions = {
  repo: fixtureBundle.repo,
  prNumber: 42,
  mode: "report",
  model: "test-model",
  depths: ["vulnerabilities"],
};

const goodJson = JSON.stringify({
  overview: null,
  findings: [
    { severity: "vulnerability", file: "src/login.ts", line: 3, comment: "SQL injection", suggestion: null },
  ],
} satisfies ReviewResult);

function makeDeps(chatResponses: string[]): { deps: RunReviewDeps; posted: unknown[]; chatCalls: number[] } {
  const posted: unknown[] = [];
  const chatCalls: number[] = [];
  const key = ["test", "key"].join("-");
  const deps: RunReviewDeps = {
    octokit: fakeOctokit(),
    chat: async () => {
      const i = chatCalls.length;
      chatCalls.push(i);
      const r = chatResponses[Math.min(i, chatResponses.length - 1)];
      if (r === "__throw__") throw new Error("boom");
      return r;
    },
    apiKey: key,
    readRepoContext: () => null,
    postReview: async (_bundle, result) => {
      posted.push(result);
      return { htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" };
    },
  };
  return { deps, posted, chatCalls };
}

describe("runReview", () => {
  test("report mode never posts", async () => {
    const { deps, posted } = makeDeps([goodJson]);
    const result = await runReview(options, deps);
    expect(result.findings.length).toBe(1);
    expect(posted.length).toBe(0);
  });

  test("review mode posts once and records url", async () => {
    const { deps, posted } = makeDeps([goodJson]);
    const result = await runReview({ ...options, mode: "review" }, deps);
    expect(posted.length).toBe(1);
    expect(result.overview).toContain("Posted: https://github.com/acme/widgets/pull/42");
  });

  test("invalid first response triggers one retry", async () => {
    const { deps, chatCalls } = makeDeps(["totally not json", goodJson]);
    const result = await runReview(options, deps);
    expect(chatCalls.length).toBe(2);
    expect(result.findings.length).toBe(1);
  });

  test("both responses invalid throws", async () => {
    const { deps } = makeDeps(["nope", "still nope"]);
    await expect(runReview(options, deps)).rejects.toThrow();
  });

  test("findings on unknown files are filtered", async () => {
    const withGhost = JSON.stringify({
      overview: null,
      findings: [{ severity: "nit", file: "ghost.ts", line: 1, comment: "boo", suggestion: null }],
    });
    const { deps } = makeDeps([withGhost]);
    const result = await runReview(options, deps);
    expect(result.findings.length).toBe(0);
  });
});
