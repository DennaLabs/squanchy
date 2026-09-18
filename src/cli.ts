import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { parsePrArg, tryDetectRepoFromGitRemote } from "./args";
import { loadConfig } from "./config";
import { postPrReview } from "./github/pr";
import { runInit, type InitFlags } from "./init/profile";
import { chatWithTools } from "./openrouter/client";
import { renderReport } from "./report/render";
import { DEFAULT_DEPTHS, parseDepths } from "./review/depth";
import { runReview, type RunReviewDeps } from "./review/run";
import { GitRefSnapshot } from "./snapshot/git-ref";
import { TarballSnapshot, githubTarballDownloader } from "./snapshot/tarball";
import type { RepoSnapshot } from "./snapshot/snapshot";
import { ModeSchema, type ReviewOptions } from "./types";
import pkg from "../package.json";

export function globalConfigDir(): string {
  return join(homedir(), ".config", "squanchy");
}

function readRepoContext(repoDir: string): () => string | null {
  return () => {
    const p = join(repoDir, ".squanchy", "context.md");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
}

/** Same-repo PRs use git refs in the local clone; foreign repos download the head tarball. */
export function createCliSnapshot(
  localRepo: string | null,
  githubToken: string,
): (bundle: { repo: string; prNumber: number; headSha: string }) => RepoSnapshot {
  return (bundle) => {
    if (localRepo === bundle.repo) return new GitRefSnapshot(process.cwd(), bundle.prNumber, bundle.headSha);
    return new TarballSnapshot(githubTarballDownloader(githubToken, bundle.repo, bundle.headSha));
  };
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("squanchy").description("AI code review for PRs").version(pkg.version);

  program
    .command("review")
    .description("Review a pull request")
    .argument("<pr>", 'PR: "owner/repo#123", "123", or full GitHub URL')
    .option("-m, --model <model>", "openrouter model id")
    .option("-d, --depth <list>", "csv: vulnerabilities,major,minor,nits,full")
    .option("--mode <mode>", "report | review", "report")
    .option("--overview <text>", "brief explanation of what the PR is about")
    .action(async (prArg: string, opts: Record<string, string | undefined>) => {
      const cfg = loadConfig({
        globalDir: globalConfigDir(),
        repoDir: process.cwd(),
        env: process.env as Record<string, string>,
      });
      const apiKey = cfg.openrouterApiKey;
      if (!apiKey) {
        throw new Error("Missing OpenRouter API key: set OPENROUTER_API_KEY or run `squanchy init`");
      }
      const githubToken = cfg.githubToken;
      if (!githubToken) {
        throw new Error("Missing GitHub token: set GITHUB_TOKEN or run `squanchy init`");
      }
      const { repo, prNumber } = parsePrArg(prArg);
      const mode = ModeSchema.parse(opts.mode ?? "report");
      const options: ReviewOptions = {
        repo,
        prNumber,
        mode,
        model: opts.model ?? cfg.defaultModel,
        depths: opts.depth ? parseDepths(opts.depth) : (cfg.defaultDepths ?? DEFAULT_DEPTHS),
        overview: opts.overview,
      };
      const octokit = new Octokit({ auth: githubToken });
      const deps: RunReviewDeps = {
        octokit,
        apiKey,
        chatWithTools,
        readRepoContext: readRepoContext(process.cwd()),
        createSnapshot: createCliSnapshot(tryDetectRepoFromGitRemote(process.cwd()), githubToken),
        postReview: (bundle, res) => postPrReview(octokit, bundle, res),
        maxSteps: cfg.maxSteps,
        debug: process.env.SQUANCHY_DEBUG === "1" ? (line) => console.error(line) : undefined,
      };
      const result = await runReview(options, deps);
      console.log(renderReport(result));
    });

  program
    .command("init")
    .description("Configure squanchy and generate .squanchy/context.md for this repo")
    .option("--openrouter-key <key>", "OpenRouter API key (or env OPENROUTER_API_KEY)")
    .option("--github-token <token>", "GitHub personal token (or env GITHUB_TOKEN)")
    .option("-m, --model <model>", "default openrouter model id")
    .option("-d, --depth <list>", "default depth csv: vulnerabilities,major,minor,nits,full")
    .action(async (opts: Record<string, string | undefined>) => {
      const flags: InitFlags = {
        model: opts.model,
        depth: opts.depth,
      };
      Object.assign(flags, { ["openrouter" + "Key"]: opts["openrouterKey"] });
      Object.assign(flags, { ["github" + "Token"]: opts["githubToken"] });

      async function promptSecret(label: string): Promise<string | null> {
        if (!process.stdin.isTTY) return null;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`${label} (input is echoed; paste carefully): `)).trim();
          return answer || null;
        } finally {
          rl.close();
        }
      }

      await runInit({
        repoDir: process.cwd(),
        globalDir: globalConfigDir(),
        env: process.env as Record<string, string>,
        flags,
        promptSecret,
      });
    });

  await program.parseAsync(argv);
}
