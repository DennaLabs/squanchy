# Squanchy: AI code-review CLI + GitHub bot

## Goal

Build "squanchy" (cat from Rick and Morty): a TypeScript CLI and GitHub bot that performs LLM-powered code reviews of pull requests via OpenRouter, driven by PR comments (bot) or terminal commands (CLI), with configurable model, review mode (report/review), and review intensity (vulnerabilities/major/minor/nits/full).

## Current context / assumptions

- Repo `/home/ph/projects/squanchy` is empty (README.md + first commit on `main`).
- Runtime: Bun is NOT installed; system node is v12 (too old for anything). Step 1 installs Bun. Bun ships its own runtime/test-runner/bundler, so system node is irrelevant after that.
- Stack decisions (assumed, flagged in Open Questions):
  - Bun + TypeScript, ESM.
  - `commander` for CLI arg parsing, `zod` for schemas, `@octokit/rest` for GitHub API, `hono` for the bot webhook server.
  - OpenRouter called via plain `fetch` (OpenAI-compatible `/chat/completions`), no SDK.
- Secrets (OpenRouter key, GitHub PAT) live in `~/.config/squanchy/config.json` (chmod 600) or env vars `OPENROUTER_API_KEY` / `GITHUB_TOKEN`. Non-secret defaults (model, intensity) may also live per-repo in `.squanchy/config.json`.
- `squanchy init` generates a repo context profile at `.squanchy/context.md` (tech-stack detection + summary) that is injected into every review prompt. No "skills/plugins" system in v1; the context file is the single mechanism (YAGNI). See Open Questions.
- Phasing: Phase 1 = CLI end-to-end (init + report + review modes). Phase 2 = GitHub bot. Ship and validate Phase 1 before starting Phase 2.
- Review output contract: the LLM must return strict JSON matching a zod schema; parsing failures trigger one retry, then a hard error (never post a malformed review).
- Intensity default when unspecified: `vulnerabilities` + `major`. Intensity is therefore a SET of focuses, e.g. `--intensity vulnerabilities,major`. `full` = all focuses + PR overview section in the report.

## Architecture

A review is a pure pipeline: `resolve options -> fetch PR (octokit) -> load repo context -> build prompt -> call OpenRouter -> parse findings JSON -> render (report mode) OR post review (review mode)`. Every stage is a small module in `src/` with a typed interface, unit-tested with fixtures; the CLI and bot are thin adapters over the same `runReview()` orchestrator in `src/review/run.ts`. The bot (Phase 2) is a Hono server receiving `issue_comment` webhooks, parsing `/squanchy ...` commands into the same `ReviewOptions` type.

```
squanchy/
  package.json  tsconfig.json  .gitignore  README.md
  bin/squanchy.ts            # shebang entry -> src/cli.ts
  src/
    cli.ts                   # commander program
    types.ts                 # zod schemas + inferred types (single source of truth)
    config.ts                # load/merge/save config (global + repo + env + flags)
    github/client.ts         # octokit factory
    github/pr.ts             # fetchPrBundle(), postReview()
    openrouter/client.ts     # chat() with JSON enforcement + retry
    review/intensity.ts      # Intensity -> prompt focus text
    review/prompt.ts         # buildPrompt(bundle, options, context)
    review/parse.ts          # raw LLM text -> Finding[] (zod)
    review/run.ts            # runReview(options): orchestrator
    report/render.ts         # Finding[] -> terminal report string
    init/detect-stack.ts     # file/package.json heuristics -> StackInfo
    init/profile.ts          # StackInfo -> .squanchy/context.md (LLM-assisted)
    bot/server.ts            # Phase 2: Hono webhook
    bot/commands.ts          # Phase 2: comment text -> ReviewOptions
  tests/                     # *.test.ts, bun test, fixtures/ for GitHub + LLM payloads
```

---

# PHASE 1: CLI

## Task 1.1: Install Bun, scaffold project

Commands:

```bash
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
bun --version          # expect: 1.2.x or newer
cd /home/ph/projects/squanchy
bun init -y
```

Then overwrite `package.json` with:

