import { describe, expect, test } from "bun:test";
import { chat, chatWithTools, postChatCompletion, type ChatMessage } from "../src/openrouter/client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

function makeHttp(responses: (() => Response | Promise<Response> | never)[]) {
  const calls: number[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchFn = (async (_url: unknown, _init: unknown) => {
    calls.push(i);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return await next();
  }) as unknown as typeof fetch;
  const sleepFn = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetchFn, sleepFn, calls, sleeps };
}

const OK_BODY = { choices: [{ message: { content: "hi" } }] };

describe("postChatCompletion resilience", () => {
  test("success on first attempt: no retry, no sleep", async () => {
    const http = makeHttp([() => jsonResponse(OK_BODY)]);
    const out = (await postChatCompletion("k", {}, http)) as typeof OK_BODY;
    expect(out.choices[0].message.content).toBe("hi");
    expect(http.calls.length).toBe(1);
    expect(http.sleeps.length).toBe(0);
  });

  test("429 then success: retries once honoring Retry-After", async () => {
    const http = makeHttp([() => textResponse(429, "slow down", { "Retry-After": "3" }), () => jsonResponse(OK_BODY)]);
    await postChatCompletion("k", {}, http);
    expect(http.calls.length).toBe(2);
    expect(http.sleeps).toEqual([3000]);
  });

  test("502 with no Retry-After uses default backoff", async () => {
    const http = makeHttp([() => textResponse(502, "bad gateway"), () => jsonResponse(OK_BODY)]);
    await postChatCompletion("k", {}, http);
    expect(http.sleeps).toEqual([2000]);
  });

  test("429 twice gives up with rate-limit message", async () => {
    const http = makeHttp([() => textResponse(429, "nope")]);
    await expect(postChatCompletion("k", {}, http)).rejects.toThrow(/rate limited/i);
    expect(http.calls.length).toBe(2);
  });

  test("400 is not retried", async () => {
    const http = makeHttp([() => textResponse(400, "bad request")]);
    await expect(postChatCompletion("k", {}, http)).rejects.toThrow(/OpenRouter 400/);
    expect(http.calls.length).toBe(1);
  });

  test("402 gets a credits-specific message", async () => {
    const http = makeHttp([() => textResponse(402, "payment required")]);
    await expect(postChatCompletion("k", {}, http)).rejects.toThrow(/credits exhausted/i);
  });

  test("401 gets an invalid-key message", async () => {
    const http = makeHttp([() => textResponse(401, "unauthorized")]);
    await expect(postChatCompletion("k", {}, http)).rejects.toThrow(/invalid API key/i);
  });

  test("network failure then success", async () => {
    const http = makeHttp([
      () => {
        throw new Error("connection reset");
      },
      () => jsonResponse(OK_BODY),
    ]);
    await postChatCompletion("k", {}, http);
    expect(http.calls.length).toBe(2);
  });

  test("network failure twice throws", async () => {
    const http = makeHttp([
      () => {
        throw new Error("connection reset");
      },
    ]);
    await expect(postChatCompletion("k", {}, http)).rejects.toThrow(/request failed.*connection reset/s);
  });
});

describe("chat", () => {
  test("extracts content", async () => {
    const http = makeHttp([() => jsonResponse(OK_BODY)]);
    await expect(chat({ apiKey: "k", model: "m", system: "s", user: "u" }, http)).resolves.toBe("hi");
  });

  test("empty content throws", async () => {
    const http = makeHttp([() => jsonResponse({ choices: [{ message: {} }] })]);
    await expect(chat({ apiKey: "k", model: "m", system: "s", user: "u" }, http)).rejects.toThrow(/empty content/);
  });
});

describe("chatWithTools (streaming)", () => {
  function sseResponse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  const messages: ChatMessage[] = [{ role: "user", content: "review" }];

  test("aggregates content deltas split across events and chunks", async () => {
    const http = makeHttp([
      () => sseResponse(['data: {"choices":[{"delta":{"content":"all "}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"good"}}]}\n\ndata: [DONE]\n\n']),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.content).toBe("all good");
    expect(out.toolCalls).toEqual([]);
  });

  test("aggregates tool call fragments across events", async () => {
    const http = makeHttp([
      () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"get_file_diff","arguments":"{\\"path\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.content).toBeNull();
    expect(out.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "get_file_diff", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  test("multiple tool calls keep index order", async () => {
    const http = makeHttp([
      () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"second","arguments":"{}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"first","arguments":"{}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.toolCalls.map((c) => c.function.name)).toEqual(["first", "second"]);
  });

  test("mid-stream error event rejects and retries once", async () => {
    const http = makeHttp([
      () => sseResponse(['data: {"error":{"message":"upstream overloaded"}}\n\n']),
    ]);
    await expect(chatWithTools({ apiKey: "k", model: "m", messages }, http)).rejects.toThrow(/stream error.*upstream overloaded/s);
    expect(http.calls.length).toBe(2);
  });

  test("empty stream (no content, no tool calls) rejects", async () => {
    const http = makeHttp([() => sseResponse(["data: [DONE]\n\n"])]);
    await expect(chatWithTools({ apiKey: "k", model: "m", messages }, http)).rejects.toThrow(/without content or tool calls/);
  });

  test("429 before stream retries honoring Retry-After", async () => {
    const http = makeHttp([
      () => textResponse(429, "slow down", { "Retry-After": "1" }),
      () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.content).toBe("ok");
    expect(http.sleeps).toEqual([1000]);
  });

  test("final usage chunk is captured with tokens and cost", async () => {
    const http = makeHttp([
      () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290,"cost":0.0042}}\n\n',
          "data: [DONE]\n\n",
        ]),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.content).toBe("hi");
    expect(out.usage).toEqual({ inputTokens: 1234, outputTokens: 56, costUsd: 0.0042 });
  });

  test("usage without cost reports null cost", async () => {
    const http = makeHttp([
      () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ]),
    ]);
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: null });
  });

  test("request body enables streaming and usage reporting", async () => {
    const sent: { body: Record<string, unknown> | null } = { body: null };
    const fetchFn = (async (_url: unknown, init: { body?: string }) => {
      sent.body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    await chatWithTools({ apiKey: "k", model: "m", messages }, { fetchFn, sleepFn: async () => {} });
    expect(sent.body?.stream).toBe(true);
    expect(sent.body?.usage).toEqual({ include: true });
  });

  test("idle stream aborts with idle-timeout message", async () => {
    process.env.SQUANCHY_STREAM_IDLE_MS = "30";
    try {
      const calls: number[] = [];
      // wire the abort signal to the stream, like a real fetch does
      const fetchFn = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
        calls.push(1);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as unknown as typeof fetch;
      const http = { fetchFn, sleepFn: async () => {} };
      await expect(chatWithTools({ apiKey: "k", model: "m", messages }, http)).rejects.toThrow(/went idle/);
      expect(calls.length).toBe(2);
    } finally {
      delete process.env.SQUANCHY_STREAM_IDLE_MS;
    }
  });
});
