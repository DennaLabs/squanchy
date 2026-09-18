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

describe("chatWithTools", () => {
  test("returns content and parsed tool calls", async () => {
    const body = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "get_file_diff", arguments: '{"path":"a.ts"}' } },
            ],
          },
        },
      ],
    };
    const http = makeHttp([() => jsonResponse(body)]);
    const messages: ChatMessage[] = [{ role: "user", content: "review" }];
    const out = await chatWithTools({ apiKey: "k", model: "m", messages }, http);
    expect(out.content).toBeNull();
    expect(out.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "get_file_diff", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  test("no tool calls -> empty array, content preserved", async () => {
    const http = makeHttp([() => jsonResponse({ choices: [{ message: { content: "all good" } }] })]);
    const out = await chatWithTools(
      { apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }] },
      http,
    );
    expect(out.toolCalls).toEqual([]);
    expect(out.content).toBe("all good");
  });

  test("malformed response fails validation", async () => {
    const http = makeHttp([() => jsonResponse({ nope: true })]);
    await expect(
      chatWithTools({ apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }] }, http),
    ).rejects.toThrow();
  });
});
