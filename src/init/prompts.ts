import type { ModelOption } from "../openrouter/models";
import type { Depth } from "../types";

export type { Reporter } from "../ui/reporter";
export { plainReporter } from "../ui/reporter";

export interface ExistingSecrets {
  openrouterApiKey?: string;
  githubToken?: string;
  /** where they came from, for display: "environment" or a config path */
  source: string;
}

export interface InitPromptState {
  /** secrets already configured (global file or env), or null */
  existing: ExistingSecrets | null;
  /** values to preselect: repo config merged over flags merged over built-in defaults */
  currentModel: string;
  currentDepths: Depth[];
  currentMaxSteps: number;
  /** one-line scan summary shown before the prompts, e.g. "typescript · bun · bun:test (812 files)" */
  stackLine: string;
  /** prompts skipped because the value came from a CLI flag */
  locked: { credentials: boolean; model: boolean; depths: boolean };
}

export interface InitAnswers {
  openrouterApiKey: string;
  githubToken?: string;
  /** true when credentials were newly entered in this run */
  secretsChanged: boolean;
  /** persist newly entered credentials to the global config */
  saveGlobal: boolean;
  model: string;
  depths: Depth[];
  maxSteps: number;
}

export interface AskInitHelpers {
  fetchModels: (apiKey: string) => Promise<ModelOption[]>;
}

export type AskInit = (state: InitPromptState, helpers: AskInitHelpers) => Promise<InitAnswers>;

export function maskSecret(secret: string): string {
  return secret.length <= 10 ? "***" : `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}
