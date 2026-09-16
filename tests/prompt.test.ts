import { describe, expect, test } from "bun:test";
import { buildPrompt } from "../src/review/prompt";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewOptions } from "../src/types";

const baseOptions: ReviewOptions = {
  repo: fixtureBundle.repo,
  prNumber: 42,
  mode: "report",
  model: "test-model",
  depths: ["vulnerabilities"],
};

describe("buildPrompt", () => {
  test("system contains requested focus text only", () => {
    const { system } = buildPrompt(fixtureBundle, baseOptions, null);
    expect(system).toContain("Security vulnerabilities");
    expect(system).not.toContain("Nits only");
  });

  test("multiple depths all appear", () => {
    const { system } = buildPrompt(fixtureBundle, { ...baseOptions, depths: ["vulnerabilities", "nits"] }, null);
    expect(system).toContain("Security vulnerabilities");
    expect(system).toContain("Nits only");
  });

  test("user contains every file path and patch", () => {
    const { user } = buildPrompt(fixtureBundle, baseOptions, null);
    expect(user).toContain("src/login.ts");
    expect(user).toContain("README.md");
    expect(user).toContain("+db.run(`SELECT ${q}`);");
    expect(user).toContain("Add login endpoint");
    expect(user).toContain("dev1");
  });

  test("user-provided overview appears verbatim", () => {
    const { user } = buildPrompt(fixtureBundle, { ...baseOptions, overview: "refactors auth flow" }, null);
    expect(user).toContain("refactors auth flow");
  });

  test("repo context injected when present, absent when null", () => {
    const withCtx = buildPrompt(fixtureBundle, baseOptions, "# stack: bun+ts");
    expect(withCtx.user).toContain("# stack: bun+ts");
    expect(withCtx.user).toContain("Repository context");
    const without = buildPrompt(fixtureBundle, baseOptions, null);
    expect(without.user).not.toContain("Repository context");
  });

  test("PR body included when present", () => {
    const { user } = buildPrompt(fixtureBundle, baseOptions, null);
    expect(user).toContain("Implements POST /login");
  });
});
