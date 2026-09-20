import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL } from "../src/config";
import { fetchModelOptions, isFreeModel, isUsableForReview, type OpenRouterModel } from "../src/openrouter/models";

function model(partial: Partial<OpenRouterModel> & { id: string }): OpenRouterModel {
  return {
    context_length: 100_000,
    created: 1_700_000_000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["tools"],
    architecture: { input_modalities: ["text"] },
    ...partial,
  };
}

const fixture = [
  model({ id: DEFAULT_MODEL, pricing: { prompt: "0", completion: "0" }, context_length: 1_000_000, created: 10 }),
  model({ id: "small/free-tool:free", pricing: { prompt: "0", completion: "0" }, context_length: 50_000, created: 20 }),
  model({ id: "big/free-tool:free", pricing: { prompt: "0", completion: "0" }, context_length: 500_000, created: 5 }),
  model({ id: "free/no-tools:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] }),
  model({ id: "image/only:free", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["image"] } }),
  model({ id: "anthropic/claude-sonnet-4.5", context_length: 200_000 }),
  model({ id: "openai/gpt-5", context_length: 400_000 }),
  model({ id: "random/paid-model", context_length: 999_999 }),
  model({ id: "x/free1:free", pricing: { prompt: "0", completion: "0" } }),
  model({ id: "x/free2:free", pricing: { prompt: "0", completion: "0" } }),
  model({ id: "x/free3:free", pricing: { prompt: "0", completion: "0" } }),
  model({ id: "x/free4:free", pricing: { prompt: "0", completion: "0" } }),
  model({ id: "x/free5:free", pricing: { prompt: "0", completion: "0" } }),
];

function fakeFetch(data: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(data), { status })) as unknown as typeof fetch;
}

describe("model predicates", () => {
  test("isFreeModel: :free suffix or zero pricing", () => {
    expect(isFreeModel(model({ id: "a/b:free" }))).toBe(true);
    expect(isFreeModel(model({ id: "a/b", pricing: { prompt: "0", completion: "0" } }))).toBe(true);
    expect(isFreeModel(model({ id: "a/b" }))).toBe(false);
  });

  test("isUsableForReview: needs tools + text input", () => {
    expect(isUsableForReview(model({ id: "a/b" }))).toBe(true);
    expect(isUsableForReview(model({ id: "a/b", supported_parameters: [] }))).toBe(false);
    expect(isUsableForReview(model({ id: "a/b", architecture: { input_modalities: ["image"] } }))).toBe(false);
    expect(isUsableForReview(model({ id: "a/b", architecture: undefined }))).toBe(true);
  });
});

describe("fetchModelOptions", () => {
  test("ranks default free model first, then free by context, then curated paid", async () => {
    const options = await fetchModelOptions("k", { fetchFn: fakeFetch({ data: fixture }) });
    const ids = options.map((o) => o.id);
    expect(ids[0]).toBe(DEFAULT_MODEL);
    expect(ids[1]).toBe("big/free-tool:free"); // largest ctx among the rest
    expect(ids).toContain("anthropic/claude-sonnet-4.5");
    expect(ids).toContain("openai/gpt-5");
    const lastFreeIdx = ids.map((x) => x.endsWith(":free")).lastIndexOf(true);
    expect(ids.indexOf("anthropic/claude-sonnet-4.5")).toBeGreaterThan(lastFreeIdx);
  });

  test("excludes non-tool and non-text models and non-curated paid models", async () => {
    const options = await fetchModelOptions("k", { fetchFn: fakeFetch({ data: fixture }) });
    const ids = options.map((o) => o.id);
    expect(ids).not.toContain("free/no-tools:free");
    expect(ids).not.toContain("image/only:free");
    expect(ids).not.toContain("random/paid-model");
  });

  test("caps the list at 8 options", async () => {
    const options = await fetchModelOptions("k", { fetchFn: fakeFetch({ data: fixture }) });
    expect(options.length).toBeLessThanOrEqual(8);
  });

  test("options carry free flag and context length for hints", async () => {
    const options = await fetchModelOptions("k", { fetchFn: fakeFetch({ data: fixture }) });
    const first = options[0]!;
    expect(first.isFree).toBe(true);
    expect(first.contextLength).toBe(1_000_000);
  });

  test("default model missing from list: falls back to biggest free first", async () => {
    const without = fixture.filter((m) => m.id !== DEFAULT_MODEL);
    const options = await fetchModelOptions("k", { fetchFn: fakeFetch({ data: without }) });
    expect(options[0]!.id).toBe("big/free-tool:free");
  });

  test("HTTP failure throws (caller falls back to manual prompt)", async () => {
    await expect(
      fetchModelOptions("k", { fetchFn: fakeFetch({ error: "nope" }, 401) }),
    ).rejects.toThrow(/models failed: 401/);
  });

  test("malformed payload fails validation", async () => {
    await expect(fetchModelOptions("k", { fetchFn: fakeFetch({ nope: true }) })).rejects.toThrow();
  });
});
