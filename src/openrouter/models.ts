import { z } from "zod";
import { DEFAULT_MODEL } from "../config";
import type { HttpDeps } from "./client";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 30_000;
const MAX_OPTIONS = 8;

/** Paid models offered (when available) after the free picks; order = display order. */
const CURATED_PAID = [
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
  "anthropic/claude-opus-4.1",
];

const ModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  created: z.number().optional(),
  pricing: z
    .object({ prompt: z.string().optional(), completion: z.string().optional() })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
  architecture: z
    .object({ input_modalities: z.array(z.string()).optional() })
    .optional(),
});

const ModelsResponseSchema = z.object({ data: z.array(ModelSchema) });
export type OpenRouterModel = z.infer<typeof ModelSchema>;

export interface ModelOption {
  id: string;
  name: string;
  isFree: boolean;
  contextLength: number;
}

export function isFreeModel(m: OpenRouterModel): boolean {
  if (m.id.endsWith(":free")) return true;
  const p = m.pricing;
  return p?.prompt === "0" && p?.completion === "0";
}

/** Only models that accept text and support tool calls are usable by the review agent. */
export function isUsableForReview(m: OpenRouterModel): boolean {
  if (!(m.supported_parameters ?? []).includes("tools")) return false;
  const modalities = m.architecture?.input_modalities;
  return !modalities || modalities.includes("text");
}

function toOption(m: OpenRouterModel): ModelOption {
  return {
    id: m.id,
    name: m.name ?? m.id,
    isFree: isFreeModel(m),
    contextLength: m.context_length ?? 0,
  };
}

/**
 * Fetch and rank model options for the init picker:
 * built-in default first (when still free+usable), then other free models by
 * context size, then up to 2 curated paid picks (slots reserved so a long free
 * list can't push them out). Capped at MAX_OPTIONS.
 */
export async function fetchModelOptions(apiKey: string, http: HttpDeps = {}): Promise<ModelOption[]> {
  const fetchFn = http.fetchFn ?? fetch;
  const res = await fetchFn(MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/squanchy",
      "X-Title": "squanchy",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const parsed = ModelsResponseSchema.parse(await res.json());
  const usable = parsed.data.filter(isUsableForReview);

  const free = usable
    .filter(isFreeModel)
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0) || (b.created ?? 0) - (a.created ?? 0));

  const defaultFree = usable.find((m) => m.id === DEFAULT_MODEL && isFreeModel(m));
  const curatedPresent = CURATED_PAID.map((id) => usable.find((m) => m.id === id)).filter(
    (m): m is OpenRouterModel => m !== undefined,
  ).slice(0, 2);
  const freeSlots = Math.max(1, MAX_OPTIONS - 1 - curatedPresent.length);

  const ranked: OpenRouterModel[] = [];
  const seen = new Set<string>();
  const push = (m: OpenRouterModel | undefined) => {
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      ranked.push(m);
    }
  };
  push(defaultFree);
  for (const m of free) {
    if (ranked.length >= 1 + freeSlots) break;
    push(m);
  }
  for (const m of curatedPresent) push(m);
  return ranked.slice(0, MAX_OPTIONS).map(toOption);
}
