import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMatches,
  isGrepCandidate,
  looksBinary,
  MAX_GREP_FILE_BYTES,
  MAX_GREP_FILES,
  MAX_GREP_MATCHES,
  normalizePath,
  truncateForRead,
  type GrepMatch,
  type RepoSnapshot,
} from "./snapshot";

/** Snapshot backed by a directory on disk: the Action's checked-out PR head, or an extracted tarball. */
export class FsSnapshot implements RepoSnapshot {
  constructor(
    private dir: string,
    readonly kind: "fs" | "tarball" = "fs",
  ) {}

  private safe(relPath: string): string | null {
    const full = resolve(this.dir, relPath);
    if (full !== this.dir && !full.startsWith(this.dir + "/")) return null; // path traversal guard
    return full;
  }

  async readFile(path: string): Promise<string | null> {
    const full = this.safe(normalizePath(path));
    if (!full || !existsSync(full) || !statSync(full).isFile()) return null;
    if (statSync(full).size > MAX_GREP_FILE_BYTES) return "[squanchy: file too large to read]";
    const content = readFileSync(full, "utf8");
    if (looksBinary(content)) return null;
    return truncateForRead(content);
  }

  async listDir(path: string): Promise<string[] | null> {
    const full = this.safe(normalizePath(path));
    if (!full || !existsSync(full) || !statSync(full).isDirectory()) return null;
    return readdirSync(full, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  }

  async grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]> {
    const re = new RegExp(pattern);
    const glob = pathGlob ? new Bun.Glob(pathGlob) : null;
    const matches: GrepMatch[] = [];
    let scanned = 0;
    for (const rel of new Bun.Glob("**/*").scanSync({ cwd: this.dir, onlyFiles: true, dot: true })) {
      if (rel.startsWith(".git/") || rel === ".git") continue;
      if (scanned >= MAX_GREP_FILES || matches.length >= MAX_GREP_MATCHES) break;
      if (!isGrepCandidate(rel)) continue;
      if (glob && !glob.match(rel) && !glob.match(rel.split("/").pop() ?? "")) continue;
      const full = this.safe(rel);
      if (!full) continue;
      scanned++;
      if (statSync(full).size > MAX_GREP_FILE_BYTES) continue;
      const content = readFileSync(full, "utf8");
      if (looksBinary(content)) continue;
      const hitLines: number[] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hitLines.length < MAX_GREP_MATCHES; i++) {
        if (re.test(lines[i] ?? "")) hitLines.push(i + 1);
      }
      if (hitLines.length > 0) matches.push(...buildMatches(rel, content, hitLines));
    }
    return matches.slice(0, MAX_GREP_MATCHES);
  }

  async dispose(): Promise<void> {
    // caller owns the directory (cwd checkout or tarball temp dir handled by TarballSnapshot)
  }
}
