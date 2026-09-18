import { DepthSchema, type Depth } from "../types";

export const DEFAULT_DEPTHS: Depth[] = ["vulnerabilities", "major"];

export function parseDepths(raw: string): Depth[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Empty depth list: expected csv of vulnerabilities,major,minor,nits,full");
  }
  const parsed = parts.map((p) => DepthSchema.parse(p));
  if (parsed.includes("full")) {
    return ["vulnerabilities", "major", "minor", "nits", "full"];
  }
  return [...new Set(parsed)];
}
