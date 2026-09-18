import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSnapshot } from "../src/snapshot/fs";
import { GitRefSnapshot } from "../src/snapshot/git-ref";
import { TarballSnapshot } from "../src/snapshot/tarball";
import { buildMatches, formatGrepMatches, isGrepCandidate } from "../src/snapshot/snapshot";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function seedRepo(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "src", "login.ts"), "import db from './db';\nexport function login(q: string) {\n  return db.run(`SELECT ${q}`);\n}\n");
  writeFileSync(join(dir, "src", "db.ts"), "export default { run: (s: string) => s };\n");
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(dir, "bun.lock"), "lockfile noise db.run db.run db.run\n");
  writeFileSync(join(dir, "node_modules", "junk", "index.js"), "db.run('should never match');\n");
}

describe("FsSnapshot", () => {
  test("readFile returns content, null for missing, blocks traversal", async () => {
    const dir = tmp("sq-fs-");
    seedRepo(dir);
    const snap = new FsSnapshot(dir);
    expect(await snap.readFile("src/db.ts")).toContain("export default");
    expect(await snap.readFile("./src/db.ts")).toContain("export default");
    expect(await snap.readFile("nope.ts")).toBeNull();
    expect(await snap.readFile("../../etc/passwd")).toBeNull();
    expect(await snap.readFile("src")).toBeNull(); // directory
  });

  test("readFile truncates huge files with a marker", async () => {
    const dir = tmp("sq-fs-");
    writeFileSync(join(dir, "big.txt"), "y".repeat(60_000));
    const content = await new FsSnapshot(dir).readFile("big.txt");
    expect(content).toContain("[squanchy: file truncated at 50000 chars]");
    expect(content!.length).toBeLessThan(60_000);
  });

  test("listDir marks directories and handles root/missing", async () => {
    const dir = tmp("sq-fs-");
    seedRepo(dir);
    const snap = new FsSnapshot(dir);
    const root = await snap.listDir("");
    expect(root).toContain("src/");
    expect(root).toContain("package.json");
    expect(await snap.listDir("src")).toContain("login.ts");
    expect(await snap.listDir("missing")).toBeNull();
  });

  test("grep finds matches with context, skips lockfiles and node_modules", async () => {
    const dir = tmp("sq-fs-");
    seedRepo(dir);
    const snap = new FsSnapshot(dir);
    const matches = await snap.grep("db\\.run");
    const paths = new Set(matches.map((m) => m.path));
    expect(paths.has("src/login.ts")).toBe(true);
    expect(paths.has("bun.lock")).toBe(false);
    expect(paths.has("node_modules/junk/index.js")).toBe(false);
    const m = matches.find((x) => x.path === "src/login.ts")!;
    expect(m.line).toBe(3);
    expect(m.text).toContain("SELECT");
    expect(m.before.length).toBe(2); // only 2 lines exist above
    expect(m.after).toEqual(["}", ""]); // closing brace + trailing empty line from final \n
  });

  test("grep honors path_glob", async () => {
    const dir = tmp("sq-fs-");
    seedRepo(dir);
    const matches = await new FsSnapshot(dir).grep("export", "src/db.ts");
    expect(matches.length).toBe(1);
    expect(matches[0]!.path).toBe("src/db.ts");
  });

  test("grep with invalid regex throws", async () => {
    const dir = tmp("sq-fs-");
    seedRepo(dir);
    await expect(new FsSnapshot(dir).grep("([unclosed")).rejects.toThrow();
  });

  test("grep skips hidden .git but sees dotfiles like workflows", async () => {
    const dir = tmp("sq-fs-");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "runs: marker-token\n");
    writeFileSync(join(dir, ".git", "config"), "marker-token\n");
    const matches = await new FsSnapshot(dir).grep("marker-token");
    expect(matches.map((m) => m.path)).toEqual([".github/workflows/ci.yml"]);
  });
});

