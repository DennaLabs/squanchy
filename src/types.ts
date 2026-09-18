import { z } from "zod";

export const DEPTHS = ["vulnerabilities", "major", "minor", "nits", "full"] as const;
export const DepthSchema = z.enum(DEPTHS);
export type Depth = z.infer<typeof DepthSchema>;

export const ModeSchema = z.enum(["report", "review"]);
export type Mode = z.infer<typeof ModeSchema>;

export const FindingSchema = z.object({
  severity: z.enum(["vulnerability", "major", "minor", "nit", "info"]),
  file: z.string(),
  line: z.number().int().positive().nullable(),
  comment: z.string(),
  suggestion: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewResultSchema = z.object({
  overview: z.string().nullable(),
  findings: z.array(FindingSchema),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface ReviewOptions {
  repo: string; // "owner/name"
  prNumber: number;
  mode: Mode;
  model: string; // openrouter model id
  depths: Depth[];
  overview?: string; // user-supplied PR overview text
}

export interface SquanchyConfig {
  openrouterApiKey?: string;
  githubToken?: string;
  defaultModel: string;
  defaultDepths: Depth[];
  maxSteps: number;
}
