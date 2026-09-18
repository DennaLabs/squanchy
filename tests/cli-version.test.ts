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
});