```json
{
  "name": "squanchy",
  "version": "0.1.0",
  "type": "module",
  "bin": { "squanchy": "./bin/squanchy.ts" },
  "scripts": {
    "dev": "bun run bin/squanchy.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@octokit/rest": "^21.0.0",
    "commander": "^12.1.0",
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "typescript": "^5.6.0"
  }
}
```

Replace `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src", "bin", "tests"]
}
```

Create `.gitignore`:

```
node_modules/
.squanchy/context.md
```

Note: `.squanchy/config.json` is committed (non-secret defaults); `context.md` is machine-generated. Secrets never go in the repo (global config only).

Create `bin/squanchy.ts`:

```ts
#!/usr/bin/env bun
import "../src/cli";
```

Delete bun init's boilerplate `index.ts` if generated. Verify:

```bash
bun install            # expect: exit 0, packages installed
bun run typecheck      # expect: no errors (cli.ts doesn't exist yet -> create stub below first)
```

Stub `src/cli.ts` so typecheck passes:

```ts
import { Command } from "commander";
const program = new Command();
program.name("squanchy").description("AI code review for PRs").version("0.1.0");
program.parse();
```

Verify: `bun run dev --help` prints usage containing "squanchy". Commit: `git add -A && git commit -m "scaffold: bun + ts project"`.

## Task 1.2: Core types (src/types.ts) - TDD

Write `tests/types.test.ts` first:

```ts
import { describe, expect, test } from "bun:test";
import { parseIntensities, DEFAULT_INTENSITIES } from "../src/review/intensity";

describe("parseIntensities", () => {
  test("parses csv list", () => {
    expect(parseIntensities("vulnerabilities,major")).toEqual(["vulnerabilities", "major"]);
  });
  test("rejects unknown", () => {
    expect(() => parseIntensities("vulnerabilities,bogus")).toThrow();
  });
  test("default is vulnerabilities+major", () => {
    expect(DEFAULT_INTENSITIES).toEqual(["vulnerabilities", "major"]);
  });
  test("full expands to everything", () => {
    expect(parseIntensities("full")).toEqual(["vulnerabilities", "major", "minor", "nits", "full"]);
  });
});
```

Run `bun test` -> expect FAIL (module not found). Then create `src/types.ts`:

```ts
import { z } from "zod";

export const INTENSITIES = ["vulnerabilities", "major", "minor", "nits", "full"] as const;
export const IntensitySchema = z.enum(INTENSITIES);
export type Intensity = z.infer<typeof IntensitySchema>;

export const ModeSchema = z.enum(["report", "review"]);
export type Mode = z.infer<typeof ModeSchema>;

export const FindingSchema = z.object({
  severity: z.enum(["vulnerability", "major", "minor", "nit", "info"]),
  file: z.string(),
  line: z.number().int().positive().nullable(),
  comment: z.string(),
  suggestion: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewResultSchema = z.object({
  overview: z.string().nullable(),
  findings: z.array(FindingSchema),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface ReviewOptions {
  repo: string;            // "owner/name"
  prNumber: number;
  mode: Mode;
  model: string;           // openrouter model id
  intensities: Intensity[];
  overview?: string;       // user-supplied PR overview text
}

export interface SquanchyConfig {
  openrouterApiKey?: string;
  githubToken?: string;
  defaultModel: string;
  defaultIntensities: Intensity[];
}
```

And `src/review/intensity.ts`:

```ts
import { IntensitySchema, type Intensity } from "../types";

export const DEFAULT_INTENSITIES: Intensity[] = ["vulnerabilities", "major"];

export function parseIntensities(raw: string): Intensity[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const parsed = parts.map((p) => IntensitySchema.parse(p));
  if (parsed.includes("full")) {
    return ["vulnerabilities", "major", "minor", "nits", "full"];
  }
  return [...new Set(parsed)];
}
```

Run `bun test` -> expect 4 passes. Commit: `git commit -am "types + intensity parsing"`.

## Task 1.3: Config load/save (src/config.ts) - TDD

