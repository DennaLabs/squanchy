# Squanchy: AI code-review CLI + GitHub Action (rev 2)

Supersedes 2026-09-16_123147-squanchy-code-review-cli-bot.md (rev 1, pre-decisions).

## Goal

Build "squanchy" (the cat-ish thing from Rick and Morty): a TypeScript CLI plus a GitHub Action that performs LLM-powered code reviews of pull requests via OpenRouter, driven by PR comments (Action) or terminal commands (CLI), with configurable model, review mode (report/review), and review depth (vulnerabilities/major/minor/nits/full).

## Decisions locked with the user (2026-09-16)

- Phase 2 is a GitHub Action triggered by PR comments, NOT a hosted webhook bot. No server, no GitHub App.
- Init-generated repo context lives in `.squanchy/context.md`, committed in the user's repo. No skills/plugins system in v1.
- The word is "depth" (was "intensity"). CLI flag `--depth`/`-d`.
- Default model: `nvidia/nemotron-3-ultra-550b-a55b:free` (verified against OpenRouter /models on 2026-09-16: largest free model, 1M context). Changing it later = one constant in `src/config.ts`.
- Bun + TypeScript. Confirmed.

## Current context / assumptions

- Repo `/home/ph/projects/squanchy` is empty (README.md + first commit on `main`).
- Runtime: Bun is NOT installed; system node is v12 (too old for anything). Task 1.1 installs Bun; Bun ships its own runtime/test-runner, so system node is irrelevant after that.
- Libraries: `commander` (CLI), `zod` (schemas), `@octokit/rest` (GitHub API). OpenRouter via plain `fetch` (OpenAI-compatible `/chat/completions`), no SDK.
- Secrets (OpenRouter key, GitHub PAT) live in `~/.config/squanchy/config.json` (chmod 600) or env vars `OPENROUTER_API_KEY` / `GITHUB_TOKEN`. Non-secret defaults (model, depth) may also live per-repo in `.squanchy/config.json`. In the Action, `GITHUB_TOKEN` is the workflow-provided token.
- Precedence everywhere: CLI flags > env vars > repo `.squanchy/config.json` > global config > built-in defaults.
- Review output contract: the LLM must return strict JSON matching a zod schema; parse failure triggers exactly one retry, then a hard error (never post a malformed review).
- Depth default when unspecified: `["vulnerabilities", "major"]`. Depth is a SET: `--depth vulnerabilities,major`. `full` expands to all focuses + a PR-overview section.
- Phasing: Phase 1 = CLI end-to-end. Phase 2 = GitHub Action. User validates Phase 1 before Phase 2 starts.

## Architecture

A review is a pure pipeline: `resolve options -> fetch PR (octokit) -> load repo context -> build prompt -> call OpenRouter -> parse findings JSON -> render (report) OR post review (review)`. Every stage is a small module with a typed interface, unit-tested against fixtures; the CLI and the Action are thin adapters over the same `runReview()` orchestrator in `src/review/run.ts`. The Action entry (`src/action/main.ts`) reads the triggering comment + PR URL from env, parses `/squanchy ...` into `ReviewOptions`, and always runs mode `review`.

```
squanchy/
  package.json  tsconfig.json  .gitignore  README.md  action.yml
  bin/squanchy.ts            # shebang entry -> src/cli.ts
  src/
    cli.ts                   # commander program (review, init)
    types.ts                 # zod schemas + inferred types (single source of truth)
    config.ts                # load/merge/save config (global + repo + env + flags)
    github/pr.ts             # fetchPrBundle(), postPrReview(), linesInDiff(), enforceDiffBudget()
    openrouter/client.ts     # chat() with json_object enforcement
    review/depth.ts          # Depth -> prompt focus text, parseDepths()
    review/prompt.ts         # buildPrompt(bundle, options, context)
    review/parse.ts          # raw LLM text -> ReviewResult (zod)
    review/run.ts            # runReview(options, deps): orchestrator
    report/render.ts         # ReviewResult -> terminal report string
    init/detect-stack.ts     # file/package.json heuristics -> StackInfo
    init/profile.ts          # StackInfo -> .squanchy/context.md (LLM-assisted)
    action/command.ts        # Phase 2: comment text -> ReviewOptions
    action/main.ts           # Phase 2: Action entrypoint (env in, review out)
  examples/squanchy.yml      # Phase 2: copy-paste workflow for user repos
  tests/                     # *.test.ts, bun test, fixtures/ for GitHub + LLM payloads
```

---

# PHASE 1: CLI

