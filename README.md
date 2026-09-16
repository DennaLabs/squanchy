# squanchy

AI code review for GitHub pull requests, powered by any model on OpenRouter. squanchy reviews the diff and reports findings with file and line references. It never approves and never merges: you are always in control of the PR.

Two interfaces:

- CLI: review any PR from your terminal, either as a local report or posted as review comments on the PR.
- GitHub Action (coming in v0.2): trigger reviews with `/squanchy` PR comments.

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

## Configuration precedence

flags > env vars (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) > repo `.squanchy/config.json` (non-secret defaults only) > global `~/.config/squanchy/config.json` > built-in defaults.

## Notes and limits

- The default model is the largest free OpenRouter model as of 2026-09. Free models are rate limited (roughly 20 requests/min, 50/day on low-credit accounts) and can be rotated by OpenRouter at any time. Override with `-m` or `defaultModel` in config.
- Very large diffs are truncated at 150k characters of patch text; squanchy reviews what fits and says so.
- Inline comments are only posted on lines present in the diff (GitHub rejects the rest); other findings appear in the review summary body.
- Secrets live only in `~/.config/squanchy/config.json` (mode 600) or env vars. Never commit keys; `.squanchy/config.json` in the repo ignores secret fields by design.

## Development

```
bun test          # offline unit tests (fixtures, no network)
bun run typecheck
bun run dev -- review <pr>
```