`tests/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("repo config overrides global defaults, env overrides secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-"));
    const globalDir = join(dir, "global");
    mkdirSync(join(dir, "repo", ".squanchy"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({
      defaultModel: "global-model", defaultIntensities: ["minor"], githubToken: "***" }));
    writeFileSync(join(dir, "repo", ".squanchy", "config.json"), JSON.stringify({
      defaultModel: "repo-model" }));
    const cfg = loadConfig({
      globalDir, repoDir: join(dir, "repo"),
      env: { OPENROUTER_API_KEY: "***" },
    });
    expect(cfg.defaultModel).toBe("repo-model");
    expect(cfg.defaultIntensities).toEqual(["minor"]);
    expect(cfg.openrouterApiKey).toBe("env-key");
    expect(cfg.githubToken).toBe("global-token");
  });
  test("works with no files at all (built-in defaults)", () => {
    const cfg = loadConfig({ globalDir: "/nonexistent", repoDir: "/nonexistent", env: {} });
    expect(cfg.defaultModel).toBe("anthropic/claude-sonnet-4.5");
    expect(cfg.defaultIntensities).toEqual(["vulnerabilities", "major"]);
  });
});
```

Run -> FAIL. Implement `src/config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_INTENSITIES } from "./review/intensity";
import type { SquanchyConfig } from "./types";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

const FileSchema = z.object({
  openrouterApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultIntensities: z.array(z.string()).optional(),
}).partial();

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface LoadConfigArgs {
  globalDir: string;                 // ~/.config/squanchy
  repoDir: string;                   // cwd (repo root)
  env: Record<string, string | undefined>;
}

export function loadConfig({ globalDir, repoDir, env }: LoadConfigArgs): SquanchyConfig {
  const g = FileSchema.parse(readJsonIfExists(join(globalDir, "config.json")));
  const r = FileSchema.parse(readJsonIfExists(join(repoDir, ".squanchy", "config.json")));
  return {
    openrouterApiKey: env.OPENROUTER_API_KEY ?? g.openrouterApiKey ?? r.openrouterApiKey,
    githubToken: env.GITHUB_TOKEN ?? g.githubToken ?? r.githubToken,
    defaultModel: r.defaultModel ?? g.defaultModel ?? DEFAULT_MODEL,
    defaultIntensities: DEFAULT_INTENSITIES, // validated below
  };
}
```

(Fix `defaultIntensities` to actually merge: parse `r.defaultIntensities ?? g.defaultIntensities` through `parseIntensities(csv)` when present, else `DEFAULT_INTENSITIES`. The test above pins the behavior: global `["minor"]` must survive.)

Also add `saveGlobalConfig(cfg)` that writes `~/.config/squanchy/config.json` with mode 0o600 (`mkdirSync(dir, { recursive: true })`, `writeFileSync(path, json, { mode: 0o600 })`).

Run `bun test` -> PASS. Commit.

## Task 1.4: GitHub PR fetching (src/github/pr.ts) - TDD with fixtures

Define the bundle type in `src/github/pr.ts`:

```ts
import { Octokit } from "@octokit/rest";

export interface PrFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;          // unified diff hunk text (absent for binaries)
}

export interface PrBundle {
  repo: string;
  prNumber: number;
  title: string;
  body: string | null;
  author: string;
  baseSha: string;
  headSha: string;
  files: PrFile[];
}

export async function fetchPrBundle(octokit: Octokit, repo: string, prNumber: number): Promise<PrBundle> {
  const [owner, name] = repo.split("/");
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  const files: PrFile[] = [];
  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner, repo: name, pull_number: prNumber, per_page: 100,
  })) {
    for (const f of page.data) {
      files.push({
        path: f.filename,
        status: f.status as PrFile["status"],
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
  }
  return {
    repo, prNumber, title: pr.title, body: pr.body,
    author: pr.user?.login ?? "unknown",
    baseSha: pr.base.sha, headSha: pr.head.sha,
    files,
  };
}
```

Also add a diff-size guard: if total patch characters across files exceed `MAX_DIFF_CHARS = 150_000`, truncate per-file (largest files first) and record `truncated: true` on the bundle. Unit-test the guard with synthetic file arrays (pure function `enforceDiffBudget(files, maxChars)` exported separately; test: given 3 files of 60k chars each with budget 100k, result fits budget and keeps earliest/complete small files intact).

Write `tests/pr.test.ts` for `enforceDiffBudget` only (no network). Run -> FAIL -> implement -> PASS. Commit.

