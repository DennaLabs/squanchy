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

export function buildPrompt(
  bundle: PrBundle,
  options: ReviewOptions,
  repoContext: string | null,
): { system: string; user: string } {
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
    bundle.truncated ? "(note: the diff was truncated for size; review what is present)\n" : "",
    "# Diff\n",
    ...bundle.files.map(
      (f) =>
        `## ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n` +
        "```diff\n" +
        (f.patch ?? "(binary or no patch)") +
        "\n```\n",
    ),
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}
