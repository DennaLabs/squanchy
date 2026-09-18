import type { Octokit } from "@octokit/rest";
import { runAgentLoop } from "../agent/loop";
import type { ToolCtx } from "../agent/tools";
import { DEFAULT_MAX_STEPS } from "../config";
import { fetchPrBundle, type PrBundle } from "../github/pr";
import type { AssistantMessage, ChatWithToolsArgs } from "../openrouter/client";
import type { RepoSnapshot } from "../snapshot/snapshot";
import type { ReviewOptions, ReviewResult } from "../types";
import { filterFindingsToDiff } from "./parse";
import { buildFirstUserMessage, buildSystemPrompt } from "./prompt";

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
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const bundle = await fetchPrBundle(deps.octokit, options.repo, options.prNumber);
  // holder object so the closure assignment survives TS control-flow narrowing in finally
  const snapshotRef: { promise: Promise<RepoSnapshot> | null } = { promise: null };
  const ctx: ToolCtx = {
    bundle,
    getSnapshot: () => (snapshotRef.promise ??= Promise.resolve(deps.createSnapshot(bundle))),
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
    return { ...result, overview: (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}` };
  }
  return result;
}