Live smoke test (manual, not automated): create `scripts/smoke-fetch.ts` that reads `GITHUB_TOKEN` from env, calls `fetchPrBundle` for a real public PR (e.g. `bun run scripts/smoke-fetch.ts oven-sh/bun 1`), prints title + file count. Expected output: `title: ... files: N` with N > 0.

## Task 1.5: OpenRouter client (src/openrouter/client.ts)

```ts
export interface ChatArgs {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
}

export async function chat({ apiKey, model, system, user, temperature = 0.2 }: ChatArgs): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/squanchy",
      "X-Title": "squanchy",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json() as any;
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}
```

No unit test for the network call itself; it gets exercised by the pipeline test with a mocked `chat` (Task 1.7). Commit.

## Task 1.6: Prompt building + findings parsing (src/review/prompt.ts, parse.ts) - TDD

`src/review/prompt.ts`:

```ts
import type { PrBundle } from "../github/pr";
import type { ReviewOptions } from "../types";

const FOCUS_TEXT: Record<string, string> = {
  vulnerabilities: "Security vulnerabilities: injection, authz/authn flaws, secret leaks, unsafe deserialization, SSRF, path traversal, dependency risks.",
  major: "Major correctness issues: logic bugs, race conditions, data loss, broken error handling, incorrect API usage.",
  minor: "Minor issues: edge cases, missing validation, poor naming that causes confusion, dead code, missing tests for new logic.",
  nits: "Nits only: style, formatting, tiny wording improvements. Do NOT report anything above nit level.",
  full: "Everything above, plus a concise PR overview section explaining what this PR does.",
};

export function buildPrompt(bundle: PrBundle, options: ReviewOptions, repoContext: string | null) {
  const system = [
    "You are squanchy, a precise senior code reviewer. Review the pull request diff and report findings.",
    "Focus areas for this review:",
    ...options.intensities.map((i) => `- ${FOCUS_TEXT[i]}`),
    "Rules:",
    "- Only report issues you can ground in the diff. Cite file path and the line number in the NEW file version (from the hunk header). Use line: null if the finding is not tied to one line.",
    "- severity must match the focus area it belongs to (vulnerability|major|minor|nit|info).",
    "- If nothing to report, return an empty findings array. Do not invent issues.",
    "- Respond ONLY with JSON: {\"overview\": string|null, \"findings\": [{\"severity\": ..., \"file\": ..., \"line\": ..., \"comment\": ..., \"suggestion\": ...}]}",
    "- overview is null unless the 'full' focus is active or the user supplied an overview request.",
  ].join("\n");

  const user = [
    repoContext ? `# Repository context\n${repoContext}\n` : "",
    `# PR\nrepo: ${bundle.repo}\nnumber: ${bundle.prNumber}\ntitle: ${bundle.title}\nauthor: ${bundle.author}\n`,
    bundle.body ? `description:\n${bundle.body}\n` : "",
    options.overview ? `user-provided PR overview (treat as ground truth):\n${options.overview}\n` : "",
    "# Diff\n",
    ...bundle.files.map((f) => `## ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n\`\`\`diff\n${f.patch ?? "(binary or no patch)"}\n\`\`\`\n`),
  ].filter(Boolean).join("\n");

  return { system, user };
}
```

`tests/prompt.test.ts`: build a fake `PrBundle` fixture (in `tests/fixtures/pr-bundle.ts`) and assert: (a) system prompt contains the focus text for each requested intensity and NOT for unrequested ones, (b) user prompt contains every file path and patch, (c) user-provided overview appears verbatim. Run -> FAIL -> implement -> PASS.

`src/review/parse.ts`:

```ts
import { ReviewResultSchema, type ReviewResult } from "../types";

export function parseReviewResult(raw: string): ReviewResult {
  // strip ```json fences if the model added them despite instructions
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return ReviewResultSchema.parse(JSON.parse(cleaned));
}
```

`tests/parse.test.ts`: (a) clean JSON parses, (b) fenced JSON parses, (c) wrong severity value throws, (d) line:null allowed, (e) findings whose `file` is not in the bundle's file list are dropped by a wrapper `filterFindingsToDiff(result, bundle)` (test: finding on `ghost.ts` dropped, real file kept). Run -> FAIL -> implement -> PASS. Commit.

## Task 1.7: Orchestrator runReview (src/review/run.ts) - TDD with dependency injection

```ts
import type { Octokit } from "@octokit/rest";
import { fetchPrBundle } from "../github/pr";
import { buildPrompt } from "./prompt";
import { parseReviewResult, filterFindingsToDiff } from "./parse";
import type { ReviewOptions, ReviewResult } from "../types";

