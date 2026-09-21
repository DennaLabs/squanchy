import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { runReview, type ReviewEvent, type RunReviewDeps } from "../src/review/run";
import type { AssistantMessage, ChatWithToolsArgs, ToolCall } from "../src/openrouter/client";
import type { GrepMatch, RepoSnapshot } from "../src/snapshot/snapshot";
import { fixtureBundle } from "./fixtures/pr-bundle";
import type { ReviewOptions } from "../src/types";

function fakeOctokit(): Octokit {
  const rawFiles = fixtureBundle.files.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  return {
    pulls: {
      get: async () => ({
        data: {
          title: fixtureBundle.title,
          body: fixtureBundle.body,
          user: { login: fixtureBundle.author },
          base: { sha: fixtureBundle.baseSha },
          head: { sha: fixtureBundle.headSha },
        },
      }),
    },
    paginate: {
      iterator: () =>
        (async function* () {
          yield { data: rawFiles };
        })(),
    },
    rest: { pulls: { listFiles: {} } },
  } as unknown as Octokit;
}

const options: ReviewOptions = {
  repo: fixtureBundle.repo,
  prNumber: 42,
  mode: "report",
  model: "test-model",
  depths: ["vulnerabilities"],
};

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function asst(content: string | null, ...toolCalls: ToolCall[]): AssistantMessage {
  return { content, toolCalls };
}

function fakeSnapshot(onDispose: () => void): RepoSnapshot {
  return {
    kind: "fs",
    readFile: async (p: string) => (p === "src/login.ts" ? "const q = req.body.q;\ndb.run(`SELECT ${q}`);\n" : null),
    listDir: async () => ["src/"],
    grep: async (): Promise<GrepMatch[]> => [],
    dispose: async () => onDispose(),
  };
}

interface Harness {
  deps: RunReviewDeps;
  posted: unknown[];
  chatCalls: ChatWithToolsArgs[];
  snapshotCreated: number;
  snapshotDisposed: number;
  events: ReviewEvent[];
}

function makeDeps(script: AssistantMessage[], opts: { maxSteps?: number } = {}): Harness {
  const posted: unknown[] = [];
  const chatCalls: ChatWithToolsArgs[] = [];
  const events: ReviewEvent[] = [];
  const h: Harness = {
    deps: null as unknown as RunReviewDeps,
    posted,
    chatCalls,
    snapshotCreated: 0,
    snapshotDisposed: 0,
    events,
  };
  h.deps = {
    octokit: fakeOctokit(),
    apiKey: "test-key",
    chatWithTools: async (args) => {
      chatCalls.push({ ...args, messages: [...args.messages] });
      const i = chatCalls.length - 1;
      return script[Math.min(i, script.length - 1)]!;
    },
    readRepoContext: () => null,
    createSnapshot: () => {
      h.snapshotCreated++;
      return fakeSnapshot(() => h.snapshotDisposed++);
    },
    postReview: async (_bundle, result) => {
      posted.push(result);
      return { htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" };
    },
    maxSteps: opts.maxSteps,
    onProgress: (e) => events.push(e),
  };
  return h;
}

const sqliFinding = toolCall("c1", "submit_finding", {
  severity: "vulnerability",
  file: "src/login.ts",
  line: 3,
  comment: "SQL injection: user input interpolated into query",
  suggestion: "db.run('SELECT ?', [q])",
});
const finish = toolCall("c9", "finish_review", {});

describe("runReview (agent loop)", () => {
  test("report mode never posts, findings pass through", async () => {
    const h = makeDeps([asst(null, sqliFinding), asst(null, finish)]);
    const result = await runReview(options, h.deps);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe("vulnerability");
    expect(h.posted.length).toBe(0);
  });

  test("review mode posts once and records url", async () => {
    const h = makeDeps([asst(null, sqliFinding), asst(null, finish)]);
    const result = await runReview({ ...options, mode: "review" }, h.deps);
    expect(h.posted.length).toBe(1);
    expect(result.overview).toContain("Posted: https://github.com/acme/widgets/pull/42");
  });

  test("finish_review overview is kept", async () => {
    const h = makeDeps([asst(null, toolCall("c1", "finish_review", { overview: "Adds login." }))]);
    const result = await runReview({ ...options, depths: ["full"] }, h.deps);
    expect(result.overview).toContain("Adds login.");
  });

  test("findings on unknown files are filtered", async () => {
    const ghost = toolCall("c1", "submit_finding", {
      severity: "nit",
      file: "ghost.ts",
      line: 1,
      comment: "boo",
    });
    const h = makeDeps([asst(null, ghost), asst(null, finish)]);
    const result = await runReview(options, h.deps);
    expect(result.findings.length).toBe(0);
  });

  test("snapshot is lazy: not created when no repo tools are used", async () => {
    const h = makeDeps([asst(null, finish)]);
    await runReview(options, h.deps);
    expect(h.snapshotCreated).toBe(0);
    expect(h.snapshotDisposed).toBe(0);
  });

  test("read_file creates the snapshot once and disposes it after the loop", async () => {
    const read = toolCall("c1", "read_file", { path: "src/login.ts" });
    const h = makeDeps([asst(null, read), asst(null, read), asst(null, finish)]);
    await runReview(options, h.deps);
    expect(h.snapshotCreated).toBe(1);
    expect(h.snapshotDisposed).toBe(1);
  });

  test("invalid tool args feed an error back and the loop continues", async () => {
    const badFinding = toolCall("c1", "submit_finding", { severity: "critical", file: "x", line: 1, comment: "y" });
    const h = makeDeps([asst(null, badFinding), asst(null, sqliFinding), asst(null, finish)]);
    const result = await runReview(options, h.deps);
    expect(h.chatCalls.length).toBe(3);
    const toolMsgs = h.chatCalls[2]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content?.includes("invalid arguments"))).toBe(true);
    expect(result.findings.length).toBe(1);
  });

  test("unknown tool does not crash the loop", async () => {
    const h = makeDeps([asst(null, toolCall("c1", "frobnicate", {})), asst(null, finish)]);
    const result = await runReview(options, h.deps);
    expect(result.findings.length).toBe(0);
  });

  test("max steps cutoff returns findings collected so far", async () => {
    const grep = toolCall("c1", "grep", { pattern: "db.run" });
    const h = makeDeps([asst(null, grep)], { maxSteps: 3 });
    const result = await runReview(options, h.deps);
    expect(h.chatCalls.length).toBe(3);
    expect(result.findings.length).toBe(0);
  });

  test("text-only model finishes without findings", async () => {
    const h = makeDeps([asst("looks fine to me")]);
    const result = await runReview(options, h.deps);
    expect(h.chatCalls.length).toBe(2); // nudge, then give up
    expect(result.findings.length).toBe(0);
  });

  test("system prompt carries focus text and first message carries the diff", async () => {
    const h = makeDeps([asst(null, finish)]);
    await runReview(options, h.deps);
    const msgs = h.chatCalls[0]!.messages;
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("Security vulnerabilities");
    expect(msgs[1]!.content).toContain("+db.run(`SELECT ${q}`);");
    expect(h.chatCalls[0]!.tools?.length).toBeGreaterThan(0);
  });
});