## Task 1.1: Install Bun, scaffold project

```bash
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
bun --version          # expect: 1.2.x or newer
cd /home/ph/projects/squanchy
bun init -y
```

Overwrite `package.json`:

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
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "typescript": "^5.6.0"
  }
}
```

Replace `tsconfig.json`:

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
```

(`.squanchy/context.md` IS committed per user decision, so it is not ignored.)

Create `bin/squanchy.ts`:

```ts
#!/usr/bin/env bun
import "../src/cli";
```

Delete bun-init boilerplate (`index.ts`, sample test) if generated. Stub `src/cli.ts` so typecheck passes:

```ts
import { Command } from "commander";
const program = new Command();
program.name("squanchy").description("AI code review for PRs").version("0.1.0");
program.parse();
```

Verify:

```bash
bun install            # exit 0
bun run typecheck      # no errors
bun run dev -- --help  # prints usage containing "squanchy"
```

Commit: `git add -A && git commit -m "scaffold: bun + ts project"`.

## Task 1.2: Core types + depth parsing - TDD

Write `tests/depth.test.ts` FIRST:

```ts
import { describe, expect, test } from "bun:test";
import { parseDepths, DEFAULT_DEPTHS } from "../src/review/depth";

describe("parseDepths", () => {
  test("parses csv list", () => {
    expect(parseDepths("vulnerabilities,major")).toEqual(["vulnerabilities", "major"]);
  });
  test("rejects unknown", () => {
    expect(() => parseDepths("vulnerabilities,bogus")).toThrow();
  });
  test("default is vulnerabilities+major", () => {
    expect(DEFAULT_DEPTHS).toEqual(["vulnerabilities", "major"]);
  });
  test("full expands to everything", () => {
    expect(parseDepths("full")).toEqual(["vulnerabilities", "major", "minor", "nits", "full"]);
  });
});
```

Run `bun test` -> expect FAIL (module not found). Create `src/types.ts`:

```ts
import { z } from "zod";

export const DEPTHS = ["vulnerabilities", "major", "minor", "nits", "full"] as const;
export const DepthSchema = z.enum(DEPTHS);
export type Depth = z.infer<typeof DepthSchema>;

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
  depths: Depth[];
  overview?: string;       // user-supplied PR overview text
}

export interface SquanchyConfig {
  openrouterApiKey?: string;
  githubToken?: string;
  defaultModel: string;
  defaultDepths: Depth[];
}
```

Create `src/review/depth.ts`:

```ts
import { DepthSchema, type Depth } from "../types";

export const DEFAULT_DEPTHS: Depth[] = ["vulnerabilities", "major"];

export function parseDepths(raw: string): Depth[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const parsed = parts.map((p) => DepthSchema.parse(p));
  if (parsed.includes("full")) {
    return ["vulnerabilities", "major", "minor", "nits", "full"];
  }
  return [...new Set(parsed)];
}
```

Run `bun test` -> 4 pass. Commit: `git commit -am "types + depth parsing"`.

## Task 1.3: Config load/save (src/config.ts) - TDD

`tests/config.test.ts` FIRST:

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
      defaultModel: "global-model", defaultDepths: ["minor"], githubToken: "***" }));
    writeFileSync(join(dir, "repo", ".squanchy", "config.json"), JSON.stringify({
      defaultModel: "repo-model" }));
    const cfg = loadConfig({
      globalDir, repoDir: join(dir, "repo"),
      env: { OPENROUTER_API_KEY: "***" },
    });
    expect(cfg.defaultModel).toBe("repo-model");
    expect(cfg.defaultDepths).toEqual(["minor"]);
    expect(cfg.openrouterApiKey).toBe("env-key");
    expect(cfg.githubToken).toBe("global-token");
  });
  test("works with no files at all (built-in defaults)", () => {
    const cfg = loadConfig({ globalDir: "/nonexistent", repoDir: "/nonexistent", env: {} });
    expect(cfg.defaultModel).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(cfg.defaultDepths).toEqual(["vulnerabilities", "major"]);
  });
});
```

Run -> FAIL. Implement `src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_DEPTHS, parseDepths } from "./review/depth";
import type { SquanchyConfig } from "./types";

export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const FileSchema = z.object({
  openrouterApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultDepths: z.array(z.string()).optional(),
});

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface LoadConfigArgs {
  globalDir: string;   // ~/.config/squanchy
  repoDir: string;     // cwd (repo root)
  env: Record<string, string | undefined>;
}

