import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

describe("cli version", () => {
  test("--version reports the package.json version (semantic-release stays in sync)", async () => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "bin", "squanchy.ts"), "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(out).toBe(pkg.version);
  });

  test("no args prints help with commands and quickstart", async () => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "bin", "squanchy.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Commands:");
    expect(out).toContain("review");
    expect(out).toContain("init");
    expect(out).toContain("Quickstart:");
  });

  test("missing required arg shows help hint", async () => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "bin", "squanchy.ts"), "review"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
    expect(err).toContain("squanchy --help");
  });
});
