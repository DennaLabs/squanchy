import type { PrBundle } from "../github/pr";
import type { ReviewResult } from "../types";

export function filterFindingsToDiff(result: ReviewResult, bundle: PrBundle): ReviewResult {
  const known = new Set(bundle.files.map((f) => f.path));
  return { ...result, findings: result.findings.filter((f) => known.has(f.file)) };
}
