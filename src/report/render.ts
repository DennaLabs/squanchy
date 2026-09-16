import type { ReviewResult } from "../types";

const ICON = { vulnerability: "R", major: "!", minor: "-", nit: ".", info: "i" } as const;

export function renderReport(result: ReviewResult): string {
  const lines: string[] = [];
  if (result.overview) lines.push(`OVERVIEW\n${result.overview}\n`);
  if (result.findings.length === 0) lines.push("No findings. LGTM.");
  const order = ["vulnerability", "major", "minor", "nit", "info"] as const;
  for (const sev of order) {
    for (const f of result.findings.filter((x) => x.severity === sev)) {
      lines.push(`[${ICON[sev]}] ${sev.toUpperCase()} ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`    ${f.comment}`);
      if (f.suggestion) lines.push(`    suggestion: ${f.suggestion}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
