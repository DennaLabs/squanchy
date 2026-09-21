import { describe, expect, test } from "bun:test";
import { createReviewProgress, CAT_BANNER } from "../src/ui/review-progress";
import type { Reporter } from "../src/ui/reporter";
import type { ReviewEvent } from "../src/review/run";

function fakeReporter(): Reporter & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    info: (m) => calls.push(["info", m]),
    start: (m) => calls.push(["start", m]),
    update: (m) => calls.push(["update", m]),
    stop: (m) => calls.push(["stop", m]),
    done: (m) => calls.push(["done", m]),
  };
}

const prFetched: ReviewEvent = {
  type: "pr-fetched",
  repo: "acme/widgets",
  prNumber: 42,
  title: "Add login endpoint",
  files: 3,
  additions: 120,
  deletions: 40,
  headSha: "bbb222",
};

describe("createReviewProgress", () => {
  test("full sequence of user-facing messages (emoji on)", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: true });
    progress.onProgress({ type: "pr-fetch", repo: "acme/widgets", prNumber: 42 });
    progress.onProgress(prFetched);
    progress.onProgress({ type: "snapshot", kind: "git-ref" });
    progress.onProgress({ type: "agent", event: { type: "step", n: 1, maxSteps: 25 } });
    progress.onProgress({ type: "agent", event: { type: "tool-call", name: "read_file", summary: "src/login.ts" } });
    progress.onProgress({ type: "agent", event: { type: "finding", severity: "major", file: "src/login.ts" } });
    progress.onProgress({ type: "agent", event: { type: "tool-call", name: "grep", summary: "db.run" } });
    progress.onProgress({ type: "posted", url: "https://github.com/x/y/pull/42#r1", findings: 2 });
    progress.onProgress({ type: "done", findings: 2, seconds: 38 });

    const msgs = r.calls.map(([, m]) => m);
    expect(r.calls[0]).toEqual(["start", "🐱 fetching PR #42"]);
    expect(msgs).toContain('🐱 reviewing "Add login endpoint" — 3 files (+120/−40)');
    expect(msgs).toContain("fetching the PR snapshot via git");
    expect(msgs).toContain("🐱 thinking (step 1/25)");
    expect(msgs).toContain("🐱 reading src/login.ts (step 1/25)");
    expect(msgs).toContain('🐱 searching the repo for "db.run" (step 1/25 · 1 finding)');
    expect(r.calls.at(-1)).toEqual(["stop", "review complete — 2 findings in 38s"]);
  });

  test("meta is accumulated for the report header", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "pr-fetch", repo: "acme/widgets", prNumber: 42 });
    progress.onProgress(prFetched);
    progress.onProgress({ type: "posted", url: "https://github.com/x/y/pull/42#r1", findings: 2 });
    progress.onProgress({ type: "done", findings: 2, seconds: 12 });
    expect(progress.meta).toMatchObject({
      repo: "acme/widgets",
      prNumber: 42,
      title: "Add login endpoint",
      headSha: "bbb222",
      files: 3,
      additions: 120,
      deletions: 40,
      postedUrl: "https://github.com/x/y/pull/42#r1",
      findings: 2,
      seconds: 12,
    });
  });

  test("emoji off: no cat in messages (Action logs)", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "pr-fetch", repo: "a/b", prNumber: 7 });
    progress.onProgress({ type: "agent", event: { type: "step", n: 2, maxSteps: 10 } });
    for (const [, m] of r.calls) expect(m).not.toContain("🐱");
    expect(r.calls[0]).toEqual(["start", "fetching PR #7"]);
  });

  test("finding counter pluralization and step suffix", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "agent", event: { type: "step", n: 3, maxSteps: 25 } });
    progress.onProgress({ type: "agent", event: { type: "finding", severity: "nit", file: "a" } });
    expect(r.calls.at(-1)![1]).toBe("thinking (step 3/25 · 1 finding)");
    progress.onProgress({ type: "agent", event: { type: "finding", severity: "nit", file: "b" } });
    expect(r.calls.at(-1)![1]).toBe("thinking (step 3/25 · 2 findings)");
  });

  test("snapshot kinds map to distinct messages", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "snapshot", kind: "tarball" });
    progress.onProgress({ type: "snapshot", kind: "fs" });
    const msgs = r.calls.map(([, m]) => m);
    expect(msgs).toContain("downloading the repo snapshot");
    expect(msgs).toContain("reading the checked-out repo");
  });

  test("tool messages for list_dir and unknown tools", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "agent", event: { type: "tool-call", name: "list_dir", summary: "" } });
    expect(r.calls.at(-1)![1]).toBe("listing the repo root");
    progress.onProgress({ type: "agent", event: { type: "tool-call", name: "mystery", summary: "x" } });
    expect(r.calls.at(-1)![1]).toBe("listing the repo root"); // unknown tool: message unchanged
  });

  test("done pluralization for one finding", () => {
    const r = fakeReporter();
    const progress = createReviewProgress(r, { emoji: false });
    progress.onProgress({ type: "done", findings: 1, seconds: 5 });
    expect(r.calls.at(-1)).toEqual(["stop", "review complete — 1 finding in 5s"]);
  });

  test("cat banner is ASCII art with the cat face", () => {
    expect(CAT_BANNER).toContain("/\\_/\\");
    expect(CAT_BANNER).toContain("( o.o )");
    expect(CAT_BANNER).toContain("squanchy");
  });
});
