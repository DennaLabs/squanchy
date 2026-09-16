import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_DEPTHS, parseDepths } from "./review/depth";
import type { SquanchyConfig } from "./types";

export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const FileSchema = z.object({
  openrouterApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultDepths: z.array(z.string()).optional(),
});

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface LoadConfigArgs {
  globalDir: string; // ~/.config/squanchy
  repoDir: string; // cwd (repo root)
  env: Record<string, string | undefined>;
}

export function loadConfig({ globalDir, repoDir, env }: LoadConfigArgs): SquanchyConfig {
  const g = FileSchema.parse(readJsonIfExists(join(globalDir, "config.json")));
  // Repo config only supplies non-secret defaults; keys in it are ignored on purpose.
  const r = FileSchema.pick({ defaultModel: true, defaultDepths: true }).parse(
    readJsonIfExists(join(repoDir, ".squanchy", "config.json")),
  );
  const rawDepths = r.defaultDepths ?? g.defaultDepths;
  return {
    openrouterApiKey: env.OPENROUTER_API_KEY ?? g.openrouterApiKey,
    githubToken: env.GITHUB_TOKEN ?? g.githubToken,
    defaultModel: r.defaultModel ?? g.defaultModel ?? DEFAULT_MODEL,
    defaultDepths: rawDepths ? parseDepths(rawDepths.join(",")) : DEFAULT_DEPTHS,
  };
}

export function saveGlobalConfig(globalDir: string, cfg: Partial<SquanchyConfig>): void {
  mkdirSync(globalDir, { recursive: true });
  const path = join(globalDir, "config.json");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...existing, ...cfg }, null, 2));
  chmodSync(path, 0o600); // writeFileSync mode is masked by umask on overwrite; chmod is authoritative
}