export interface RunReviewDeps {
  octokit: Octokit;
  chat: (args: { apiKey: string; model: string; system: string; user: string }) => Promise<string>;
  apiKey: string;
  readRepoContext: () => string | null;   // reads .squanchy/context.md if present
  postReview: (bundle: Awaited<ReturnType<typeof fetchPrBundle>>, result: ReviewResult) => Promise<{ htmlUrl: string }>;
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const bundle = await fetchPrBundle(deps.octokit, options.repo, options.prNumber);
  const { system, user } = buildPrompt(bundle, options, deps.readRepoContext());
  let raw: string;
  try {
    raw = await deps.chat({ apiKey: deps.apiKey, model: options.model, system, user });
  } catch (e) {
    throw new Error(`LLM call failed: ${(e as Error).message}`);
  }
  let result: ReviewResult;
  try {
    result = filterFindingsToDiff(parseReviewResult(raw), bundle);
  } catch {
    // one retry with a stricter reminder
    raw = await deps.chat({ apiKey: deps.apiKey, model: options.model, system, user: user + "\n\nYour previous response was not valid JSON per the schema. Respond with ONLY the JSON object." });
    result = filterFindingsToDiff(parseReviewResult(raw), bundle);
  }
  if (options.mode === "review") {
    const posted = await deps.postReview(bundle, result);
    result.overview = (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}`;
  }
  return result;
}
```

`tests/run.test.ts`: inject a fake octokit (stub `pulls.get` + `paginate.iterator` returning `tests/fixtures/pr-bundle.ts` data), a fake `chat` returning canned JSON, a spy `postReview`. Assert: (a) report mode never calls postReview, (b) review mode calls it once, (c) invalid first response + valid retry response succeeds and chat called twice, (d) both invalid -> throws. Run -> FAIL -> implement -> PASS. Commit.

## Task 1.8: Posting reviews (src/github/pr.ts addition)

Append to `src/github/pr.ts`:

```ts
import type { ReviewResult } from "../types";

export async function postPrReview(
  octokit: Octokit, bundle: PrBundle, result: ReviewResult,
): Promise<{ htmlUrl: string }> {
  const [owner, repo] = bundle.repo.split("/");
  const comments = result.findings
    .filter((f) => f.line !== null)
    .map((f) => ({
      path: f.file,
      line: f.line!,
      side: "RIGHT" as const,
      body: `**[${f.severity}]** ${f.comment}${f.suggestion ? `\n\nSuggestion:\n\`\`\`\n${f.suggestion}\n\`\`\`` : ""}\n\n<sub>squanchy 🐱</sub>`,
    }));
  const summary = [
    result.overview ? `### Overview\n${result.overview}\n` : "",
    `### squanchy review: ${result.findings.length} finding(s)`,
    ...result.findings.filter((f) => f.line === null)
      .map((f) => `- **[${f.severity}]** \`${f.file}\`: ${f.comment}`),
    "\n<sub>AI-generated review. You are always in control of approving this PR.</sub>",
  ].filter(Boolean).join("\n");

  const { data } = await octokit.pulls.createReview({
    owner, repo, pull_number: bundle.prNumber,
    commit_id: bundle.headSha,
    event: "COMMENT",
    body: summary,
    comments,
  });
  return { htmlUrl: data.html_url };
}
```

Pitfall for the implementer: GitHub rejects inline comments whose line is not part of the diff. Mitigation: before posting, validate each comment's line against the bundle's patch hunk headers (parse `@@ -a,b +c,d @@` ranges into a Set of valid new-file lines per file; drop findings outside the set and move them into the summary body as file-level bullets). Write this as a pure exported function `linesInDiff(patch: string): Set<number>` in `src/github/pr.ts` with a unit test (`tests/diff-lines.test.ts`: patch `@@ -1,3 +1,4 @@` followed by 4 lines -> set {1,2,3,4} counting context/added lines on the new side). TDD it. Commit.

## Task 1.9: Terminal report renderer (src/report/render.ts) - TDD

```ts
import type { ReviewResult } from "../types";

