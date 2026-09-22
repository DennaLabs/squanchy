# squanchy

AI code review for GitHub pull requests, powered by any model on OpenRouter. squanchy reviews the diff as an agent: it reads the patch, then pulls in extra context (full files, directory listings, regex search) at the PR head commit before recording findings with file and line references. It never approves and never merges: you are always in control of the PR.

Two interfaces:

- CLI: review any PR from your terminal, either as a local report or posted as review comments on the PR.
- GitHub Action: trigger reviews by commenting `/squanchy review` on a PR.

## Install

### Prebuilt binary (recommended)

```
curl -fsSL https://raw.githubusercontent.com/DennaLabs/squanchy/main/install.sh | bash
```

Downloads the latest release binary for your platform (Linux x64/arm64, macOS x64/arm64, Windows x64) into `~/.local/bin`. No Bun, no Node, no project required — `squanchy` just works in your terminal. Verify with `squanchy --version`.

Options: `SQUANCHY_VERSION=v0.3.0` to pin a version, `INSTALL_DIR=~/bin` to change the destination. While this repo is private, the installer needs a token:

```
curl -fsSL https://raw.githubusercontent.com/DennaLabs/squanchy/main/install.sh | GITHUB_TOKEN=*** bash
```

### From source

Requires [Bun](https://bun.sh) 1.2+.

```
git clone git@github.com:DennaLabs/squanchy.git && cd squanchy
bun install
bun run build                                        # cross-compiles all platforms into dist/
cp dist/squanchy-linux-x64 ~/.local/bin/squanchy     # pick your platform
```

### Dev mode (bun link)

```
bun install && bun link
```

This registers `squanchy` in `~/.bun/bin` — make sure that directory is on your `PATH` (the Bun installer normally adds it to your shell rc; open a new terminal after installing Bun).

## Setup

```
squanchy init
```

Init is a guided, interactive flow (powered by [clack](https://github.com/bombshell-dev/clack)):

1. **Scan** — detects your stack immediately (languages, package manager, test framework, file count).
2. **Credentials** — if an OpenRouter key / GitHub token already exist (from a previous repo's init, `~/.config/squanchy/config.json`, or env vars), squanchy offers to **reuse them** — so initializing a second repo only asks about that project. Otherwise it prompts for new ones (masked input) and asks whether to save them globally for future repos. Secrets always live in `~/.config/squanchy/config.json` (mode 600) or env vars — never in your repo.
3. **Default review depth** — multiselect (vulnerabilities, major, minor, nits, full), preselected from this repo's config.
4. **Default model** — a picker fed live from OpenRouter `/models` (best free models first, plus curated paid picks, plus "other..." to type any id). Falls back to a plain prompt if offline.
5. **Advanced** — optionally set max agent steps per review (default 25).
6. **Context generation** — writes `.squanchy/config.json` (defaults, committed) and generates `.squanchy/context.md` with one LLM pass over your stack + key files (a spinner shows progress). Commit `context.md`: it is injected into every review prompt so squanchy knows what it is dealing with.

Cancel at any prompt and nothing is written. Flags skip prompts for scripting: `squanchy init --openrouter-key *** --github-token *** -m <model> -d <depths> --max-steps <n>`. Without a TTY, init runs non-interactively using flags > env > stored credentials > built-in defaults.

Re-running `squanchy init` in an already-configured repo keeps your values as preselected defaults and regenerates `context.md`.

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

While a review runs, the terminal shows a live progress spinner with what squanchy is doing in general terms — fetching the PR, reading files, searching the repo, step/finding counters, elapsed time. The final report is color-coded by severity (▲ purple vulnerability, ✖ red major, ◆ orange minor, ▸ yellow nit, ○ cyan info), with clickable `file:line` links to the blob at the PR head and an OSC-8-capable terminal. Set `SQUANCHY_DEBUG=1` to trace every agent step (model calls, tool calls, outcomes) on stderr; non-TTY output stays plain for CI logs.

## Configuration precedence

flags > env vars (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) > repo `.squanchy/config.json` (non-secret defaults only) > global `~/.config/squanchy/config.json` > built-in defaults.

## GitHub Action (the bot)

squanchy also runs as a GitHub Action: comment `/squanchy review` on a PR and it posts the review as inline comments. No server, no GitHub App.

### Install

1. Copy [`examples/squanchy.yml`](examples/squanchy.yml) to `.github/workflows/squanchy.yml` on your **default branch** (GitHub only runs `issue_comment` workflows from the default branch). Keep the `uses: DennaLabs/squanchy@vX.Y.Z` line pinned to the latest tag from the [Releases page](https://github.com/DennaLabs/squanchy/releases).
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

## Releases & CI

- **Releases** are automated with [semantic-release](https://semantic-release.gitbook.io): every push to `main` analyzes conventional commits (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major) and creates the version bump commit (`chore(release): vX.Y.Z [skip ci]`), `CHANGELOG.md` entry, git tag, and GitHub Release. Each release cross-compiles and attaches self-contained binaries (`squanchy-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`, `-windows-x64.exe`) — these are what `install.sh` downloads. Nothing is published to npm. Action users pin those tags.
- **CI** (`.github/workflows/ci.yml`) runs typecheck + unit tests on every push to `main` and every PR.
- **Dependabot** (`.github/dependabot.yml`) opens grouped weekly PRs for `bun` and `github-actions` ecosystems, with 7-day cooldowns (30 for majors) and a 7-day minimum package age (`bunfig.toml`) as supply-chain hardening. Production dependency bumps use `fix(deps):` and therefore ship as patch releases.
- **Security audit**: a daily workflow runs `bun audit` and files (or updates) a single tracking issue when it finds anything.

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
