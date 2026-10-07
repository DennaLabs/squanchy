import type { Octokit } from "@octokit/rest";
import { runAgentLoop, type AgentEvent } from "../agent/loop";
import type { ToolCtx } from "../agent/tools";
import { DEFAULT_MAX_STEPS } from "../config";
import { fetchPrBundle, type PrBundle } from "../github/pr";
import type { AssistantMessage, ChatWithToolsArgs } from "../openrouter/client";
import type { ModelInfo } from "../openrouter/models";
import type { RepoSnapshot } from "../snapshot/snapshot";
import type { ReviewOptions, ReviewResult } from "../types";
import type { TokenUsage } from "../usage";
import { filterFindingsToDiff } from "./parse";
import { buildFirstUserMessage, buildSystemPrompt } from "./prompt";

export type ReviewEvent =
  | { type: "session"; model: string; info: ModelInfo | null }
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
  | { type: "done"; findings: number; seconds: number; usage?: TokenUsage };

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
  /** Best-effort model metadata for the session banner + cost estimate; omit to skip the lookup. */
  getModelInfo?: (model: string) => Promise<ModelInfo | null>;
}

/** When the provider didn't report a cost, estimate it from the model's per-1M pricing. */
export function withCostEstimate(usage: TokenUsage, info: ModelInfo | null): TokenUsage {
  if (usage.costUsd !== null || !info) return usage;
  if (info.promptUsdPer1M === null || info.completionUsdPer1M === null) return usage;
  const est =
    (usage.inputTokens / 1_000_000) * info.promptUsdPer1M +
    (usage.outputTokens / 1_000_000) * info.completionUsdPer1M;
  return { ...usage, costUsd: est };
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const emit = deps.onProgress ?? (() => {});
  const startedAt = Date.now();
  const modelInfo = deps.getModelInfo
    ? await deps.getModelInfo(options.model).catch(() => null)
    : null;
  emit({ type: "session", model: options.model, info: modelInfo });
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
  const usage = withCostEstimate(loop.usage, modelInfo);
  const result: ReviewResult = {
    ...filterFindingsToDiff({ overview: loop.overview, findings: loop.findings }, bundle),
    usage,
    model: options.model,
    stepsUsed: loop.stepsUsed,
  };
  if (options.mode === "review") {
    const posted = await deps.postReview(bundle, result);
    emit({ type: "posted", url: posted.htmlUrl, findings: result.findings.length });
    const done = { ...result, overview: (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}` };
    emit({ type: "done", findings: result.findings.length, seconds: elapsedSeconds(startedAt), usage });
    return done;
  }
  emit({ type: "done", findings: result.findings.length, seconds: elapsedSeconds(startedAt), usage });
  return result;
}

function elapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