describe("isGrepCandidate / buildMatches / formatGrepMatches", () => {
  test("candidate filters", () => {
    expect(isGrepCandidate("src/a.ts")).toBe(true);
    expect(isGrepCandidate("node_modules/a/index.js")).toBe(false);
    expect(isGrepCandidate("bun.lock")).toBe(false);
    expect(isGrepCandidate("img/logo.png")).toBe(false);
    expect(isGrepCandidate("dist/bundle.js")).toBe(false);
    expect(isGrepCandidate("app.min.js")).toBe(false);
    expect(isGrepCandidate("README")).toBe(true);
  });

  test("format renders file groups, line numbers and context prefixes", () => {
    const content = "l1\nl2\nl3\nHIT\nl5\nl6\nl7\nl8";
    const out = formatGrepMatches(buildMatches("a.ts", content, [4]));
    expect(out.split("\n")[0]).toBe("a.ts");
    expect(out).toContain("  4: HIT");
    expect(out).toContain("  1- l1");
    expect(out).toContain("  7- l7");
    expect(out).not.toContain("l8");
  });
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

describe("GitRefSnapshot", () => {
  test("reads files, lists dirs and greps at a commit without touching the worktree", async () => {
    const dir = tmp("sq-git-");
    seedRepo(dir);
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "base");
    const sha = await git(dir, "rev-parse", "HEAD");
    // mutate the worktree AFTER the commit: snapshot must show committed state
    writeFileSync(join(dir, "src", "db.ts"), "MUTATED\n");

    const snap = new GitRefSnapshot(dir, 99, sha);
    expect(await snap.readFile("src/db.ts")).toContain("export default");
    expect(await snap.readFile("src/db.ts")).not.toContain("MUTATED");
    expect(await snap.readFile("missing.ts")).toBeNull();
    const root = await snap.listDir("");
    expect(root).toContain("src/");
    expect(await snap.listDir("nope")).toBeNull();
    const matches = await snap.grep("db\\.run");
    expect(matches.some((m) => m.path === "src/login.ts" && m.line === 3)).toBe(true);
    expect(matches.some((m) => m.path === "bun.lock")).toBe(false);
    expect(await snap.grep("zzz-no-match")).toEqual([]);
  });

  test("fetches the pull ref when the sha is unknown", async () => {
    const dir = tmp("sq-git-");
    seedRepo(dir);
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "base");
    // simulate a remote having the PR head: second commit only reachable via a pull ref
    writeFileSync(join(dir, "src", "pr-only.ts"), "export const added = true;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "pr head");
    const headSha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "update-ref", "refs/pull/99/head", headSha);
    await git(dir, "reset", "--hard", "HEAD~1");
    // no "origin" remote: fetch would fail, but cat-file finds the sha (still in object store)
    const snap = new GitRefSnapshot(dir, 99, headSha);
    expect(await snap.readFile("src/pr-only.ts")).toContain("added = true");
  });

  test("missing sha with failing fetch throws a helpful error", async () => {
    const dir = tmp("sq-git-");
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "x");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "c");
    const snap = new GitRefSnapshot(dir, 99, "0".repeat(40));
    await expect(snap.readFile("f.txt")).rejects.toThrow(/git fetch of refs\/pull\/99\/head failed/);
  });
});

describe("TarballSnapshot", () => {
  test("extracts once, serves files, dispose removes the temp dir", async () => {
    const src = tmp("sq-tar-src-");
    seedRepo(src);
    const tarPath = join(tmp("sq-tar-"), "repo.tar.gz");
    const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", src, "."], { stderr: "pipe" });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    let downloads = 0;
    const snap = new TarballSnapshot(async () => {
      downloads++;
      return await Bun.file(tarPath).arrayBuffer();
    });
    expect(await snap.readFile("src/db.ts")).toContain("export default");
    expect(await snap.readFile("src/db.ts")).toContain("export default"); // cached snapshot
    expect(downloads).toBe(1);
    expect(await snap.listDir("src")).toContain("login.ts");
    expect((await snap.grep("db\\.run")).some((m) => m.path === "src/login.ts")).toBe(true);
    await snap.dispose();
    // internal temp dir is gone: a fresh read re-downloads (and old tmp cleaned)
    expect(downloads).toBe(1);
  });

  test("tar failure surfaces as an error", async () => {
    const snap = new TarballSnapshot(async () => new TextEncoder().encode("not a tarball").buffer as ArrayBuffer);
    await expect(snap.readFile("a")).rejects.toThrow(/tar extraction failed/);
    await snap.dispose();
  });

  test("single top-level dir is unwrapped (GitHub tarball layout)", async () => {
    const src = tmp("sq-tar2-src-");
    mkdirSync(join(src, "owner-repo-abc123", "inner"), { recursive: true });
    writeFileSync(join(src, "owner-repo-abc123", "inner", "a.txt"), "hello\n");
    const tarPath = join(tmp("sq-tar2-"), "repo.tar.gz");
    const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", src, "owner-repo-abc123"], { stderr: "pipe" });
    await proc.exited;
    const snap = new TarballSnapshot(async () => await Bun.file(tarPath).arrayBuffer());
    expect(await snap.readFile("inner/a.txt")).toBe("hello\n");
    await snap.dispose();
  });
});
