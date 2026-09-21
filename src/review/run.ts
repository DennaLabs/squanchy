import type { Octokit } from "@octokit/rest";
import { runAgentLoop, type AgentEvent } from "../agent/loop";
import type { ToolCtx } from "../agent/tools";
import { DEFAULT_MAX_STEPS } from "../config";
import { fetchPrBundle, type PrBundle } from "../github/pr";
import type { AssistantMessage, ChatWithToolsArgs } from "../openrouter/client";
import type { RepoSnapshot } from "../snapshot/snapshot";
import type { ReviewOptions, ReviewResult } from "../types";
import { filterFindingsToDiff } from "./parse";
import { buildFirstUserMessage, buildSystemPrompt } from "./prompt";

export type ReviewEvent =
  | { type: "pr-fetch"; repo: string; prNumber: number }
  | {
      type: "pr-fetched";
      repo: string;
      prNumber: number;
      title: string;
      files: number;
      additions: number;
      deletions: number;
      headSha: string;
    }
  | { type: "snapshot"; kind: RepoSnapshot["kind"] }
  | { type: "agent"; event: AgentEvent }
  | { type: "posted"; url: string; findings: number }
  | { type: "done"; findings: number; seconds: number };

export interface RunReviewDeps {
  octokit: Octokit;
  apiKey: string;
  chatWithTools: (args: ChatWithToolsArgs) => Promise<AssistantMessage>;
  readRepoContext: () => string | null;
  /** Called lazily, at most once per review, the first time the agent uses a repo-inspection tool. */
  createSnapshot: (bundle: PrBundle) => RepoSnapshot | Promise<RepoSnapshot>;
  postReview: (bundle: PrBundle, result: ReviewResult) => Promise<{ htmlUrl: string }>;
  maxSteps?: number;
  debug?: (line: string) => void;
  onProgress?: (event: ReviewEvent) => void;
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const emit = deps.onProgress ?? (() => {});
  const startedAt = Date.now();
  emit({ type: "pr-fetch", repo: options.repo, prNumber: options.prNumber });
  const bundle = await fetchPrBundle(deps.octokit, options.repo, options.prNumber);
  emit({
    type: "pr-fetched",
    repo: bundle.repo,
    prNumber: bundle.prNumber,
    title: bundle.title,
    files: bundle.files.length,
    additions: bundle.files.reduce((n, f) => n + f.additions, 0),
    deletions: bundle.files.reduce((n, f) => n + f.deletions, 0),
    headSha: bundle.headSha,
  });
  // holder object so the closure assignment survives TS control-flow narrowing in finally
  const snapshotRef: { promise: Promise<RepoSnapshot> | null } = { promise: null };
  const ctx: ToolCtx = {
    bundle,
    getSnapshot: () =>
      (snapshotRef.promise ??= Promise.resolve(deps.createSnapshot(bundle)).then((snap) => {
        emit({ type: "snapshot", kind: snap.kind });
        return snap;
      })),
  };
  let loop;
  try {
    loop = await runAgentLoop({
      chatFn: deps.chatWithTools,
      apiKey: deps.apiKey,
      model: options.model,
      system: buildSystemPrompt(options),
      firstUser: buildFirstUserMessage(bundle, options, deps.readRepoContext()),
      ctx,
      maxSteps: deps.maxSteps ?? DEFAULT_MAX_STEPS,
      debug: deps.debug,
      onEvent: (event) => emit({ type: "agent", event }),
    });
  } finally {
    if (snapshotRef.promise) {
      const snapshot = await snapshotRef.promise.catch(() => null);
      await snapshot?.dispose().catch(() => {});
    }
  }
  const result = filterFindingsToDiff({ overview: loop.overview, findings: loop.findings }, bundle);
  if (options.mode === "review") {
    const posted = await deps.postReview(bundle, result);
    emit({ type: "posted", url: posted.htmlUrl, findings: result.findings.length });
    const done = { ...result, overview: (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}` };
    emit({ type: "done", findings: result.findings.length, seconds: elapsedSeconds(startedAt) });
    return done;
  }
  emit({ type: "done", findings: result.findings.length, seconds: elapsedSeconds(startedAt) });
  return result;
}

function elapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
