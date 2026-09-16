import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveGlobalConfig } from "../src/config";

describe("loadConfig", () => {
  test("repo config overrides global defaults, env overrides secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-"));
    const globalDir = join(dir, "global");
    mkdirSync(join(dir, "repo", ".squanchy"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.json"),
      JSON.stringify({ defaultModel: "global-model", defaultDepths: ["minor"], githubToken: "global-token" }),
    );
    writeFileSync(join(dir, "repo", ".squanchy", "config.json"), JSON.stringify({ defaultModel: "repo-model" }));
    const cfg = loadConfig({
      globalDir,
      repoDir: join(dir, "repo"),
      env: { OPENROUTER_API_KEY: "env-key" },
    });
    expect(cfg.defaultModel).toBe("repo-model");
    expect(cfg.defaultDepths).toEqual(["minor"]);
    expect(cfg.openrouterApiKey).toBe("env-key");
    expect(cfg.githubToken).toBe("global-token");
  });

  test("works with no files at all (built-in defaults)", () => {
    const cfg = loadConfig({ globalDir: "/nonexistent", repoDir: "/nonexistent", env: {} });
    expect(cfg.defaultModel).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(cfg.defaultDepths).toEqual(["vulnerabilities", "major"]);
  });

  test("repo config cannot supply secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-"));
    mkdirSync(join(dir, ".squanchy"), { recursive: true });
    writeFileSync(
      join(dir, ".squanchy", "config.json"),
      JSON.stringify({ openrouterApiKey: "repo-key", githubToken: "repo-token" }),
    );
    const cfg = loadConfig({ globalDir: "/nonexistent", repoDir: dir, env: {} });
    expect(cfg.openrouterApiKey).toBeUndefined();
    expect(cfg.githubToken).toBeUndefined();
  });

  test("invalid depth in config throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultDepths: ["bogus"] }));
    expect(() => loadConfig({ globalDir: dir, repoDir: "/nonexistent", env: {} })).toThrow();
  });
});

describe("saveGlobalConfig", () => {
  test("writes merged json with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "sq-"));
    const globalDir = join(dir, "global");
    saveGlobalConfig(globalDir, { githubToken: "tok" });
    saveGlobalConfig(globalDir, { defaultModel: "m" });
    const path = join(globalDir, "config.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.githubToken).toBe("tok");
    expect(parsed.defaultModel).toBe("m");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