export function loadConfig({ globalDir, repoDir, env }: LoadConfigArgs): SquanchyConfig {
  const g = FileSchema.parse(readJsonIfExists(join(globalDir, "config.json")));
  const r = FileSchema.parse(readJsonIfExists(join(repoDir, ".squanchy", "config.json")));
  const rawDepths = r.defaultDepths ?? g.defaultDepths;
  return {
    openrouterApiKey: env.OPENROUTER_API_KEY ?? g.openrouterApiKey,
    githubToken: env.GITHUB_TOKEN ?? g.githubToken,
    defaultModel: r.defaultModel ?? g.defaultModel ?? DEFAULT_MODEL,
    defaultDepths: rawDepths ? parseDepths(rawDepths.join(",")) : DEFAULT_DEPTHS,
  };
}

export function saveGlobalConfig(globalDir: string, cfg: Partial<SquanchyConfig>): void {
  mkdirSync(globalDir, { recursive: true });
  const path = join(globalDir, "config.json");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...existing, ...cfg }, null, 2), { mode: 0o600 });
}
```

Note: secrets are read only from the GLOBAL config or env, never from repo config (a committed `.squanchy/config.json` must not carry keys; document this in README).

Run `bun test` -> PASS. Commit.

## Task 1.4: GitHub PR fetching (src/github/pr.ts) - TDD for the pure parts

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
  truncated: boolean;
}

export async function fetchPrBundle(octokit: Octokit, repo: string, prNumber: number): Promise<PrBundle> {
  const [owner, name] = repo.split("/");
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  const raw: PrFile[] = [];
  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner, repo: name, pull_number: prNumber, per_page: 100,
  })) {
    for (const f of page.data) {
      raw.push({
        path: f.filename,
        status: f.status as PrFile["status"],
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
  }
  const { files, truncated } = enforceDiffBudget(raw, MAX_DIFF_CHARS);
  return {
    repo, prNumber, title: pr.title, body: pr.body,
    author: pr.user?.login ?? "unknown",
    baseSha: pr.base.sha, headSha: pr.head.sha,
    files, truncated,
  };
}
```

Plus two exported pure functions, each TDD'd BEFORE implementation:

1. `enforceDiffBudget(files: PrFile[], maxChars: number): { files: PrFile[]; truncated: boolean }` with `MAX_DIFF_CHARS = 150_000`. Rule: iterate files in order, keep whole patches while budget lasts; the file that would overflow keeps a truncated patch (prefix + marker `\n... [squanchy: patch truncated]`); later files get `patch: undefined`. Test in `tests/pr.test.ts`: 3 files x 60k chars, budget 100k -> first kept whole, second truncated, third patch-less, `truncated: true`; small PR -> untouched, `truncated: false`.
2. `linesInDiff(patch: string): Set<number>` - parse `@@ -a,b +c,d @@` hunk headers and walk lines counting context (` `) and added (`+`) lines to build the set of valid NEW-file line numbers. Test in `tests/diff-lines.test.ts`: patch with header `@@ -1,3 +10,4 @@` followed by lines ` ctx`, `+added`, ` ctx`, `-removed` -> set `{10, 11, 12}` (the removed line does not consume a new-side number). This guard prevents GitHub 422s in Task 1.8.

Live smoke (manual, not automated): `scripts/smoke-fetch.ts` reads `GITHUB_TOKEN` from env, calls `fetchPrBundle(octokit, "oven-sh/bun", 1)`, prints `title: ... files: N`. Expected: N > 0.

Run `bun test` -> PASS. Commit.

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

No unit test for the network call; it is exercised via injected fakes in Task 1.7. Commit.

## Task 1.6: Prompt building + result parsing - TDD

`src/review/prompt.ts`:

