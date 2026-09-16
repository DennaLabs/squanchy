import type { Octokit } from "@octokit/rest";
import type { ReviewResult } from "../types";

export const MAX_DIFF_CHARS = 150_000;
const TRUNCATION_MARKER = "\n... [squanchy: patch truncated]";

export interface PrFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch?: string; // unified diff hunk text (absent for binaries)
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

/** Keep whole patches while the budget lasts; truncate the overflowing one; drop the rest. */
export function enforceDiffBudget(
  files: PrFile[],
  maxChars: number,
): { files: PrFile[]; truncated: boolean } {
  let spent = 0;
  let truncated = false;
  const out: PrFile[] = files.map((f) => {
    if (f.patch === undefined) return { ...f };
    const len = f.patch.length;
    if (!truncated && spent + len <= maxChars) {
      spent += len;
      return { ...f };
    }
    truncated = true;
    const remaining = Math.max(0, maxChars - spent - TRUNCATION_MARKER.length);
    spent = maxChars;
    if (remaining <= 0) return { ...f, patch: undefined };
    return { ...f, patch: f.patch.slice(0, remaining) + TRUNCATION_MARKER };
  });
  return { files: out, truncated };
}

/** Set of NEW-file line numbers touched by a unified diff patch (context + added lines). */
export function linesInDiff(patch: string): Set<number> {
  const lines = new Set<number>();
  let current = -1;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (current < 0) continue;
    if (raw.startsWith("+")) {
      lines.add(current);
      current += 1;
    } else if (raw.startsWith("-")) {
      // removed line: no new-side number consumed
    } else {
      // context line (starts with " " or is bare)
      lines.add(current);
      current += 1;
    }
  }
  return lines;
}

export async function fetchPrBundle(octokit: Octokit, repo: string, prNumber: number): Promise<PrBundle> {
  const [owner, name] = repo.split("/");
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  const raw: PrFile[] = [];
  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo: name,
    pull_number: prNumber,
    per_page: 100,
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
    repo,
    prNumber,
    title: pr.title,
    body: pr.body,
    author: pr.user?.login ?? "unknown",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    files,
    truncated,
  };
}

interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/**
 * Post the review as a single COMMENT review. Inline comments are only allowed
 * on lines present in the diff (GitHub 422s otherwise); findings that fail
 * validation are demoted to file-level bullets in the review body.
 * squanchy NEVER approves or requests changes.
 */
export async function postPrReview(
  octokit: Octokit,
  bundle: PrBundle,
  result: ReviewResult,
): Promise<{ htmlUrl: string }> {
  const [owner, repo] = bundle.repo.split("/");
  const validLines = new Map<string, Set<number>>(
    bundle.files.map((f) => [f.path, f.patch ? linesInDiff(f.patch) : new Set<number>()]),
  );
  const inline: InlineComment[] = [];
  const fileLevel: string[] = [];
  for (const f of result.findings) {
    const ok = f.line !== null && (validLines.get(f.file)?.has(f.line) ?? false);
    if (ok) {
      const suggestion = f.suggestion ? `\n\nSuggestion:\n\`\`\`\n${f.suggestion}\n\`\`\`` : "";
      inline.push({
        path: f.file,
        line: f.line as number,
        side: "RIGHT",
        body: `**[${f.severity}]** ${f.comment}${suggestion}\n\n<sub>squanchy</sub>`,
      });
    } else {
      fileLevel.push(`- **[${f.severity}]** \`${f.file}${f.line ? `:${f.line}` : ""}\`: ${f.comment}`);
    }
  }
  const body = [
    result.overview ? `### Overview\n${result.overview.replace(/\n\nPosted: .+$/, "")}\n` : "",
    `### squanchy review: ${result.findings.length} finding(s)`,
    ...fileLevel,
    "\n<sub>AI-generated review. You are always in control of approving this PR.</sub>",
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: bundle.prNumber,
    commit_id: bundle.headSha,
    event: "COMMENT",
    body,
    comments: inline,
  });
  return { htmlUrl: data.html_url };
}
