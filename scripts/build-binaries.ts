// Build self-contained squanchy binaries for all supported platforms.
// Usage: bun run scripts/build-binaries.ts [target-filter]
// Output: dist/squanchy-<os>-<arch>[.exe]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  { name: "linux-x64", target: "bun-linux-x64" },
  { name: "linux-arm64", target: "bun-linux-arm64" },
  { name: "darwin-x64", target: "bun-darwin-x64" },
  { name: "darwin-arm64", target: "bun-darwin-arm64" },
  { name: "windows-x64", target: "bun-windows-x64" },
] as const;

const filter = process.argv[2];
const selected = filter ? TARGETS.filter((t) => t.name.includes(filter)) : [...TARGETS];
if (selected.length === 0) {
  console.error(`no target matches "${filter}". Known: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });

for (const { name, target } of selected) {
  const outfile = join(root, "dist", `squanchy-${name}${name.startsWith("windows") ? ".exe" : ""}`);
  console.log(`building ${name} ...`);
  const proc = Bun.spawnSync(
    ["bun", "build", "--compile", `--target=${target}`, "--minify", "bin/squanchy.ts", "--outfile", outfile],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    console.error(`build failed for ${name}`);
    process.exit(proc.exitCode ?? 1);
  }
}
console.log(`done: ${selected.map((t) => t.name).join(", ")} -> dist/`);
