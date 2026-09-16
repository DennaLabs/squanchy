import { describe, expect, test } from "bun:test";
import { detectStack } from "../src/init/detect-stack";

describe("detectStack", () => {
  test("package manager from lockfiles", () => {
    expect(detectStack(["bun.lock", "src/a.ts"], null).packageManager).toBe("bun");
    expect(detectStack(["bun.lockb"], null).packageManager).toBe("bun");
    expect(detectStack(["pnpm-lock.yaml"], null).packageManager).toBe("pnpm");
    expect(detectStack(["yarn.lock"], null).packageManager).toBe("yarn");
    expect(detectStack(["package-lock.json"], null).packageManager).toBe("npm");
    expect(detectStack(["README.md"], null).packageManager).toBeNull();
  });

  test("languages from extensions", () => {
    const s = detectStack(["a.ts", "b.tsx", "c.py", "d.go", "e.rs", "f.js", "g.md"], null);
    expect(s.languages).toContain("typescript");
    expect(s.languages).toContain("python");
    expect(s.languages).toContain("go");
    expect(s.languages).toContain("rust");
    expect(s.languages).toContain("javascript");
    expect(s.languages).not.toContain("markdown");
  });

  test("frameworks from package.json deps", () => {
    const pkg = {
      dependencies: { next: "15.0.0", react: "19.0.0", hono: "4.0.0" },
      devDependencies: { vitest: "2.0.0" },
    };
    const s = detectStack(["package.json"], pkg);
    expect(s.frameworks).toContain("next.js");
    expect(s.frameworks).toContain("react");
    expect(s.frameworks).toContain("hono");
    expect(s.testFramework).toBe("vitest");
  });

  test("test framework detection", () => {
    expect(detectStack([], { devDependencies: { jest: "29" } }).testFramework).toBe("jest");
    expect(detectStack(["tests/x.test.ts"], { dependencies: { "@types/bun": "1" } }).testFramework).toBe("bun:test");
    expect(detectStack([], null).testFramework).toBeNull();
  });

  test("notable config files", () => {
    const s = detectStack(["tsconfig.json", "Dockerfile", ".github/workflows/ci.yml", "src/x.ts"], null);
    expect(s.notableFiles).toContain("tsconfig.json");
    expect(s.notableFiles).toContain("Dockerfile");
    expect(s.notableFiles).toContain(".github/workflows/ci.yml");
  });

  test("malformed package.json tolerated", () => {
    expect(() => detectStack(["package.json"], "not-an-object")).not.toThrow();
  });
});
