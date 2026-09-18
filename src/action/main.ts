import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { parsePrArg } from "../args";
import { loadConfig } from "../config";
import { postPrReview } from "../github/pr";
import { chatWithTools as realChatWithTools } from "../openrouter/client";
import type { AssistantMessage, ChatWithToolsArgs } from "../openrouter/client";
import { parseDepths } from "../review/depth";
import { runReview } from "../review/run";
import { FsSnapshot } from "../snapshot/fs";
import { parseBotCommand } from "./command";

/** Only these comment authors may trigger reviews (stops drive-by credit burn). */
export const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface ActionEnv {
  [key: string]: string | undefined;
  SQUANCHY_COMMENT?: string;
  SQUANCHY_COMMENT_ID?: string;
  SQUANCHY_PR_URL?: string;
  SQUANCHY_AUTHOR_ASSOCIATION?: string;
  SQUANCHY_MODEL?: string;
  SQUANCHY_DEPTH?: string;
  SQUANCHY_MAX_STEPS?: string;
  SQUANCHY_DEBUG?: string;
  GITHUB_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  GITHUB_WORKSPACE?: string;
}

export interface ActionDeps {
  env: ActionEnv;
  octokitFactory: (token: string | undefined) => Octokit;
  chatWithTools: (args: ChatWithToolsArgs) => Promise<AssistantMessage>;
  log: (msg: string) => void;
  /** cwd: the checked-out PR head (provides .squanchy/context.md and the fs snapshot) */
  repoDir: string;
  globalDir: string;
}

/** Returns the process exit code. Never throws for expected failures; posts them as PR comments. */
export async function runAction(deps: ActionDeps): Promise<number> {
  const { env, log } = deps;

  // 1. authorization gate (defense in depth: the workflow `if:` filters too)
  const association = env.SQUANCHY_AUTHOR_ASSOCIATION ?? "";
  if (!ALLOWED_ASSOCIATIONS.has(association)) {
    log(`skipping: comment author association "${association || "unknown"}" is not allowed`);
    return 0;
  }

  // 2. parse the command
  const cfg = loadConfig({ globalDir: deps.globalDir, repoDir: deps.repoDir, env });
  const defaults = {
    model: env.SQUANCHY_MODEL ?? cfg.defaultModel,
    depths: env.SQUANCHY_DEPTH ? parseDepths(env.SQUANCHY_DEPTH) : cfg.defaultDepths,
  };
  const cmd = parseBotCommand(env.SQUANCHY_COMMENT ?? "", defaults);
  if (cmd.type === "none") {
    log("skipping: not a /squanchy command");
    return 0;
  }

  // 3. locate the PR
  let repo: string;
  let prNumber: number;
  try {
    ({ repo, prNumber } = parsePrArg(env.SQUANCHY_PR_URL ?? ""));
  } catch (err) {
    log(`cannot parse SQUANCHY_PR_URL "${env.SQUANCHY_PR_URL ?? ""}": ${errMsg(err)}`);
    return 1;
  }
  const [owner, name] = repo.split("/");
  if (!env.GITHUB_TOKEN) {
    log("GITHUB_TOKEN is not set; cannot interact with the PR");
    return 1;
  }
  const octokit = deps.octokitFactory(env.GITHUB_TOKEN);

  const comment = async (body: string): Promise<void> => {
    await octokit.rest.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
  };

  // 4. help / parse errors: reply and stop
  if (cmd.type === "reply") {
    await comment(cmd.reply);
    log("posted reply comment");
    return 0;
  }

  // 5. review
  const apiKey = env.OPENROUTER_API_KEY ?? cfg.openrouterApiKey;
  if (!apiKey) {
    await comment("squanchy failed: missing OpenRouter API key (set the `OPENROUTER_API_KEY` repo secret)");
    log("missing OPENROUTER_API_KEY");
    return 1;
  }

  const commentId = Number(env.SQUANCHY_COMMENT_ID);
  if (Number.isFinite(commentId) && commentId > 0) {
    try {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo: name,
        comment_id: commentId,
        content: "eyes",
      });
    } catch (err) {
      log(`reaction failed (continuing): ${errMsg(err)}`);
    }
  }

  log(`reviewing ${repo}#${prNumber} (model: ${cmd.options.model}, depths: ${cmd.options.depths.join(",")})`);
  try {
    const result = await runReview(
      { repo, prNumber, ...cmd.options },
      {
        octokit,
        apiKey,
        chatWithTools: deps.chatWithTools,
        readRepoContext: () => {
          const p = join(deps.repoDir, ".squanchy", "context.md");
          return existsSync(p) ? readFileSync(p, "utf8") : null;
        },
        createSnapshot: () => new FsSnapshot(deps.repoDir),
        postReview: (bundle, res) => postPrReview(octokit, bundle, res),
        maxSteps: env.SQUANCHY_MAX_STEPS ? Number(env.SQUANCHY_MAX_STEPS) : cfg.maxSteps,
        debug: env.SQUANCHY_DEBUG === "1" ? (line) => log(line) : undefined,
      },
    );
    const url = result.overview?.match(/Posted: (\S+)/)?.[1];
    await comment(
      `squanchy reviewed${url ? `: ${url}` : ""} — ${result.findings.length} finding(s). ` +
        "<sub>AI-generated; you are always in control of approving this PR.</sub>",
    );
    log(`review posted (${result.findings.length} findings)`);
    return 0;
  } catch (err) {
    const message = errMsg(err);
    log(`review failed: ${message}`);
    try {
      await comment(`squanchy failed: ${message.slice(0, 500)}\n\n<sub>See the workflow run logs for details.</sub>`);
    } catch (commentErr) {
      log(`could not post failure comment: ${errMsg(commentErr)}`);
    }
    return 1;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  runAction({
    env: process.env as ActionEnv,
    octokitFactory: (token) => new Octokit(token ? { auth: token } : {}),
    chatWithTools: realChatWithTools,
    log: (msg) => console.log(`[squanchy] ${msg}`),
    repoDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    globalDir: join(homedir(), ".config", "squanchy"),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[squanchy] fatal: ${err instanceof Error ? err.stack : String(err)}`);
      process.exitCode = 1;
    });
}
