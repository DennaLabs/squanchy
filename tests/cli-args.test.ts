import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrArg } from "../src/args";

describe("parsePrArg", () => {
  test("full URL", () => {
    expect(parsePrArg("https://github.com/acme/widgets/pull/42")).toEqual({ repo: "acme/widgets", prNumber: 42 });
  });

  test("owner/repo#N", () => {
    expect(parsePrArg("acme/widgets#7")).toEqual({ repo: "acme/widgets", prNumber: 7 });
  });

  test("bare number uses git remote", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-repo-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(parsePrArg("12", dir)).toEqual({ repo: "acme/widgets", prNumber: 12 });
  });

  test("https remote url form", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-repo-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');
    expect(parsePrArg("3", dir)).toEqual({ repo: "acme/widgets", prNumber: 3 });
  });

  test("garbage throws", () => {
    expect(() => parsePrArg("not-a-pr")).toThrow();
  });

  test("bare number without git remote throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-norepo-"));
    expect(() => parsePrArg("12", dir)).toThrow();
  });
});
