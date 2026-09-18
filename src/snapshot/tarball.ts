import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSnapshot } from "./fs";
import type { GrepMatch, RepoSnapshot } from "./snapshot";

/**
 * Snapshot of a foreign repo: downloads the GitHub tarball for the PR head sha
 * once (lazily), extracts it to a temp dir, and serves files from there.
 * GNU tar / bsdtar refuse absolute paths and `../` members by default, which is
 * our extraction-safety guarantee for untrusted archives.
 */
export class TarballSnapshot implements RepoSnapshot {
  readonly kind = "tarball" as const;
  private inner: FsSnapshot | null = null;
  private tmpDir: string | null = null;
  private pending: Promise<FsSnapshot> | null = null;

  constructor(
    private getTarball: () => Promise<ArrayBuffer>,
    private tmpRoot: string = tmpdir(),
  ) {}

  private ensure(): Promise<FsSnapshot> {
    if (this.inner) return Promise.resolve(this.inner);
    if (!this.pending) {
      this.pending = (async () => {
        const buf = await this.getTarball();
        const dir = mkdtempSync(join(this.tmpRoot, "squanchy-snap-"));
        this.tmpDir = dir;
        const tarPath = join(dir, "repo.tar.gz");
        writeFileSync(tarPath, Buffer.from(buf));
        const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", dir], { stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) throw new Error(`tar extraction failed: ${stderr.slice(0, 300)}`);
        unlinkSync(tarPath);
        // GitHub tarballs contain a single top-level dir ("<owner>-<repo>-<sha>")
        const entries = readdirSync(dir, { withFileTypes: true });
        const root = entries.length === 1 && entries[0]!.isDirectory() ? join(dir, entries[0]!.name) : dir;
        this.inner = new FsSnapshot(root, "tarball");
        return this.inner;
      })();
    }
    return this.pending;
  }

  async readFile(path: string): Promise<string | null> {
    return (await this.ensure()).readFile(path);
  }

  async listDir(path: string): Promise<string[] | null> {
    return (await this.ensure()).listDir(path);
  }

  async grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]> {
    return (await this.ensure()).grep(pattern, pathGlob);
  }

  async dispose(): Promise<void> {
    if (this.tmpDir) {
      rmSync(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = null;
      this.inner = null;
      this.pending = null;
    }
  }
}

/** Build a tarball downloader for the GitHub API (follows the codeload redirect). */
export function githubTarballDownloader(
  githubToken: string,
  repo: string,
  headSha: string,
): () => Promise<ArrayBuffer> {
  return async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${headSha}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "squanchy",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`GitHub tarball download failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return await res.arrayBuffer();
  };
}
