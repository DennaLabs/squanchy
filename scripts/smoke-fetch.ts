// Manual smoke test: fetch a real public PR bundle.
// Usage: GITHUB_TOKEN=*** bun run scripts/smoke-fetch.ts [owner/repo] [number]
import { Octokit } from "@octokit/rest";
import { fetchPrBundle } from "../src/github/pr";

const repo = process.argv[2] ?? "oven-sh/bun";
const prNumber = Number(process.argv[3] ?? 1);
const token = process.env.GITHUB_TOKEN;
const octokit = token ? new Octokit({ auth: token }) : new Octokit();
const bundle = await fetchPrBundle(octokit, repo, prNumber);
console.log(`title: ${bundle.title}`);
console.log(`files: ${bundle.files.length}`);
console.log(`truncated: ${bundle.truncated}`);