```ts
import type { PrBundle } from "../github/pr";
import type { ReviewOptions } from "../types";

const FOCUS_TEXT: Record<string, string> = {
  vulnerabilities: "Security vulnerabilities: injection, authz/authn flaws, secret leaks, unsafe deserialization, SSRF, path traversal, dependency risks.",
  major: "Major correctness issues: logic bugs, race conditions, data loss, broken error handling, incorrect API usage.",
  minor: "Minor issues: edge cases, missing validation, confusing naming, dead code, missing tests for new logic.",
  nits: "Nits only: style, formatting, tiny wording improvements. Do NOT report anything above nit level.",
  full: "Everything above, plus a concise PR overview section explaining what this PR does.",
};

export function buildPrompt(bundle: PrBundle, options: ReviewOptions, repoContext: string | null) {
  const system = [
    "You are squanchy, a precise senior code reviewer. Review the pull request diff and report findings.",
    "Focus areas for this review:",
    ...options.depths.map((d) => `- ${FOCUS_TEXT[d]}`),
    "Rules:",
    "- Only report issues grounded in the diff. Cite file path and the line number in the NEW file version (derive it from the hunk header). Use line: null if the finding is not tied to one line.",
    "- severity must be one of: vulnerability | major | minor | nit | info, matching the focus area.",
    "- If nothing to report, return an empty findings array. Do not invent issues.",
    '- Respond ONLY with JSON: {"overview": string|null, "findings": [{"severity": ..., "file": ..., "line": ..., "comment": ..., "suggestion": ...}]}',
    "- overview is null unless the 'full' focus is active.",
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

`tests/prompt.test.ts` (fixture bundle in `tests/fixtures/pr-bundle.ts`): (a) system contains focus text for each requested depth and NOT for unrequested ones, (b) user contains every file path + patch, (c) user-provided overview appears verbatim, (d) repoContext appears when non-null. TDD.

`src/review/parse.ts`:

```ts
import { ReviewResultSchema, type ReviewResult } from "../types";
import type { PrBundle } from "../github/pr";

export function parseReviewResult(raw: string): ReviewResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return ReviewResultSchema.parse(JSON.parse(cleaned));
}

export function filterFindingsToDiff(result: ReviewResult, bundle: PrBundle): ReviewResult {
  const known = new Set(bundle.files.map((f) => f.path));
  return { ...result, findings: result.findings.filter((f) => known.has(f.file)) };
}
```

`tests/parse.test.ts`: (a) clean JSON parses, (b) fenced JSON parses, (c) bad severity throws, (d) `line: null` allowed, (e) `filterFindingsToDiff` drops findings on files not in the bundle. TDD. Commit.

## Task 1.7: Orchestrator runReview (src/review/run.ts) - TDD with dependency injection

```ts
import type { Octokit } from "@octokit/rest";
import { fetchPrBundle, type PrBundle } from "../github/pr";
import { buildPrompt } from "./prompt";
import { parseReviewResult, filterFindingsToDiff } from "./parse";
import type { ReviewOptions, ReviewResult } from "../types";

export interface RunReviewDeps {
  octokit: Octokit;
  chat: (args: { apiKey: string; model: string; system: string; user: string }) => Promise<string>;
  apiKey: string;
  readRepoContext: () => string | null;
  postReview: (bundle: PrBundle, result: ReviewResult) => Promise<{ htmlUrl: string }>;
}

export async function runReview(options: ReviewOptions, deps: RunReviewDeps): Promise<ReviewResult> {
  const bundle = await fetchPrBundle(deps.octokit, options.repo, options.prNumber);
  const { system, user } = buildPrompt(bundle, options, deps.readRepoContext());
  const raw = await deps.chat({ apiKey: deps.apiKey, model: options.model, system, user });
  let result: ReviewResult;
  try {
    result = filterFindingsToDiff(parseReviewResult(raw), bundle);
  } catch {
    const retry = await deps.chat({
      apiKey: deps.apiKey, model: options.model, system,
      user: user + "\n\nYour previous response was not valid JSON per the schema. Respond with ONLY the JSON object.",
    });
    result = filterFindingsToDiff(parseReviewResult(retry), bundle);
  }
  if (options.mode === "review") {
    const posted = await deps.postReview(bundle, result);
    result = { ...result, overview: (result.overview ?? "") + `\n\nPosted: ${posted.htmlUrl}` };
  }
  return result;
}
```

`tests/run.test.ts`: fake octokit (stubs for `pulls.get` + `paginate.iterator` returning the fixture), fake `chat` returning canned JSON, spy `postReview`. Assert: (a) report mode never calls postReview, (b) review mode calls it once, (c) invalid first + valid retry -> success, chat called twice, (d) both invalid -> throws. TDD. Commit.

## Task 1.8: Posting reviews (append to src/github/pr.ts)

```ts
import type { ReviewResult } from "../types";

