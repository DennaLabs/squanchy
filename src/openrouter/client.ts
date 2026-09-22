import { z } from "zod";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 120_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface HttpDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

function friendlyError(status: number, body: string): Error {
  const detail = body.slice(0, 500);
  if (status === 401) return new Error(`OpenRouter 401: invalid API key. ${detail}`);
  if (status === 402)
    return new Error(`OpenRouter 402: credits exhausted. Top up or switch model (-m). ${detail}`);
  if (status === 429)
    return new Error(`OpenRouter 429: rate limited (free-tier models are ~20 req/min, 50/day). ${detail}`);
  return new Error(`OpenRouter ${status}: ${detail}`);
}

/** POST a chat completion with timeout + one retry (honoring Retry-After) on 429/502/503. */
export async function postChatCompletion(apiKey: string, body: unknown, http: HttpDeps = {}): Promise<unknown> {
  const fetchFn = http.fetchFn ?? fetch;
  const sleepFn = http.sleepFn ?? ((ms: number) => Bun.sleep(ms));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/DennaLabs/squanchy",
    "X-Title": "squanchy",
  };
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new Error(
        `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt === 0) {
        await sleepFn(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw lastError;
    }
    if (res.ok) return await res.json();
    const text = await res.text();
    if (RETRYABLE_STATUSES.has(res.status) && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleepFn(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RETRY_DELAY_MS);
      continue;
    }
    throw friendlyError(res.status, text);
  }
  throw lastError ?? new Error("OpenRouter request failed");
}

export interface ChatArgs {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
}

/** Single-shot chat returning the assistant text (used by `squanchy init`). */
export async function chat(args: ChatArgs, http: HttpDeps = {}): Promise<string> {
  const data = await postChatCompletion(
    args.apiKey,
    {
      model: args.model,
      temperature: args.temperature ?? 0.2,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      response_format: { type: "json_object" },
    },
    http,
  );
  const content = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}

// --- tool-calling chat (agent loop) ---

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[]; // assistant messages only
  tool_call_id?: string; // tool-result messages only
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema object
  };
}

export interface ChatWithToolsArgs {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
}

export interface AssistantMessage {
  content: string | null;
  toolCalls: ToolCall[];
}

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const ChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
});

/** One step of the agent loop: send messages (+ tool defs), get the assistant message back. */
export async function chatWithTools(args: ChatWithToolsArgs, http: HttpDeps = {}): Promise<AssistantMessage> {
  const body: Record<string, unknown> = {
    model: args.model,
    temperature: args.temperature ?? 0.2,
    messages: args.messages,
  };
  if (args.tools && args.tools.length > 0) body.tools = args.tools;
  const data = ChatResponseSchema.parse(await postChatCompletion(args.apiKey, body, http));
  const message = data.choices[0].message;
  return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
}
