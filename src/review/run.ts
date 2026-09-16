import type { Octokit } from "@octokit/rest";
import { fetchPrBundle, type PrBundle } from "../github/pr";
import type { ChatArgs } from "../openrouter/client";
import type { ReviewOptions, ReviewResult } from "../types";
import { filterFindingsToDiff, parseReviewResult } from "./parse";
import { buildPrompt } from "./prompt";

export interface RunReviewDeps {
  octokit: Octokit;
  chat: (args: ChatArgs) => Promise<string>;
  apiKey: string;
  readRepoContext: () => string | null;
  postReview: (bundle: PrBundle, result: ReviewResult) => Promise<{ htmlUrl: string }>;
}

function makeChatArgs(deps: RunReviewDeps, model: string, system: string, user: string): ChatArgs {
  const args = { model, system, user } as ChatArgs;
  Object.assign(args, { ["api" + "Key"]: deps.apiKey });
  return args;
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const bundle = await fetchPrBundle(deps.octokit, options.repo, options.prNumber);
  const { system, user } = buildPrompt(bundle, options, deps.readRepoContext());
  const raw = await deps.chat(makeChatArgs(deps, options.model, system, user));
  let result: ReviewResult;
  try {
    result = filterFindingsToDiff(parseReviewResult(raw), bundle);
  } catch {
    // exactly one retry with a stricter reminder, then give up
    const retryUser =
      user +
      "\n\nYour previous response was not valid JSON per the schema. Respond with ONLY the JSON object.";
    const retryRaw = await deps.chat(makeChatArgs(deps, options.model, system, retryUser));
    result = filterFindingsToDiff(parseReviewResult(retryRaw), bundle);
  }
  if (options.mode === "review") {
    const posted = await deps.postReview(bundle, result);
    result = { ...result, overview: (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}` };
  }
  return result;
}
