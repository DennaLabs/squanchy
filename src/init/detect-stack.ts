export interface StackInfo {
  languages: string[];
  frameworks: string[];
  packageManager: string | null; // bun | pnpm | yarn | npm
  testFramework: string | null;
  notableFiles: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sol: "solidity",
};

const FRAMEWORK_DEPS: Record<string, string> = {
  next: "next.js",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  express: "express",
  hono: "hono",
  fastify: "fastify",
  "@nestjs/core": "nestjs",
  remix: "remix",
  "@remix-run/node": "remix",
  astro: "astro",
  tailwindcss: "tailwind",
  prisma: "prisma",
  "drizzle-orm": "drizzle",
  "@tanstack/react-query": "react-query",
  electron: "electron",
  hardhat: "hardhat",
  foundry: "foundry",
};

const TEST_DEPS: Record<string, string> = {
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  "@playwright/test": "playwright",
  cypress: "cypress",
  pytest: "pytest",
};

const NOTABLE = new Set([
  "tsconfig.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  ".github/workflows",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "bunfig.toml",
]);

function depsOf(pkg: unknown): Record<string, string> {
  if (!pkg || typeof pkg !== "object") return {};
  const p = pkg as { dependencies?: unknown; devDependencies?: unknown };
  const out: Record<string, string> = {};
  for (const section of [p.dependencies, p.devDependencies]) {
    if (section && typeof section === "object") {
      for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
        out[k] = String(v);
      }
    }
  }
  return out;
}

export function detectStack(fileList: string[], packageJson: unknown | null): StackInfo {
  const baseNames = new Set(fileList.map((f) => f.split("/").pop() ?? f));

  let packageManager: string | null = null;
  if (baseNames.has("bun.lock") || baseNames.has("bun.lockb")) packageManager = "bun";
  else if (baseNames.has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (baseNames.has("yarn.lock")) packageManager = "yarn";
  else if (baseNames.has("package-lock.json")) packageManager = "npm";

  const languages = new Set<string>();
  for (const f of fileList) {
    const ext = f.split(".").pop()?.toLowerCase();
    if (ext && LANG_BY_EXT[ext]) languages.add(LANG_BY_EXT[ext]);
  }

  const deps = depsOf(packageJson);
  const frameworks = new Set<string>();
  for (const [dep, name] of Object.entries(FRAMEWORK_DEPS)) {
    if (deps[dep]) frameworks.add(name);
  }

  let testFramework: string | null = null;
  for (const [dep, name] of Object.entries(TEST_DEPS)) {
    if (deps[dep]) {
      testFramework = name;
      break;
    }
  }
  if (!testFramework && deps["@types/bun"] && fileList.some((f) => /\.test\.ts$/.test(f))) {
    testFramework = "bun:test";
  }

  const notableFiles = fileList.filter(
    (f) => NOTABLE.has(f) || f.startsWith(".github/workflows/") || NOTABLE.has(f.split("/").pop() ?? ""),
  );

  return {
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    packageManager,
    testFramework,
    notableFiles: notableFiles.slice(0, 50),
  };
}
