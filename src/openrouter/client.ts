const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_IDLE_MS = 120_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** Total-time cap for non-streaming requests; large diffs + reasoning models routinely exceed 2 min. */
function timeoutMs(): number {
  const raw = Number(process.env.SQUANCHY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Max silence between stream chunks; resets on every chunk, so total duration is uncapped. */
function streamIdleMs(): number {
  const raw = Number(process.env.SQUANCHY_STREAM_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_MS;
}

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

interface PreparedRequest<T> {
  init: RequestInit;
  consume: (res: Response) => Promise<T>;
}

/**
 * POST to OpenRouter with one retry (honoring Retry-After) on 429/502/503, network
 * failures, and consume-phase failures. `prepare` runs per attempt so each attempt
 * gets a fresh abort signal / idle watchdog.
 */
async function requestWithRetry<T>(
  apiKey: string,
  body: unknown,
  http: HttpDeps,
  prepare: () => PreparedRequest<T>,
): Promise<T> {
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
    const { init, consume } = prepare();
    let res: Response;
    try {
      res = await fetchFn(CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...init,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      lastError = new Error(
        isTimeout
          ? `OpenRouter request timed out after ${timeoutMs() / 1000}s (raise SQUANCHY_TIMEOUT_MS, use a smaller diff, or a faster model)`
          : `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt === 0) {
        await sleepFn(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw lastError;
    }
    if (res.ok) {
      try {
        return await consume(res);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0) {
          await sleepFn(DEFAULT_RETRY_DELAY_MS);
          continue;
        }
        throw lastError;
      }
    }
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

/** POST a chat completion with timeout + one retry (honoring Retry-After) on 429/502/503. */
export async function postChatCompletion(apiKey: string, body: unknown, http: HttpDeps = {}): Promise<unknown> {
  return requestWithRetry(apiKey, body, http, () => ({
    init: { signal: AbortSignal.timeout(timeoutMs()) },
    consume: (res) => res.json() as Promise<unknown>,
  }));
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

interface StreamDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamEvent {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  error?: { message?: string; code?: number } | null;
}

interface ToolCallAcc {
  id: string;
  type?: string;
  name: string;
  args: string;
}

/**
 * Aggregate an SSE stream into one AssistantMessage. The idle watchdog aborts if
 * no chunk arrives within streamIdleMs(); total duration is uncapped, so long
 * generations on big PRs are fine as long as tokens keep flowing.
 */
async function readSseAssistantMessage(
  res: Response,
  controller: AbortController,
  idleMs: number,
): Promise<AssistantMessage> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("OpenRouter stream had no body");
  let idleTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleMs);
  };
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = new Map<number, ToolCallAcc>();
  const handleLine = (line: string): boolean => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return false; // skip comments/empty/event lines
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return true;
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      return false; // tolerate keep-alive junk lines
    }
    if (event.error) {
      throw new Error(`OpenRouter stream error: ${event.error.message ?? JSON.stringify(event.error)}`);
    }
    const delta = event.choices?.[0]?.delta;
    if (!delta) return false; // usage/heartbeat events
    if (typeof delta.content === "string") content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const acc = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id !== undefined) acc.id = tc.id;
      if (tc.type !== undefined) acc.type = tc.type;
      if (tc.function?.name !== undefined) acc.name += tc.function.name;
      if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
      toolCalls.set(idx, acc);
    }
    return false;
  };
  resetIdle();
  try {
    let done = false;
    while (!done) {
      let chunk: ReadableStreamDefaultReadValueResult<Uint8Array> | ReadableStreamDefaultReadDoneResult;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (idleTimedOut) {
          throw new Error(
            `OpenRouter stream went idle for ${idleMs / 1000}s (raise SQUANCHY_STREAM_IDLE_MS or use a faster model)`,
          );
        }
        throw err;
      }
      if (chunk.done) break;
      resetIdle();
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (handleLine(line)) {
          done = true;
          break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const calls: ToolCall[] = [...toolCalls.keys()]
    .sort((a, b) => a - b)
    .map((idx) => {
      const acc = toolCalls.get(idx)!;
      if (!acc.id || !acc.name) throw new Error(`OpenRouter stream sent an incomplete tool call (index ${idx})`);
      return { id: acc.id, ...(acc.type !== undefined ? { type: acc.type } : {}), function: { name: acc.name, arguments: acc.args } };
    });
  if (content === "" && calls.length === 0) {
    throw new Error("OpenRouter stream ended without content or tool calls");
  }
  return { content: content === "" ? null : content, toolCalls: calls };
}

/**
 * One step of the agent loop: send messages (+ tool defs), get the assistant message back.
 * Uses streaming so slow models / huge PR prompts only need to keep producing tokens,
 * with one retry (honoring Retry-After) on 429/502/503 and failed streams.
 */
export async function chatWithTools(args: ChatWithToolsArgs, http: HttpDeps = {}): Promise<AssistantMessage> {
  const body: Record<string, unknown> = {
    model: args.model,
    temperature: args.temperature ?? 0.2,
    messages: args.messages,
    stream: true,
  };
  if (args.tools && args.tools.length > 0) body.tools = args.tools;
  const idleMs = streamIdleMs();
  return requestWithRetry(args.apiKey, body, http, () => {
    const controller = new AbortController();
    return {
      init: { signal: controller.signal },
      consume: (res) => readSseAssistantMessage(res, controller, idleMs),
    };
  });
}
