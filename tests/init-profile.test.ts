import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_STEPS, DEFAULT_MODEL } from "../src/config";
import {
  readExistingSecrets,
  readRepoDefaults,
  resolveNonInteractive,
  runInit,
  type InitDeps,
} from "../src/init/profile";
import type { InitAnswers, InitPromptState, Reporter } from "../src/init/prompts";
import type { Depth } from "../src/types";

function tempWorkspace(): { repoDir: string; globalDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sq-init-"));
  const repoDir = join(dir, "repo");
  const globalDir = join(dir, "global");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { react: "^19" } }));
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "app.tsx"), "export const App = () => null;\n");
  return { repoDir, globalDir };
}

function fakeReporter(): Reporter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info: ${m}`),
    start: (m) => lines.push(`start: ${m}`),
    update: (m) => lines.push(`update: ${m}`),
    stop: (m) => lines.push(`stop: ${m}`),
    done: (m) => lines.push(`done: ${m}`),
  };
}

const baseAnswers: InitAnswers = {
  openrouterApiKey: "or-key",
  githubToken: "gh-token",
  secretsChanged: false,
  saveGlobal: false,
  model: "picked/model",
  depths: ["minor", "nits"],
  maxSteps: 12,
};

function makeDeps(overrides: Partial<InitDeps> & { repoDir: string; globalDir: string }): { deps: InitDeps; report: ReturnType<typeof fakeReporter> } {
  const report = fakeReporter();
  const deps: InitDeps = {
    env: {},
    flags: {},
    interactive: false,
    askInit: async () => baseAnswers,
    chatFn: async () => "SUMMARY of the repo",
    report,
    ...overrides,
  };
  return { deps, report };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("readExistingSecrets / readRepoDefaults", () => {
  test("no secrets anywhere -> null", () => {
    const { repoDir, globalDir } = tempWorkspace();
    expect(readExistingSecrets(globalDir, {})).toBeNull();
    expect(readRepoDefaults(repoDir)).toEqual({ model: DEFAULT_MODEL, depths: ["vulnerabilities", "major"], maxSteps: DEFAULT_MAX_STEPS });
  });

  test("global file secrets with source path; env wins with source 'environment'", () => {
    const { globalDir } = tempWorkspace();
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ openrouterApiKey: "file-key", githubToken: "file-tok" }));
    expect(readExistingSecrets(globalDir, {})).toEqual({
      openrouterApiKey: "file-key",
      githubToken: "file-tok",
      source: join(globalDir, "config.json"),
    });
    const withEnv = readExistingSecrets(globalDir, { OPENROUTER_API_KEY: "env-key" });
    expect(withEnv!.openrouterApiKey).toBe("env-key");
    expect(withEnv!.source).toBe("environment");
  });

  test("repo defaults read back what init wrote", () => {
    const { repoDir } = tempWorkspace();
    mkdirSync(join(repoDir, ".squanchy"), { recursive: true });
    writeFileSync(
      join(repoDir, ".squanchy", "config.json"),
      JSON.stringify({ defaultModel: "m/x", defaultDepths: ["nits"], maxSteps: 7 }),
    );
    expect(readRepoDefaults(repoDir)).toEqual({ model: "m/x", depths: ["nits"], maxSteps: 7 });
  });
});

describe("resolveNonInteractive", () => {
  const defaults = { model: DEFAULT_MODEL, depths: ["vulnerabilities", "major"] as Depth[], maxSteps: 25 };

  test("throws without any key", () => {
    expect(() => resolveNonInteractive({}, {}, null, defaults)).toThrow(/No OpenRouter API key/);
  });

  test("env key reused silently, no secretsChanged", () => {
    const a = resolveNonInteractive({}, { OPENROUTER_API_KEY: "env-key" }, null, defaults);
    expect(a.openrouterApiKey).toBe("env-key");
    expect(a.secretsChanged).toBe(false);
    expect(a.saveGlobal).toBe(false);
  });

  test("flags beat env and mark secrets for saving", () => {
    const a = resolveNonInteractive({ openrouterKey: "flag-key", githubToken: "flag-tok" }, { OPENROUTER_API_KEY: "env-key" }, null, defaults);
    expect(a.openrouterApiKey).toBe("flag-key");
    expect(a.githubToken).toBe("flag-tok");
    expect(a.secretsChanged).toBe(true);
    expect(a.saveGlobal).toBe(true);
  });

  test("stored secrets are reused when no flag/env", () => {
    const a = resolveNonInteractive({}, {}, { openrouterApiKey: "stored", githubToken: "stored-tok", source: "x" }, defaults);
    expect(a.openrouterApiKey).toBe("stored");
    expect(a.githubToken).toBe("stored-tok");
  });

  test("flags override model/depths/maxSteps", () => {
    const a = resolveNonInteractive({ model: "f/m", depth: "nits", maxSteps: 9 }, { OPENROUTER_API_KEY: "k" }, null, defaults);
    expect(a.model).toBe("f/m");
    expect(a.depths).toEqual(["nits"]);
    expect(a.maxSteps).toBe(9);
  });
});

describe("runInit", () => {
  test("non-interactive with env key: writes repo config + context, no global save", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps, report } = makeDeps({ repoDir, globalDir, env: { OPENROUTER_API_KEY: "env-key" } });
    await runInit(deps);

    const cfg = readJson(join(repoDir, ".squanchy", "config.json"));
    expect(cfg.defaultModel).toBe(DEFAULT_MODEL);
    expect(cfg.defaultDepths).toEqual(["vulnerabilities", "major"]);
    expect(cfg.maxSteps).toBe(DEFAULT_MAX_STEPS);
    const context = readFileSync(join(repoDir, ".squanchy", "context.md"), "utf8");
    expect(context).toContain("SUMMARY of the repo");
    expect(context).toContain("react"); // stack detection fed the summary prompt
    expect(existsSync(join(globalDir, "config.json"))).toBe(false);
    expect(report.lines.some((l) => l.startsWith("start: generating repository context"))).toBe(true);
    expect(report.lines.some((l) => l.startsWith("done:"))).toBe(true);
  });

  test("non-interactive with no key anywhere throws before writing anything", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({ repoDir, globalDir });
    await expect(runInit(deps)).rejects.toThrow(/No OpenRouter API key/);
    expect(existsSync(join(repoDir, ".squanchy", "config.json"))).toBe(false);
  });

  test("non-interactive with key flags saves global config (mode 600)", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      flags: { openrouterKey: "flag-key", githubToken: "flag-tok", model: "f/m", depth: "nits", maxSteps: 5 },
    });
    await runInit(deps);
    const globalPath = join(globalDir, "config.json");
    expect(readJson(globalPath)).toEqual({ openrouterApiKey: "flag-key", githubToken: "flag-tok" });
    expect(statSync(globalPath).mode & 0o777).toBe(0o600);
    const cfg = readJson(join(repoDir, ".squanchy", "config.json"));
    expect(cfg).toEqual({ defaultModel: "f/m", defaultDepths: ["nits"], maxSteps: 5 });
  });

  test("interactive: askInit gets state (existing secrets, stack line, locked flags, repo defaults)", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ openrouterApiKey: "stored-key", githubToken: "stored-tok" }));
    mkdirSync(join(repoDir, ".squanchy"), { recursive: true });
    writeFileSync(join(repoDir, ".squanchy", "config.json"), JSON.stringify({ defaultModel: "repo/model", defaultDepths: ["minor"], maxSteps: 8 }));

    let seenState: InitPromptState | null = null;
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      interactive: true,
      flags: { model: "flag/model" },
      askInit: async (state) => {
        seenState = state;
        return baseAnswers;
      },
    });
    await runInit(deps);

    expect(seenState!.existing!.openrouterApiKey).toBe("stored-key");
    expect(seenState!.existing!.githubToken).toBe("stored-tok");
    expect(seenState!.stackLine).toContain("typescript");
    expect(seenState!.stackLine).toContain("files)");
    expect(seenState!.currentModel).toBe("flag/model"); // flag overrides repo default in state
    expect(seenState!.currentDepths).toEqual(["minor"]);
    expect(seenState!.currentMaxSteps).toBe(8);
    expect(seenState!.locked).toEqual({ credentials: false, model: true, depths: false });
  });

  test("interactive reuse: global config untouched, repo config from answers", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ openrouterApiKey: "stored-key" }));
    const { deps } = makeDeps({ repoDir, globalDir, interactive: true });
    await runInit(deps);
    expect(readJson(join(globalDir, "config.json"))).toEqual({ openrouterApiKey: "stored-key" });
    expect(readJson(join(repoDir, ".squanchy", "config.json"))).toEqual({
      defaultModel: "picked/model",
      defaultDepths: ["minor", "nits"],
      maxSteps: 12,
    });
  });

  test("interactive new credentials with saveGlobal: writes global config", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      interactive: true,
      askInit: async () => ({ ...baseAnswers, secretsChanged: true, saveGlobal: true, openrouterApiKey: "new-key", githubToken: undefined }),
    });
    await runInit(deps);
    const globalPath = join(globalDir, "config.json");
    expect(readJson(globalPath)).toEqual({ openrouterApiKey: "new-key" });
    expect(statSync(globalPath).mode & 0o777).toBe(0o600);
  });

  test("interactive new credentials without saveGlobal: secrets stay out of disk", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      interactive: true,
      askInit: async () => ({ ...baseAnswers, secretsChanged: true, saveGlobal: false }),
    });
    await runInit(deps);
    expect(existsSync(join(globalDir, "config.json"))).toBe(false);
  });

  test("cancel during prompts (askInit throws): nothing is written", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      interactive: true,
      askInit: async () => {
        throw new Error("cancelled");
      },
    });
    await expect(runInit(deps)).rejects.toThrow("cancelled");
    expect(existsSync(join(repoDir, ".squanchy"))).toBe(false);
    expect(existsSync(join(globalDir, "config.json"))).toBe(false);
  });

  test("fetchModels helper is passed through to askInit", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const seen: { key: string | null } = { key: null };
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      interactive: true,
      env: { OPENROUTER_API_KEY: "env-key" },
      fetchModels: async (key) => {
        seen.key = key;
        return [];
      },
      askInit: async (_state, helpers) => {
        await helpers.fetchModels("env-key");
        return baseAnswers;
      },
    });
    await runInit(deps);
    expect(seen.key).toBe("env-key");
  });

  test("LLM failure propagates and context.md is not written", async () => {
    const { repoDir, globalDir } = tempWorkspace();
    const { deps } = makeDeps({
      repoDir,
      globalDir,
      env: { OPENROUTER_API_KEY: "env-key" },
      chatFn: async () => {
        throw new Error("OpenRouter 429: rate limited");
      },
    });
    await expect(runInit(deps)).rejects.toThrow(/rate limited/);
    expect(existsSync(join(repoDir, ".squanchy", "config.json"))).toBe(true); // config written before the LLM call
    expect(existsSync(join(repoDir, ".squanchy", "context.md"))).toBe(false);
  });
});