describe("tool ctx wiring", () => {
  test("get_file_diff serves patches from the bundle without a snapshot", async () => {
    const diff = toolCall("c1", "get_file_diff", { path: "src/login.ts" });
    const h = makeDeps([asst(null, diff), asst(null, finish)]);
    await runReview(options, h.deps);
    expect(h.snapshotCreated).toBe(0);
    const toolMsg = h.chatCalls[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("```diff");
  });
});

describe("onProgress lifecycle events", () => {
  test("report mode: pr-fetch/fetched, agent events, done; no snapshot or posted events", async () => {
    const h = makeDeps([asst(null, sqliFinding), asst(null, finish)]);
    await runReview(options, h.deps);
    const types = h.events.map((e) => e.type);
    expect(types[0]).toBe("pr-fetch");
    expect(types[1]).toBe("pr-fetched");
    expect(types.at(-1)).toBe("done");
    expect(types).not.toContain("snapshot");
    expect(types).not.toContain("posted");
    const fetched = h.events[1] as Extract<ReviewEvent, { type: "pr-fetched" }>;
    expect(fetched).toMatchObject({
      repo: "acme/widgets",
      prNumber: 42,
      title: "Add login endpoint",
      files: 2,
      additions: 4,
      deletions: 1,
      headSha: "bbb222",
    });
    expect(h.events.some((e) => e.type === "agent")).toBe(true);
    const done = h.events.at(-1) as Extract<ReviewEvent, { type: "done" }>;
    expect(done.findings).toBe(1);
    expect(done.seconds).toBeGreaterThanOrEqual(0);
  });

  test("snapshot event fires lazily with the backend kind", async () => {
    const read = toolCall("c1", "read_file", { path: "src/login.ts" });
    const h = makeDeps([asst(null, read), asst(null, finish)]);
    await runReview(options, h.deps);
    const snapshot = h.events.find((e) => e.type === "snapshot");
    expect(snapshot).toEqual({ type: "snapshot", kind: "fs" });
    const snapshotIdx = h.events.indexOf(snapshot!);
    expect(snapshotIdx).toBeGreaterThan(h.events.findIndex((e) => e.type === "pr-fetched"));
  });

  test("review mode emits posted before done", async () => {
    const h = makeDeps([asst(null, sqliFinding), asst(null, finish)]);
    await runReview({ ...options, mode: "review" }, h.deps);
    const posted = h.events.find((e) => e.type === "posted") as Extract<ReviewEvent, { type: "posted" }>;
    expect(posted.url).toBe("https://github.com/acme/widgets/pull/42#pullrequestreview-1");
    expect(posted.findings).toBe(1);
    expect(h.events.indexOf(posted)).toBeLessThan(h.events.findIndex((e) => e.type === "done"));
  });
});
