import {
  buildMatches,
  isGrepCandidate,
  looksBinary,
  MAX_GREP_MATCHES,
  normalizePath,
  truncateForRead,
  type GrepMatch,
  type RepoSnapshot,
} from "./snapshot";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
};

/**
 * Snapshot of a PR head commit inside a local clone of the same repo.
 * Fetches `refs/pull/N/head` shallowly on first use; never touches the working tree or branches.
 */
export class GitRefSnapshot implements RepoSnapshot {
  readonly kind = "git-ref" as const;
  private ready: Promise<void> | null = null;
  private fileCache = new Map<string, string | null>();

  constructor(
    private repoDir: string,
    private pullNumber: number,
    private headSha: string,
    private git: GitRunner = defaultGitRunner,
  ) {}

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const has = await this.git(["git", "cat-file", "-e", `${this.headSha}^{commit}`], this.repoDir);
        if (has.exitCode === 0) return;
        const fetched = await this.git(
          ["git", "fetch", "--no-tags", "--depth=1", "origin", `+refs/pull/${this.pullNumber}/head`],
          this.repoDir,
        );
        if (fetched.exitCode !== 0) {
          throw new Error(`git fetch of refs/pull/${this.pullNumber}/head failed: ${fetched.stderr.slice(0, 300)}`);
        }
        const has2 = await this.git(["git", "cat-file", "-e", `${this.headSha}^{commit}`], this.repoDir);
        if (has2.exitCode !== 0) {
          throw new Error(`PR head commit ${this.headSha} not found after fetching refs/pull/${this.pullNumber}/head`);
        }
      })();
    }
    return this.ready;
  }

  async readFile(path: string): Promise<string | null> {
    await this.ensure();
    const p = normalizePath(path);
    if (this.fileCache.has(p)) return this.fileCache.get(p) ?? null;
    const r = await this.git(["git", "show", `${this.headSha}:${p}`], this.repoDir);
    let content: string | null = null;
    if (r.exitCode === 0 && !looksBinary(r.stdout)) content = truncateForRead(r.stdout);
    this.fileCache.set(p, content);
    return content;
  }

  async listDir(path: string): Promise<string[] | null> {
    await this.ensure();
    const p = normalizePath(path);
    const args = ["git", "ls-tree", this.headSha];
    if (p) args.push(`${p}/`);
    const r = await this.git(args, this.repoDir);
    if (r.exitCode !== 0) return null;
    const entries = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // format: "<mode> <type> <sha>\t<path>"
        const [meta, entryPath] = line.split("\t");
        const type = meta?.split(" ")[1];
        const name = (entryPath ?? "").split("/").filter(Boolean).pop() ?? "";
        return type === "tree" ? `${name}/` : name;
      })
      .filter(Boolean);
    if (p && entries.length === 0) return null; // ls-tree succeeds with empty output for missing paths
    return entries.sort();
  }

  async grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]> {
    new RegExp(pattern); // validate early; the model gets a proper error for bad regexes
    await this.ensure();
    const args = ["git", "grep", "-n", "-I", "-E", "-e", pattern, this.headSha];
    if (pathGlob) args.push("--", pathGlob);
    const r = await this.git(args, this.repoDir);
    if (r.exitCode === 1) return []; // git grep: 1 = no matches
    if (r.exitCode !== 0) throw new Error(`git grep failed: ${r.stderr.slice(0, 300)}`);
    const lineRe = /^[0-9a-f]{7,64}:(.+?):(\d+):([\s\S]*)$/;
    const byPath = new Map<string, number[]>();
    for (const raw of r.stdout.split("\n")) {
      const m = raw.match(lineRe);
      if (!m) continue;
      const [, path, lineNo] = m;
      if (!isGrepCandidate(path!)) continue;
      const list = byPath.get(path!) ?? [];
      list.push(Number(lineNo));
      byPath.set(path!, list);
    }
    const matches: GrepMatch[] = [];
    for (const [path, lineNos] of byPath) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      const content = await this.readFile(path);
      if (content === null) continue;
      matches.push(...buildMatches(path, content, lineNos.slice(0, MAX_GREP_MATCHES)));
    }
    return matches.slice(0, MAX_GREP_MATCHES);
  }

  async dispose(): Promise<void> {
    // fetched objects live in the user's repo object store; nothing to clean up
  }
}