export async function postPrReview(
  octokit: Octokit, bundle: PrBundle, result: ReviewResult,
): Promise<{ htmlUrl: string }> {
  const [owner, repo] = bundle.repo.split("/");
  const validLines = new Map(bundle.files.map((f) => [f.path, f.patch ? linesInDiff(f.patch) : new Set<number>()]));
  const inline = [];
  const fileLevel = [];
  for (const f of result.findings) {
    const ok = f.line !== null && (validLines.get(f.file)?.has(f.line) ?? false);
    if (ok) {
      inline.push({
        path: f.file,
        line: f.line!,
        side: "RIGHT" as const,
        body: `**[${f.severity}]** ${f.comment}${f.suggestion ? `\n\nSuggestion:\n\`\`\`\n${f.suggestion}\n\`\`\`` : ""}\n\n<sub>squanchy</sub>`,
      });
    } else {
      fileLevel.push(`- **[${f.severity}]** \`${f.file}${f.line ? `:${f.line}` : ""}\`: ${f.comment}`);
    }
  }
  const body = [
    result.overview ? `### Overview\n${result.overview}\n` : "",
    `### squanchy review: ${result.findings.length} finding(s)`,
    ...fileLevel,
    "\n<sub>AI-generated review. You are always in control of approving this PR.</sub>",
  ].filter(Boolean).join("\n");

  const { data } = await octokit.pulls.createReview({
    owner, repo, pull_number: bundle.prNumber,
    commit_id: bundle.headSha,
    event: "COMMENT",
    body,
    comments: inline,
  });
  return { htmlUrl: data.html_url };
}
```

Critical pitfall (why `linesInDiff` filtering is mandatory): GitHub returns 422 if ANY inline comment line is outside the diff. Findings that fail validation are demoted to file-level bullets in the review body, never dropped silently.

Test `postPrReview` with a fake octokit capturing the `createReview` payload: finding on a valid diff line -> inline; finding on line 9999 -> in body bullets; `event` is always `"COMMENT"` (squanchy NEVER approves or requests changes). Commit.

## Task 1.9: Terminal report renderer (src/report/render.ts) - TDD

```ts
import type { ReviewResult } from "../types";

const ICON = { vulnerability: "R", major: "!", minor: "-", nit: ".", info: "i" } as const;

