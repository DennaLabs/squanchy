# squanchy

AI code review for GitHub pull requests, powered by any model on OpenRouter. squanchy reviews the diff as an agent: it reads the patch, then pulls in extra context (full files, directory listings, regex search) at the PR head commit before recording findings with file and line references. It never approves and never merges: you are always in control of the PR.

Two interfaces:

- CLI: review any PR from your terminal, either as a local report or posted as review comments on the PR.
- GitHub Action: trigger reviews by commenting `/squanchy review` on a PR.

## Install

Requires [Bun](https://bun.sh) 1.2+.

```
git clone <this repo> && cd squanchy
bun install
bun link            # puts `squanchy` on your PATH
```

## Setup

```
squanchy init
```

Init will:

1. Ask for your OpenRouter API key and GitHub personal token (or take them from `--openrouter-key` / `--github-token` flags, or the `OPENROUTER_API_KEY` / `GITHUB_TOKEN` env vars). Secrets are stored in `~/.config/squanchy/config.json` with mode 600. They are never written into your repo.
2. Write non-secret defaults (model, depth) to `.squanchy/config.json` in the repo.
3. Explore the codebase (stack detection + one LLM pass) and generate `.squanchy/context.md`, a repo profile that is injected into every review prompt so squanchy knows what it is dealing with. Commit this file.

## Usage

```
squanchy review <pr> [options]
```

`<pr>` accepts a full GitHub URL, `owner/repo#123`, or a bare PR number (repo detected from your git remote).

Options:

```
-m, --model <model>     OpenRouter model id (default: nvidia/nemotron-3-ultra-550b-a55b:free)
-d, --depth <list>      csv of: vulnerabilities,major,minor,nits,full
--mode <mode>           report (default) | review
--overview <text>       brief explanation of what the PR is about
```

Modes:

- `report`: prints the review to your terminal. Nothing is posted to GitHub.
- `review`: posts a single COMMENT review on the PR, with inline comments on the exact diff lines where possible. squanchy never approves and never requests changes.

Examples:

```
squanchy review 123                                   # report, default depth, repo from git remote
squanchy review acme/widgets#42 --mode review         # post comments on the PR
squanchy review https://github.com/acme/widgets/pull/42 -d full
squanchy review 42 -d nits --overview "refactors auth flow"
```

### Review depth

| depth           | focuses on                                                     |
| --------------- | -------------------------------------------------------------- |
| vulnerabilities | security: injection, authz flaws, secret leaks, SSRF, traversal |
| major           | logic bugs, race conditions, data loss, broken error handling  |
| minor           | edge cases, missing validation, dead code, missing tests       |
| nits            | style and wording only                                         |
| full            | everything above, plus a PR overview section                   |

Default when unspecified: `vulnerabilities,major`. Depths combine: `-d vulnerabilities,major,minor`.

### How a review runs

squanchy is an agent, not a one-shot prompt. Each review is a loop of model steps (default cap: `maxSteps` = 25, configurable). The model gets the PR metadata and diffs (inlined up to 60k chars) plus these tools:

| tool              | what it does                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `get_file_diff`   | patch for one changed file                                            |
| `read_file`       | full file contents at the PR head commit (any file, not just changed) |
| `list_dir`        | directory listing at the PR head commit                               |
| `grep`            | regex search over the repo at the PR head commit, with context lines  |
| `submit_finding`  | record one finding (severity, file, line, comment, suggestion)        |
| `finish_review`   | end the review (optionally with an overview when depth includes full) |

Repo files are read through a snapshot of the **PR head commit**, picked automatically:

- `git-ref`: you run the CLI inside a clone of the PR's repo — squanchy shallow-fetches `refs/pull/N/head` and reads via git, never touching your working tree or branches.
- `tarball`: the PR is in some other repo — the head-commit tarball is downloaded once to a temp dir and removed after the review.
- `fs`: used by the GitHub Action, where the workflow already checked out the PR head.

Set `SQUANCHY_DEBUG=1` to trace every agent step (model calls, tool calls, outcomes) on stderr.

## Configuration precedence

flags > env vars (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) > repo `.squanchy/config.json` (non-secret defaults only) > global `~/.config/squanchy/config.json` > built-in defaults.

## GitHub Action (the bot)

squanchy also runs as a GitHub Action: comment `/squanchy review` on a PR and it posts the review as inline comments. No server, no GitHub App.

### Install

1. Copy [`examples/squanchy.yml`](examples/squanchy.yml) to `.github/workflows/squanchy.yml` on your **default branch** (GitHub only runs `issue_comment` workflows from the default branch) and replace `<squanchy-owner>` with the owner of the squanchy repo (or pin `@v0.2.0` once released).
2. Add an `OPENROUTER_API_KEY` repository secret.
3. Optionally commit `.squanchy/` (run `squanchy init` locally) so bot reviews use your repo defaults and context.

### Commands

| comment | effect |
| --- | --- |
| `/squanchy review` | review with repo defaults |
| `/squanchy review --depth minor,nits` | pick focus areas (csv: vulnerabilities,major,minor,nits,full) |
| `/squanchy review --model <id>` | pick the OpenRouter model |
| `/squanchy review --overview <text>` | tell squanchy what the PR is about (text runs to the end of the comment) |
| `/squanchy full` | shorthand for a full-depth review |
| `/squanchy help` | post the command help |

Flags combine. Comment flags override workflow inputs (`model:`/`depth:`), which override `.squanchy/config.json`.

What happens on a trigger: 👀 reaction on your comment → agent review → one `COMMENT` review with inline findings on diff lines (off-diff findings go into the review body) → a short confirmation comment with the review link and finding count. Failures post `squanchy failed: <reason>` and the run goes red. squanchy never approves and never requests changes.

### Security and platform limits

- **Who can trigger:** the workflow only runs for commenters with `OWNER`, `MEMBER`, or `COLLABORATOR` association (enforced in the workflow `if:` *and* re-checked in the action) — strangers can't burn your OpenRouter credits.
- **Fork PRs:** reviews work as long as your repo allows Actions on fork PRs; the workflow checks out `refs/pull/N/head` and only needs `pull-requests: write`.
- **Prompt injection:** repo context (`.squanchy/context.md`) and code are read from the PR head, so a malicious fork PR could try to steer the review. The blast radius is small (squanchy can only post comments), but treat its output as untrusted input, like any AI review.
- `bun install` runs per invocation (~30–60s overhead). Acceptable for v0.2; prebundling is a later optimization.

## Notes and limits

- The default model is the largest free OpenRouter model as of 2026-09. Free models are rate limited (roughly 20 requests/min, 50/day on low-credit accounts) and can be rotated by OpenRouter at any time. Agent reviews use one request per step (up to `maxSteps`), so free-tier budgets deplete faster; override with `-m` or `defaultModel` in config, and lower `maxSteps` to cap cost.
- The fetched diff is capped at 150k characters of patch text and the first prompt inlines up to 60k; the agent can still fetch remaining patches per file, and full file contents are always available via `read_file`.
- Inline comments are only posted on lines present in the diff (GitHub rejects the rest); other findings appear in the review summary body.
- Secrets live only in `~/.config/squanchy/config.json` (mode 600) or env vars. Never commit keys; `.squanchy/config.json` in the repo ignores secret fields by design.

## Development

```
bun test          # offline unit tests (fixtures, no network)
bun run typecheck
bun run dev -- review <pr>
```

Run the Action locally against a scratch repo you own (never a third-party PR):

```
SQUANCHY_COMMENT='/squanchy review' \
SQUANCHY_COMMENT_ID='1' \
SQUANCHY_PR_URL='https://github.com/<you>/<scratch-repo>/pull/1' \
SQUANCHY_AUTHOR_ASSOCIATION='OWNER' \
GITHUB_TOKEN=*** OPENROUTER_API_KEY=*** \
GITHUB_WORKSPACE=$(pwd) \
SQUANCHY_DEBUG=1 \
bun run src/action/main.ts
```
