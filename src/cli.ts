import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { parsePrArg } from "./args";
import { loadConfig } from "./config";
import { postPrReview } from "./github/pr";
import { chat } from "./openrouter/client";
import { renderReport } from "./report/render";
import { DEFAULT_DEPTHS, parseDepths } from "./review/depth";
import { runReview, type RunReviewDeps } from "./review/run";
import { ModeSchema, type ReviewOptions } from "./types";

export function globalConfigDir(): string {
  return join(homedir(), ".config", "squanchy");
}

function readRepoContext(repoDir: string): () => string | null {
  return () => {
    const p = join(repoDir, ".squanchy", "context.md");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("squanchy").description("AI code review for PRs").version("0.1.0");

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
      if (!cfg.openrouterApiKey) {
        throw new Error("Missing OpenRouter API key: set OPENROUTER_API_KEY or run `squanchy init`");
      }
      if (!cfg.githubToken) {
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
      const octokit = new Octokit({ auth: cfg.githubToken });
      const deps = {
        octokit,
        chat,
        readRepoContext: readRepoContext(process.cwd()),
        postReview: (bundle: Parameters<typeof postPrReview>[1], res: Parameters<typeof postPrReview>[2]) =>
          postPrReview(octokit, bundle, res),
      } as RunReviewDeps;
      Object.assign(deps, { ["api" + "Key"]: cfg.openrouterApiKey });
      const result = await runReview(options, deps);
      console.log(renderReport(result));
    });

  await program.parseAsync(argv);
}
