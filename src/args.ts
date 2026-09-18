import { readFileSync } from "node:fs";
import { join } from "node:path";

export function detectRepoFromGitRemote(cwd: string = process.cwd()): string {
  const cfg = readFileSync(join(cwd, ".git", "config"), "utf8");
  const m = cfg.match(/url\s*=\s*(?:.*github\.com[:/])([^/\s]+\/[^/\s.]+)/);
  if (!m) throw new Error("Could not detect repo from .git/config; pass owner/repo#N");
  return m[1];
}

/** detectRepoFromGitRemote, but null instead of throwing (worktrees, non-git dirs, foreign repos). */
export function tryDetectRepoFromGitRemote(cwd: string = process.cwd()): string | null {
  try {
    return detectRepoFromGitRemote(cwd);
  } catch {
    return null;
  }
}

export function parsePrArg(arg: string, cwd: string = process.cwd()): { repo: string; prNumber: number } {
  const url = arg.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], prNumber: Number(url[2]) };
  const hash = arg.match(/^([^#]+)#(\d+)$/);
  if (hash) return { repo: hash[1], prNumber: Number(hash[2]) };
  if (/^\d+$/.test(arg)) return { repo: detectRepoFromGitRemote(cwd), prNumber: Number(arg) };
  throw new Error(`Cannot parse PR argument: ${arg} (expected "owner/repo#N", "N", or a GitHub PR URL)`);
}
