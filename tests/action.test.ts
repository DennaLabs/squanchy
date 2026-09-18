import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { runAction, type ActionDeps, type ActionEnv } from "../src/action/main";
import type { AssistantMessage, ChatWithToolsArgs, ToolCall } from "../src/openrouter/client";
import { fixtureBundle } from "./fixtures/pr-bundle";

interface Calls {
  comments: string[];
  reactions: { content: string; comment_id: number }[];
  reviews: Record<string, unknown>[];
  chatCalls: ChatWithToolsArgs[];
  logs: string[];
}

function fakeOctokit(calls: Calls): Octokit {
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
      createReview: async (args: Record<string, unknown>) => {
        calls.reviews.push(args);
        return { data: { html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-9" } };
      },
    },
    paginate: {
      iterator: () =>
        (async function* () {
          yield { data: rawFiles };
        })(),
    },
    rest: {
      pulls: { listFiles: {} },
      issues: {
        createComment: async (args: { body: string }) => {
          calls.comments.push(args.body);
          return { data: {} };
        },
      },
      reactions: {
        createForIssueComment: async (args: { comment_id: number; content: string }) => {
          calls.reactions.push({ content: args.content, comment_id: args.comment_id });
          return { data: {} };
        },
      },
    },
  } as unknown as Octokit;
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const finding = toolCall("f1", "submit_finding", {
  severity: "vulnerability",
  file: "src/login.ts",
  line: 3,
  comment: "SQL injection: user input interpolated into query",
});
const finish = toolCall("f2", "finish_review", {});

const happyScript: AssistantMessage[] = [
  { content: null, toolCalls: [finding] },
  { content: null, toolCalls: [finish] },
];

const baseEnv: ActionEnv = {
  SQUANCHY_COMMENT: "/squanchy review",
  SQUANCHY_COMMENT_ID: "777",
  SQUANCHY_PR_URL: "https://github.com/acme/widgets/pull/42",
  SQUANCHY_AUTHOR_ASSOCIATION: "OWNER",
  GITHUB_TOKEN: "gh-token",
  OPENROUTER_API_KEY: "or-key",
};

function makeDeps(env: ActionEnv, script: AssistantMessage[], repoDir = "/nonexistent-sq-repo"): { deps: ActionDeps; calls: Calls } {
  const calls: Calls = { comments: [], reactions: [], reviews: [], chatCalls: [], logs: [] };
  const deps: ActionDeps = {
    env,
    octokitFactory: () => fakeOctokit(calls),
    chatWithTools: async (args) => {
      calls.chatCalls.push({ ...args, messages: [...args.messages] });
      return script[Math.min(calls.chatCalls.length - 1, script.length - 1)]!;
    },
    log: (msg) => calls.logs.push(msg),
    repoDir,
    globalDir: "/nonexistent-sq-global",
  };
  return { deps, calls };
}

describe("runAction", () => {
  test("non-command comment: silent exit, zero API calls", async () => {
    const { deps, calls } = makeDeps({ ...baseEnv, SQUANCHY_COMMENT: "looks good to me" }, happyScript);
    expect(await runAction(deps)).toBe(0);
    expect(calls.comments.length).toBe(0);
    expect(calls.reviews.length).toBe(0);
    expect(calls.reactions.length).toBe(0);
  });

  test("disallowed association: silent exit even for a valid command", async () => {
    const { deps, calls } = makeDeps({ ...baseEnv, SQUANCHY_AUTHOR_ASSOCIATION: "NONE" }, happyScript);
    expect(await runAction(deps)).toBe(0);
    expect(calls.chatCalls.length).toBe(0);
    expect(calls.logs.some((l) => l.includes("not allowed"))).toBe(true);
  });

  test("/squanchy review: eyes reaction, one COMMENT review, success comment, exit 0", async () => {
    const { deps, calls } = makeDeps(baseEnv, happyScript);
    expect(await runAction(deps)).toBe(0);
    expect(calls.reactions).toEqual([{ content: "eyes", comment_id: 777 }]);
    expect(calls.reviews.length).toBe(1);
    expect(calls.reviews[0]!.event).toBe("COMMENT");
    expect(calls.reviews[0]!.commit_id).toBe(fixtureBundle.headSha);
    const inline = calls.reviews[0]!.comments as { path: string; line: number; side: string; body: string }[];
    expect(inline.length).toBe(1);
    expect(inline[0]!.path).toBe("src/login.ts");
    expect(inline[0]!.line).toBe(3);
    expect(inline[0]!.side).toBe("RIGHT");
    expect(inline[0]!.body).toContain("SQL injection");
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]).toContain("squanchy reviewed");
    expect(calls.comments[0]).toContain("1 finding(s)");
    expect(calls.comments[0]).toContain("pullrequestreview-9");
  });

  test("/squanchy help: replies with help text, no review", async () => {
    const { deps, calls } = makeDeps({ ...baseEnv, SQUANCHY_COMMENT: "/squanchy help" }, happyScript);
    expect(await runAction(deps)).toBe(0);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]).toContain("squanchy commands");
    expect(calls.reviews.length).toBe(0);
  });

  test("bad flag: error reply, no review", async () => {
    const { deps, calls } = makeDeps({ ...baseEnv, SQUANCHY_COMMENT: "/squanchy review --bogus 1" }, happyScript);
    expect(await runAction(deps)).toBe(0);
    expect(calls.comments[0]).toContain("--bogus");
    expect(calls.reviews.length).toBe(0);
  });

  test("review failure: posts failure comment and exits 1", async () => {
    const { deps, calls } = makeDeps(baseEnv, []);
    deps.chatWithTools = async () => {
      throw new Error("boom");
    };
    expect(await runAction(deps)).toBe(1);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]).toContain("squanchy failed");
    expect(calls.comments[0]).toContain("boom");
  });

  test("missing OPENROUTER_API_KEY: actionable failure comment, exit 1", async () => {
    const env = { ...baseEnv };
    delete env.OPENROUTER_API_KEY;
    const { deps, calls } = makeDeps(env, happyScript);
    expect(await runAction(deps)).toBe(1);
    expect(calls.comments[0]).toContain("OPENROUTER_API_KEY");
    expect(calls.reviews.length).toBe(0);
  });

  test("missing GITHUB_TOKEN: exits 1 without any API call", async () => {
    const env = { ...baseEnv };
    delete env.GITHUB_TOKEN;
    const { deps, calls } = makeDeps(env, happyScript);
    expect(await runAction(deps)).toBe(1);
    expect(calls.comments.length).toBe(0);
  });

  test("workflow env overrides reach the model call", async () => {
    const { deps, calls } = makeDeps(
      { ...baseEnv, SQUANCHY_MODEL: "custom/model", SQUANCHY_DEPTH: "nits" },
      happyScript,
    );
    await runAction(deps);
    expect(calls.chatCalls[0]!.model).toBe("custom/model");
    expect(calls.chatCalls[0]!.messages[0]!.content).toContain("Nits only");
  });

  test("comment flags override workflow env", async () => {
    const { deps, calls } = makeDeps(
      { ...baseEnv, SQUANCHY_COMMENT: "/squanchy review -m comment/model", SQUANCHY_MODEL: "env/model" },
      happyScript,
    );
    await runAction(deps);
    expect(calls.chatCalls[0]!.model).toBe("comment/model");
  });

  test("repo context.md from the workspace is injected into the first message", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sq-action-"));
    mkdirSync(join(repoDir, ".squanchy"), { recursive: true });
    writeFileSync(join(repoDir, ".squanchy", "context.md"), "# Repo\nstack: bun+ts marker\n");
    try {
      const { deps, calls } = makeDeps(baseEnv, happyScript, repoDir);
      await runAction(deps);
      expect(calls.chatCalls[0]!.messages[1]!.content).toContain("stack: bun+ts marker");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
