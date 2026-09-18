export interface GrepMatch {
  path: string;
  line: number; // 1-based
  text: string;
  before: string[]; // up to GREP_CONTEXT_LINES lines before
  after: string[]; // up to GREP_CONTEXT_LINES lines after
}

/** Read-only view of the repo at the PR head commit, used by the agent tools. */
export interface RepoSnapshot {
  readonly kind: "fs" | "git-ref" | "tarball";
  /** File contents at the PR head, truncated to MAX_READ_CHARS. null: missing, directory, or binary. */
  readFile(path: string): Promise<string | null>;
  /** Directory entries relative to the repo root (dirs get a trailing "/"). null: missing. */
  listDir(path: string): Promise<string[] | null>;
  /** Regex search over text files. pathGlob optionally restricts by path (glob syntax). */
  grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]>;
  /** Release temp resources (no-op for most backends). */
  dispose(): Promise<void>;
}

export const MAX_READ_CHARS = 50_000;
export const MAX_GREP_FILE_BYTES = 512_000;
export const MAX_GREP_MATCHES = 100;
export const MAX_GREP_FILES = 5_000;
export const GREP_CONTEXT_LINES = 3;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "target",
  ".venv",
  "__pycache__",
]);

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "avif", "pdf",
  "zip", "gz", "tgz", "tar", "bz2", "7z", "rar", "xz",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mov", "avi", "webm", "wav",
  "wasm", "jar", "class", "exe", "dll", "so", "dylib", "bin",
  "lockb", "sqlite", "db", "pyc", "o", "a",
]);

const LOCK_FILES = new Set([
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "uv.lock",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

export function normalizePath(p: string): string {
  return p.replace(/^\.?\//, "").trim();
}

export function isGrepCandidate(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const base = parts[parts.length - 1] ?? "";
  if (LOCK_FILES.has(base)) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  const ext = base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
  return !BINARY_EXTS.has(ext);
}

export function looksBinary(content: string): boolean {
  return content.includes("\0");
}

/** Truncate file content for tool output, with an explicit marker. */
export function truncateForRead(content: string, maxChars = MAX_READ_CHARS): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n[squanchy: file truncated at ${maxChars} chars]`;
}

/** Build GrepMatches (with context lines) from sorted 1-based matched line numbers. */
export function buildMatches(path: string, content: string, matchedLines: number[]): GrepMatch[] {
  const lines = content.split("\n");
  return matchedLines.map((line) => ({
    path,
    line,
    text: lines[line - 1] ?? "",
    before: lines.slice(Math.max(0, line - 1 - GREP_CONTEXT_LINES), line - 1),
    after: lines.slice(line, line + GREP_CONTEXT_LINES),
  }));
}

export function formatGrepMatches(matches: GrepMatch[]): string {
  const byPath = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const list = byPath.get(m.path) ?? [];
    list.push(m);
    byPath.set(m.path, list);
  }
  const out: string[] = [];
  for (const [path, list] of byPath) {
    out.push(path);
    for (const m of list) {
      const firstBefore = m.line - m.before.length;
      m.before.forEach((b, i) => out.push(`  ${firstBefore + i}- ${b}`));
      out.push(`  ${m.line}: ${m.text}`);
      m.after.forEach((a, i) => out.push(`  ${m.line + 1 + i}- ${a}`));
    }
  }
  return out.join("\n");
}