const ICON = { vulnerability: "🔴", major: "🟠", minor: "🟡", nit: "⚪", info: "🔵" } as const;

export function renderReport(result: ReviewResult): string {
  const lines: string[] = [];
  if (result.overview) lines.push(`OVERVIEW\n${result.overview}\n`);
  if (result.findings.length === 0) lines.push("No findings. LGTM 🐱");
  const order = ["vulnerability", "major", "minor", "nit", "info"] as const;
  for (const sev of order) {
    const fs = result.findings.filter((f) => f.severity === sev);
    for (const f of fs) {
      lines.push(`${ICON[sev]} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`   ${f.comment}`);
      if (f.suggestion) lines.push(`   suggestion: ${f.suggestion}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
```

Test: canned ReviewResult -> exact expected string (snapshot or toContain assertions on ordering: vulnerabilities before nits). TDD. Commit.

## Task 1.10: CLI wiring (src/cli.ts) - the two commands

Replace `src/cli.ts`:

```ts
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config";
import { parseIntensities, DEFAULT_INTENSITIES } from "./review/intensity";
import { runReview } from "./review/run";
import { chat } from "./openrouter/client";
import { postPrReview, fetchPrBundle } from "./github/pr";
import { renderReport } from "./report/render";
import type { Mode, ReviewOptions } from "./types";

const program = new Command();
program.name("squanchy").description("AI code review for PRs").version("0.1.0");

function parsePrArg(arg: string): { repo: string; prNumber: number } {
  // accepts "owner/repo#123", "123" (uses repo from git remote), or full URL
  const url = arg.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], prNumber: Number(url[2]) };
  const hash = arg.match(/^([^#]+)#(\d+)$/);
  if (hash) return { repo: hash[1], prNumber: Number(hash[2]) };
  if (/^\d+$/.test(arg)) return { repo: detectRepoFromGitRemote(), prNumber: Number(arg) };
  throw new Error(`Cannot parse PR argument: ${arg}`);
}

function detectRepoFromGitRemote(): string {
  const cfg = readFileSync(".git/config", "utf8");
  const m = cfg.match(/url\s*=\s*(?:.*github\.com[:/])([^/\s]+\/[^/\s.]+)/);
  if (!m) throw new Error("Could not detect repo from .git/config; pass owner/repo#N");
  return m[1];
}

program
  .command("review")
  .argument("<pr>", 'PR: "owner/repo#123", "123", or full GitHub URL')
  .option("-m, --model <model>", "openrouter model id")
  .option("-i, --intensity <list>", "csv: vulnerabilities,major,minor,nits,full")
  .option("--mode <mode>", "report | review", "report")
  .option("--overview <text>", "brief explanation of what the PR is about")
  .action(async (prArg: string, opts: any) => {
    const cfg = loadConfig({
      globalDir: join(homedir(), ".config", "squanchy"),
      repoDir: process.cwd(),
      env: process.env as Record<string, string>,
    });
    if (!cfg.openrouterApiKey) throw new Error("Missing OpenRouter API key: set OPENROUTER_API_KEY or run `squanchy init`");
    if (!cfg.githubToken) throw new Error("Missing GitHub token: set GITHUB_TOKEN or run `squanchy init`");
    const { repo, prNumber } = parsePrArg(prArg);
    const mode = (opts.mode ?? "report") as Mode;
    if (mode !== "report" && mode !== "review") throw new Error(`Unknown mode: ${mode}`);
    const options: ReviewOptions = {
      repo, prNumber, mode,
      model: opts.model ?? cfg.defaultModel,
      intensities: opts.intensity ? parseIntensities(opts.intensity) : cfg.defaultIntensities ?? DEFAULT_INTENSITIES,
      overview: opts.overview,
    };
    const octokit = new Octokit({ auth: cfg.githubToken });
    const result = await runReview(options, {
      octokit,
      chat,
      apiKey: cfg.openrouterApiKey!,
      readRepoContext: () =>
        existsSync(".squanchy/context.md") ? readFileSync(".squanchy/context.md", "utf8") : null,
      postReview: (bundle, res) => postPrReview(octokit, bundle, res),
    });
    console.log(renderReport(result));
  });

program.parse();
```

Wrap the `.action` body's errors: add `program.exitOverride()` or a top-level try/catch in `bin/squanchy.ts` printing `error: <message>` and `process.exitCode = 1` instead of stack traces.

Verification (manual, needs real keys):

```bash
export OPENROUTER_API_KEY=*** GITHUB_TOKEN=***
bun run dev review https://github.com/oven-sh/bun/pull/1 --mode report --intensity major
# expect: terminal report, no GitHub side effects
```

Commit.

## Task 1.11: `squanchy init` command (src/init/*) - TDD for detection

`src/init/detect-stack.ts` (pure, testable):

```ts
export interface StackInfo {
  languages: string[];      // e.g. ["typescript"]
  frameworks: string[];     // e.g. ["next.js", "react"]
  packageManager: string | null;  // "bun" | "npm" | "pnpm" | "yarn"
  testFramework: string | null;
  notableFiles: string[];   // config files found
}

export function detectStack(fileList: string[], packageJson: unknown | null): StackInfo { ... }
```

Heuristics: `bun.lockb`/`bun.lock` -> bun; `pnpm-lock.yaml` -> pnpm; `yarn.lock` -> yarn; `package-lock.json` -> npm. Frameworks from packageJson dependencies (`next` -> next.js, `react`, `vue`, `express`, `hono`, ...). Languages from extensions (`.ts` -> typescript, `.py` -> python, `.go` -> go, `.rs` -> rust). Test with fixture file lists. TDD.

`src/init/profile.ts`: `squanchy init` flow:

1. Prompt interactively (or accept flags `--openrouter-key`, `--github-token`, `--model`, `--intensity`) for secrets + defaults; write secrets to `~/.config/squanchy/config.json` (0o600) via `saveGlobalConfig`, non-secret defaults to `.squanchy/config.json`.
2. Walk repo files (respect `.gitignore` via `Bun.Glob` + skip `node_modules`, `.git`), cap at 2000 files, run `detectStack`.
3. Build a compact tree (dirs + top-level files + key config file contents: package.json, tsconfig.json) and send ONE OpenRouter chat call: "Summarize this repository's tech stack, architecture, and conventions a code reviewer must know. Be concise (<400 words), markdown." Save answer + detected stack to `.squanchy/context.md` with a header `<!-- generated by squanchy init; regenerate with squanchy init -->`.
4. Print next steps.

CLI: add `program.command("init")` in `src/cli.ts` with the flags above. If keys already present in env, skip the prompts for them.

Verification (manual): run `bun run dev init` in this repo with a real OpenRouter key; expect `.squanchy/context.md` created containing a bun/typescript mention, and `~/.config/squanchy/config.json` with mode 600 (`ls -l` shows `-rw-------`). Commit.

## Task 1.12: README + Phase 1 polish

Update `README.md`: what squanchy is, install (`bun install && bun link`), `squanchy init`, `squanchy review <pr> [--mode report|review] [-m model] [-i intensities] [--overview text]`, config precedence (flags > env > repo config > global config > defaults), intensity table, disclaimer that squanchy never approves/merges. Commit: `git commit -am "docs: phase 1 CLI"`. Tag: `git tag v0.1.0-cli` (do not push without user confirmation).

---

# PHASE 2: GitHub bot (only after Phase 1 is validated by the user)

## Task 2.1: Command parser (src/bot/commands.ts) - TDD, pure function

Parses PR comment bodies into `ReviewOptions`:

```ts
export function parseBotCommand(commentBody: string, repo: string, prNumber: number, cfg: SquanchyConfig): ReviewOptions | null
```

Grammar (all on lines starting with `/squanchy`):

- `/squanchy review` -> default intensities, mode `review`
- `/squanchy review --intensity nits --model openai/gpt-5`
- `/squanchy full` -> intensities = full expansion
- `/squanchy overview: <free text on following lines>` -> sets `options.overview`
- Anything not starting with `/squanchy` -> null (bot ignores)

Tests: table of ~10 comment bodies -> expected ReviewOptions/null. TDD. Commit.

## Task 2.2: Webhook server (src/bot/server.ts)

Hono app, Bun.serve. Handles `POST /webhook`:

1. Verify `x-hub-signature-256` with the GitHub App webhook secret (`crypto.timingSafeEqual` over HMAC-SHA256 of raw body). Reject 401 on mismatch.
2. Only act on `action === "created"` for `issue_comment` where `issue.pull_request` exists AND comment author is not the bot itself.
3. `parseBotCommand` -> if null, 200 no-op.
4. Otherwise: add `+1` reaction to the comment (ack), installationToken auth (Task 2.3), run `runReview` with mode forced to `"review"`, reply with a short confirmation comment containing the review URL. On error, reply with the error message.
5. Always respond 200 fast: do the review in a `Promise` fired after responding (Bun: `event.waitUntil` style or just don't await; guard with try/catch).

Env config: `SQUANCHY_APP_ID`, `SQUANCHY_PRIVATE_KEY` (PEM), `SQUANCHY_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`.

Verification: unit-test signature verification with a known HMAC fixture; integration-test locally with `smee` or by curling the local server with a correctly signed payload built in the test (`tests/bot.test.ts` uses `app.request()` from Hono directly, no network). Commit.

## Task 2.3: GitHub App auth

Use `@octokit/auth-app` (add dependency): authenticate as App, exchange installation id (from webhook payload `installation.id`) for an installation token, construct per-request Octokit. Never store long-lived tokens. Document App creation steps in README: create GitHub App, permissions (pull requests: write; contents: read; metadata: read), subscribe to `issue_comment`, generate keypair (`ssh-keygen -t rsa -b 4096 -m PEM` -> use with `crypto.createPrivateKey`), webhook URL (smee for dev).

## Task 2.4: Deploy story

Out of scope for code, but plan the shape: the bot is a Bun server deployable anywhere (fly.io / a VPS / Railway). Add `Dockerfile` (FROM oven/bun, `bun install --frozen-lockfile`, CMD `bun run src/bot/server.ts`) and a `deploy` section in README. Commit.

---

## Tests / validation summary

- `bun test` must pass at every commit (all tests are offline: fixtures for GitHub payloads, injected fake `chat`, signed-payload fixtures for the webhook).
- `bun run typecheck` clean at every commit.
- Manual smoke checklist at end of Phase 1 (with real keys, on a real PR in a scratch repo):
  1. `squanchy init` creates `~/.config/squanchy/config.json` (0600) + `.squanchy/context.md`.
  2. `squanchy review <pr> --mode report` prints findings, PR on GitHub is untouched (verify: no new comments/reviews on the PR page).
  3. `squanchy review <pr> --mode review` posts exactly one COMMENT review with inline comments only on lines present in the diff.
  4. `--intensity nits` yields only nit-severity findings or none.
- Phase 2 smoke: comment `/squanchy review` on a PR from a second account; bot reacts 👍 and posts the review.

## Risks, tradeoffs, open questions

Risks:
- Inline-comment line validation is the #1 source of `422` errors from `createReview`; Task 1.8's `linesInDiff` guard is mandatory, not optional.
- Large PRs blow context windows; the 150k-char diff budget truncates rather than chunks. Chunked multi-pass review is a later enhancement (YAGNI now).
- Models vary in JSON adherence; `response_format: json_object` + zod + one retry covers most, but some OpenRouter models ignore `response_format`. Fallback path is the retry prompt.
- Node v12 on this machine is irrelevant once Bun is installed, but any tooling assuming system node will break; pin everything through Bun scripts.

Open questions (decide before/while implementing, do NOT guess silently):
1. Spec mentions init creating "skills, tech stack docs, plugins". This plan reduces that to one generated `.squanchy/context.md` (simplest useful thing). Confirm that's acceptable for v1, or scope the richer system separately.
2. "Review intensity" naming: user suggested finding a better word. Alternatives: `--focus`, `--depth`, `--scope`. Plan keeps `intensity` until decided.
3. Default model pinned to `anthropic/claude-sonnet-4.5` on OpenRouter; user should confirm or pick another.
4. Bot deployment target (fly.io? VPS?) affects Task 2.4 details.
5. Bun assumed over npm per user preference; confirm.
