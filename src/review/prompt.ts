import type { PrBundle } from "../github/pr";
import type { Depth, ReviewOptions } from "../types";

const FOCUS_TEXT: Record<Depth, string> = {
  vulnerabilities:
    "Security vulnerabilities: injection, authz/authn flaws, secret leaks, unsafe deserialization, SSRF, path traversal, dependency risks.",
  major: "Major correctness issues: logic bugs, race conditions, data loss, broken error handling, incorrect API usage.",
  minor: "Minor issues: edge cases, missing validation, confusing naming, dead code, missing tests for new logic.",
  nits: "Nits only: style, formatting, tiny wording improvements. Do NOT report anything above nit level.",
  full: "Everything above, plus a concise PR overview section explaining what this PR does.",
};

/** Small PRs (total patch chars ≤ budget) get every diff inlined; larger ones fetch diffs on demand via get_file_diff. */
export const INLINE_ALL_DIFFS_MAX_CHARS = 12_000;

const GENERATED_FILE =
  /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|Gemfile\.lock|[^/]+\.snap)$|(?:^|\/)dist\//;

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE.test(path);
}

export function buildSystemPrompt(options: ReviewOptions): string {
  return [
    "You are squanchy, a precise senior code reviewer operating as an agent on a GitHub pull request.",
    "The first user message contains PR metadata and the changed-files list; diffs are inlined only for small PRs.",
    "You have tools to inspect the repository at the PR head commit and to record your output.",
    "",
    "Focus areas for this review:",
    ...options.depths.map((d) => `- ${FOCUS_TEXT[d]}`),
    "",
    "Workflow:",
    "1. If diffs are not inlined, fetch them with get_file_diff — batch several calls in one turn. Prioritize hand-written source; files marked [generated] rarely deserve review unless dependencies or schemas changed.",
    "2. Before concluding anything suspicious or unclear, gather context with read_file, list_dir, or grep (full files at the PR head, callers, definitions, related config).",
    "3. Record every finding with submit_finding, one call per finding.",
    "4. Call finish_review exactly once when done. Pass an overview only when the 'full' focus is active.",
    "",
    "Finding rules:",
    "- Only report issues grounded in code you actually saw. Never invent findings; an empty review is a valid result.",
    "- file: repo-relative path exactly as in the changelist.",
    "- line: line number in the NEW file version, derived from the hunk header (@@ -a,b +c,d @@). Use null when the finding is not tied to one line.",
    "- severity: one of vulnerability | major | minor | nit | info, matching the focus areas above.",
    "- comment: 1-3 concrete sentences explaining why it is a problem. suggestion: optional replacement code.",
    "- Do not report issues in unchanged code unless directly caused by this diff.",
    "- Do not report the same issue twice; merge duplicates into one finding.",
  ].join("\n");
}

export function buildFirstUserMessage(
  bundle: PrBundle,
  options: ReviewOptions,
  repoContext: string | null,
): string {
  const totalPatchChars = bundle.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
  const inlineAll = totalPatchChars <= INLINE_ALL_DIFFS_MAX_CHARS;
  const sections = bundle.files.map((f) => {
    const header = `## ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
    if (!inlineAll) {
      const marker =
        f.patch === undefined ? " [no patch — binary or dropped by the size budget]" : isGeneratedFile(f.path) ? " [generated]" : "";
      return `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})${marker}`;
    }
    if (f.patch !== undefined) {
      return `${header}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    }
    return `${header}\n(no patch: binary or dropped by the size budget — use read_file at the head commit if needed)`;
  });
  const filesHeader = inlineAll
    ? `# Changed files (${bundle.files.length})\n`
    : `# Changed files (${bundle.files.length}) — diffs NOT inlined; fetch each file you review with get_file_diff\n`;
  return [
    repoContext ? `# Repository context\n${repoContext}\n` : "",
    `# Pull request\nrepo: ${bundle.repo}\nnumber: ${bundle.prNumber}\ntitle: ${bundle.title}\nauthor: ${bundle.author}\nhead commit: ${bundle.headSha}\n`,
    bundle.body ? `description:\n${bundle.body}\n` : "",
    options.overview ? `user-provided PR overview (treat as ground truth):\n${options.overview}\n` : "",
    bundle.truncated ? "(note: some patches were dropped by the size budget; read_file at the head commit still works)\n" : "",
    filesHeader,
    ...sections,
  ]
    .filter(Boolean)
    .join("\n");
}
