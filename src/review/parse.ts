import type { PrBundle } from "../github/pr";
import { ReviewResultSchema, type ReviewResult } from "../types";

export function parseReviewResult(raw: string): ReviewResult {
  // strip ```json fences if the model added them despite instructions
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return ReviewResultSchema.parse(JSON.parse(cleaned));
}

export function filterFindingsToDiff(result: ReviewResult, bundle: PrBundle): ReviewResult {
  const known = new Set(bundle.files.map((f) => f.path));
  return { ...result, findings: result.findings.filter((f) => known.has(f.file)) };
}
