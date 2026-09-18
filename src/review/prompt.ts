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

/** Diffs are inlined in the first message up to this budget; larger PRs page them via get_file_diff. */
export const INLINE_DIFF_BUDGET = 60_000;

export function buildSystemPrompt(options: ReviewOptions): string {
  return [
    "You are squanchy, a precise senior code reviewer operating as an agent on a GitHub pull request.",
    "The first user message contains PR metadata, the changed-files list, and (budget permitting) the diffs.",
    "You have tools to inspect the repository at the PR head commit and to record your output.",
    "",
    "Focus areas for this review:",
    ...options.depths.map((d) => `- ${FOCUS_TEXT[d]}`),
    "",
    "Workflow:",
    "1. Read the diffs. Before concluding anything suspicious or unclear, gather context with get_file_diff, read_file, list_dir, or grep (full files at the PR head, callers, definitions, related config).",
    "2. Record every finding with submit_finding, one call per finding.",
    "3. Call finish_review exactly once when done. Pass an overview only when the 'full' focus is active.",
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
  const sections: string[] = [];
  let spent = 0;
  for (const f of bundle.files) {
    const header = `## ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
    if (f.patch !== undefined && spent + f.patch.length <= INLINE_DIFF_BUDGET) {
      spent += f.patch.length;
      sections.push(`${header}\n\`\`\`diff\n${f.patch}\n\`\`\``);
    } else if (f.patch !== undefined) {
      sections.push(`${header}\n(diff not inlined for size — fetch it with get_file_diff)`);
    } else {
      sections.push(`${header}\n(no patch: binary or dropped by the size budget — use read_file at the head commit if needed)`);
    }
  }
  return [
    repoContext ? `# Repository context\n${repoContext}\n` : "",
    `# Pull request\nrepo: ${bundle.repo}\nnumber: ${bundle.prNumber}\ntitle: ${bundle.title}\nauthor: ${bundle.author}\nhead commit: ${bundle.headSha}\n`,
    bundle.body ? `description:\n${bundle.body}\n` : "",
    options.overview ? `user-provided PR overview (treat as ground truth):\n${options.overview}\n` : "",
    bundle.truncated ? "(note: some patches were dropped by the size budget; read_file at the head commit still works)\n" : "",
    `# Changed files (${bundle.files.length})\n`,
    ...sections,
  ]
    .filter(Boolean)
    .join("\n");
}