export function renderReport(result: ReviewResult): string {
  const lines: string[] = [];
  if (result.overview) lines.push(`OVERVIEW\n${result.overview}\n`);
  if (result.findings.length === 0) lines.push("No findings. LGTM.");
  const order = ["vulnerability", "major", "minor", "nit", "info"] as const;
  for (const sev of order) {
    for (const f of result.findings.filter((x) => x.severity === sev)) {
      lines.push(`[${ICON[sev]}] ${sev.toUpperCase()} ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`    ${f.comment}`);
      if (f.suggestion) lines.push(`    suggestion: ${f.suggestion}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
```

(Plain ASCII markers, not emoji: renders reliably in every terminal and CI log. Easy to swap later if the user wants emoji.)

Test: canned ReviewResult -> vulnerabilities sorted before nits, file:line present, overview first. TDD. Commit.

## Task 1.10: CLI wiring (src/cli.ts)

Replace the stub `src/cli.ts`:

```ts
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config";
import { parseDepths, DEFAULT_DEPTHS } from "./review/depth";
import { runReview } from "./review/run";
import { chat } from "./openrouter/client";
import { postPrReview } from "./github/pr";
import { renderReport } from "./report/render";
import type { Mode, ReviewOptions } from "./types";

const program = new Command();
program.name("squanchy").description("AI code review for PRs").version("0.1.0");

function detectRepoFromGitRemote(): string {
  const cfg = readFileSync(".git/config", "utf8");
  const m = cfg.match(/url\s*=\s*(?:.*github\.com[:/])([^/\s]+\/[^/\s.]+)/);
  if (!m) throw new Error("Could not detect repo from .git/config; pass owner/repo#N");
  return m[1];
}

export function parsePrArg(arg: string): { repo: string; prNumber: number } {
  const url = arg.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], prNumber: Number(url[2]) };
  const hash = arg.match(/^([^#]+)#(\d+)$/);
  if (hash) return { repo: hash[1], prNumber: Number(hash[2]) };
  if (/^\d+$/.test(arg)) return { repo: detectRepoFromGitRemote(), prNumber: Number(arg) };
  throw new Error(`Cannot parse PR argument: ${arg}`);
}

program
  .command("review")
  .argument("<pr>", 'PR: "owner/repo#123", "123", or full GitHub URL')
  .option("-m, --model <model>", "openrouter model id")
  .option("-d, --depth <list>", "csv: vulnerabilities,major,minor,nits,full")
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
    const mode = opts.mode as Mode;
    if (mode !== "report" && mode !== "review") throw new Error(`Unknown mode: ${mode}`);
    const options: ReviewOptions = {
      repo, prNumber, mode,
      model: opts.model ?? cfg.defaultModel,
      depths: opts.depth ? parseDepths(opts.depth) : cfg.defaultDepths ?? DEFAULT_DEPTHS,
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

Wrap errors: in `bin/squanchy.ts`, try/catch the import, print `squanchy: error: <message>`, set `process.exitCode = 1` (no stack traces for expected errors).

Add `tests/cli-args.test.ts` for `parsePrArg` (exported): URL form, `owner/repo#N` form, bare number form (run inside a fixture dir containing a fake `.git/config`), garbage -> throws. TDD.

Manual verification (needs real keys):

```bash
export OPENROUTER_API_KEY=*** GITHUB_TOKEN=***
bun run dev review https://github.com/oven-sh/bun/pull/1 --mode report --depth major
# expect: terminal report with findings or "No findings. LGTM."; zero GitHub side effects
```

Commit.

## Task 1.11: `squanchy init` (src/init/*) - TDD for detection

`src/init/detect-stack.ts` (pure):

```ts
export interface StackInfo {
  languages: string[];           // ["typescript", "python", ...]
  frameworks: string[];          // from package.json deps: next, react, express, hono, ...
  packageManager: string | null; // bun | pnpm | yarn | npm (from lockfiles)
  testFramework: string | null;  // jest | vitest | bun:test | pytest | ...
  notableFiles: string[];        // config files found (tsconfig.json, Dockerfile, ...)
}

export function detectStack(fileList: string[], packageJson: unknown | null): StackInfo { ... }
```

Heuristics: `bun.lock`/`bun.lockb` -> bun; `pnpm-lock.yaml` -> pnpm; `yarn.lock` -> yarn; `package-lock.json` -> npm. Languages from extensions (`.ts`->typescript, `.py`->python, `.go`->go, `.rs`->rust). Frameworks/test from packageJson dependencies + devDependencies. Tests with fixture file lists + fixture package.json objects. TDD.

`src/init/profile.ts` - the init flow:

1. Prompt interactively (skip anything already in env; flags `--openrouter-key`, `--github-token`, `--model`, `--depth` override prompts). Secrets -> `saveGlobalConfig(join(homedir(), ".config", "squanchy"), {...})` (file mode 0600). Non-secret defaults -> `.squanchy/config.json` in the repo.
2. Walk repo files with `Bun.Glob`, skipping `node_modules`, `.git`, and `.gitignore`d paths; cap 2000 files; run `detectStack`.
3. Send ONE OpenRouter chat call with: the detected stack JSON, a compact file tree (dirs + top-level files), and contents of key config files (package.json, tsconfig.json, Dockerfile if small). System prompt: "Summarize this repository's tech stack, architecture, and conventions a code reviewer must know. Concise (<400 words), markdown."
4. Write `.squanchy/context.md` = generated summary + machine-readable stack block, under header `<!-- generated by squanchy init; regenerate anytime -->`. This file is committed (user decision).
5. Print next steps (`squanchy review <pr>` example).

CLI: add `program.command("init")` with the flags above.

Manual verification: run `bun run dev init` in this repo with a real OpenRouter key. Expect: `.squanchy/context.md` exists and mentions bun/typescript; `ls -l ~/.config/squanchy/config.json` shows `-rw-------`. Commit.

## Task 1.12: README + Phase 1 wrap-up

Rewrite `README.md`: what squanchy is; install (`bun install && bun link`); `squanchy init`; `squanchy review <pr> [--mode report|review] [-m model] [-d depths] [--overview text]`; config precedence; depth table (vulnerabilities/major/minor/nits/full + default); "squanchy never approves or merges; you are always in control"; secrets handling (global config 0600 or env, never committed).

Verify everything green:

```bash
bun test          # expect: all suites pass, 0 failures
bun run typecheck # expect: no errors
```

Commit: `git commit -am "docs: phase 1 CLI"`. Tag `v0.1.0-cli` locally (do NOT push anything without explicit user confirmation).

---

# PHASE 2: GitHub Action (start only after user validates Phase 1)

The "bot" is a GitHub Action triggered by `issue_comment` on PRs. No server, no GitHub App, no webhook infra. The user drops a workflow file into their repo; commenting `/squanchy review ...` on a PR runs the Action, which executes the same `runReview()` pipeline in mode `review` using the workflow's `GITHUB_TOKEN` and an `OPENROUTER_API_KEY` repo secret.

Platform constraints the implementer MUST know:

- `issue_comment` workflows only run from the version of the workflow file on the DEFAULT branch. Editing the workflow on a branch does nothing until merged.
- For comments on fork PRs, the token is read-only unless the workflow sets `permissions: pull-requests: write` (the example does) and the repo allows Actions on fork PRs. Document this limitation in README.
- Security: ANY user who can comment could otherwise trigger the Action and burn OpenRouter credits. The example workflow gates on `github.event.comment.author_association` being OWNER/MEMBER/COLLABORATOR, and `src/action/main.ts` re-verifies the association from its input (defense in depth).
- Composite actions get their own repo checked out at `${{ github.action_path }}` - that's where squanchy's source lives at runtime; the user's PR code is checked out separately so `.squanchy/context.md` is available in cwd.

## Task 2.1: Command parser (src/action/command.ts) - TDD, pure

```ts
import type { ReviewOptions } from "../types";

export interface ParsedCommand {
  options: Omit<ReviewOptions, "repo" | "prNumber">;
  reply: string | null;   // e.g. unknown flag -> error text to post as a comment
}

export function parseBotCommand(
  commentBody: string,
  defaults: { model: string; depths: string[] },
): ParsedCommand | null
```

Grammar (only comments starting with `/squanchy` trigger; anything else -> null):

- `/squanchy review` -> depths = defaults, model = defaults, mode "review"
- `/squanchy review --depth nits --model openai/gpt-5` -> overrides
- `/squanchy full` -> depths = full expansion
- `/squanchy overview: <text>` (rest of the comment after the marker line) -> sets overview
- unknown flag -> `{ options: <defaults>, reply: "squanchy: unknown option ..." }` so the Action posts the error back

Tests (`tests/command.test.ts`): ~10 table cases: bare review, flags, full shorthand, multiline overview, non-command comment -> null, case-insensitive `/Squanchy`, unknown flag -> reply set. TDD. Commit.

## Task 2.2: Action entrypoint (src/action/main.ts) - TDD via injected deps

Reads env: `SQUANCHY_COMMENT` (comment body), `SQUANCHY_COMMENT_ID`, `SQUANCHY_PR_URL`, `SQUANCHY_AUTHOR_ASSOCIATION`, `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, optional `SQUANCHY_MODEL` / `SQUANCHY_DEPTH` (workflow-level defaults).

Flow:

1. Guard: association not in {OWNER, MEMBER, COLLABORATOR} -> log + exit 0 silently (no comment spam).
2. `parseBotCommand` -> null: exit 0. reply-error: post it as a PR comment, exit 0.
3. Derive `{repo, prNumber}` from `SQUANCHY_PR_URL` (reuse `parsePrArg` - move it to a shared `src/args.ts` in this task and update the cli.ts import).
4. Post a `+1` reaction on the triggering comment (ack) via `octokit.rest.reactions.createForIssueComment` using `SQUANCHY_COMMENT_ID`.
5. `runReview({...options, mode: "review"}, deps)` with `readRepoContext` reading `.squanchy/context.md` from cwd (the checked-out PR head), `postReview = postPrReview`.
6. On success: post a short confirmation comment `squanchy reviewed: <review_url> (N findings)`. On error: post `squanchy failed: <message>` and exit 1 so the run shows red.

Structure `main()` to accept injected `{ env, octokitFactory, chat }` so tests run it fully offline; the module-level call at the bottom uses real deps only when executed directly (`if (import.meta.main)`).

Tests (`tests/action.test.ts`): (a) non-command comment -> zero API calls, (b) `/squanchy review` with fake chat -> createReview called once with event COMMENT, (c) disallowed association -> exits with no calls, (d) chat throws -> failure comment posted, exit code 1. TDD. Commit.

## Task 2.3: action.yml + example workflow

`action.yml` (repo root, composite):

```yaml
name: "squanchy review"
description: "AI code review triggered by /squanchy PR comments"
inputs:
  comment:
    description: "Triggering comment body"
    required: true
  comment_id:
    description: "Triggering comment id"
    required: true
  pr_url:
    description: "PR html_url"
    required: true
  author_association:
    description: "Comment author association"
    required: true
  model:
    description: "OpenRouter model override"
    required: false
  depth:
    description: "Default depth csv override"
    required: false
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: latest
    - name: Install squanchy deps
      run: bun install --frozen-lockfile
      shell: bash
      working-directory: ${{ github.action_path }}
    - name: Run review
      run: bun run ${{ github.action_path }}/src/action/main.ts
      shell: bash
      env:
        SQUANCHY_COMMENT: ${{ inputs.comment }}
        SQUANCHY_COMMENT_ID: ${{ inputs.comment_id }}
        SQUANCHY_PR_URL: ${{ inputs.pr_url }}
        SQUANCHY_AUTHOR_ASSOCIATION: ${{ inputs.author_association }}
        SQUANCHY_MODEL: ${{ inputs.model }}
        SQUANCHY_DEPTH: ${{ inputs.depth }}
```

`examples/squanchy.yml` (what users copy into their repo's `.github/workflows/`):

```yaml
name: squanchy
on:
  issue_comment:
    types: [created]
jobs:
  squanchy:
    if: >
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/squanchy') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout PR head
        uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head
      - uses: <squanchy-owner>/squanchy@main
        with:
          comment: ${{ github.event.comment.body }}
          comment_id: ${{ github.event.comment.id }}
          pr_url: ${{ github.event.issue.pull_request.html_url }}
          author_association: ${{ github.event.comment.author_association }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

(Implementer: `refs/pull/N/head` is the robust checkout for both same-repo and fork PRs; verify on a real fork PR during smoke testing. Keep the example minimal and correct rather than clever.)

Verify locally without GitHub:

```bash
SQUANCHY_COMMENT='/squanchy review' SQUANCHY_COMMENT_ID='1' \
SQUANCHY_PR_URL='https://github.com/<your-scratch-repo>/pull/1' \
SQUANCHY_AUTHOR_ASSOCIATION='OWNER' GITHUB_TOKEN=*** OPENROUTER_API_KEY=*** \
bun run src/action/main.ts
# expect: exit 0 and a "posted: <review_url>" log line
# (run this ONLY against a scratch repo you own, never a third-party PR)
```

Commit.

## Task 2.4: README action docs + smoke test checklist

Add README section: installing the Action in a repo (copy `examples/squanchy.yml`, add `OPENROUTER_API_KEY` secret, default-branch requirement), the command grammar, the fork-PR limitation, the association gate. Bump version to 0.2.0 in package.json + cli.ts.

Manual smoke (scratch repo, real secrets): open a PR with a deliberate bug (e.g. `eval(req.body.x)`), comment `/squanchy review`, expect: thumbs-up reaction on the comment, green workflow run, one COMMENT review with an inline finding on the bug line. Then `/squanchy review --depth nits` -> only nit-level (or no) findings. Then a non-member account comments `/squanchy review` -> workflow skips (job not started).

Commit + tag `v0.2.0-action` locally. Do not push without explicit user confirmation.

---

## Tests / validation summary

- `bun test` and `bun run typecheck` must be green at EVERY commit; all tests are offline (GitHub payload fixtures, injected fake `chat`, no network).
- Phase 1 manual smoke (real keys, scratch repo):
  1. `squanchy init` -> `~/.config/squanchy/config.json` mode 0600 + committed `.squanchy/context.md`.
  2. `squanchy review <pr> --mode report` -> terminal report, PR untouched.
  3. `squanchy review <pr> --mode review` -> exactly one COMMENT review, inline comments only on lines present in the diff.
  4. `--depth nits` -> only nit-severity findings or none.
- Phase 2 smoke: the three-comment scenario in Task 2.4.

## Risks, tradeoffs

- GitHub 422 on inline comments whose line is outside the diff: mitigated by the mandatory `linesInDiff()` filter (Tasks 1.4/1.8); failures are demoted to body bullets, never crash the review.
- Large PRs vs context windows: 150k-char diff budget with truncation now; chunked multi-pass review is a later enhancement (YAGNI). The 1M-context default free model absorbs most PRs.
- Free-model constraints: OpenRouter `:free` models are rate-limited (roughly 20 req/min, 50/day on low-credit accounts) and can be rotated/removed without notice. The default is one constant (`DEFAULT_MODEL` in `src/config.ts`); README documents the `-m` override. Free models also vary in JSON-schema adherence -> the zod parse + one retry path is the safety net.
- `issue_comment` Action quirks (default-branch workflow only, fork-PR token permissions, credit burn by unauthorized commenters) are addressed by Task 2.3's gates but are inherent platform limits; re-read them before smoke testing.
- The Action runs `bun install` from source per invocation (~30-60s overhead). Acceptable for v1; a prebuilt/published action is a later optimization.

## Open questions (all resolved)

1. Repo context -> `.squanchy/context.md` committed in the user's repo (user confirmed).
2. Naming -> "depth" (user confirmed).
3. Default model -> best free OpenRouter model: `nvidia/nemotron-3-ultra-550b-a55b:free` as of 2026-09-16 (agent-verified against /models; user said "best free").
4. Bot -> GitHub Action only for now (user confirmed).
5. Bun -> yes (user confirmed).

Implementation starts at Task 1.1.
