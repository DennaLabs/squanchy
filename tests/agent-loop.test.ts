import { describe, expect, test } from "bun:test";
import { runAgentLoop, type AgentLoopDeps } from "../src/agent/loop";
import type { AssistantMessage, ChatWithToolsArgs, ToolCall } from "../src/openrouter/client";
import type { ToolCtx } from "../src/agent/tools";
import { fixtureBundle } from "./fixtures/pr-bundle";

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function asst(content: string | null, ...toolCalls: ToolCall[]): AssistantMessage {
  return { content, toolCalls };
}

const ctx: ToolCtx = { bundle: fixtureBundle, getSnapshot: async () => ({ kind: "fs" } as never) };

function makeDeps(script: AssistantMessage[], overrides: Partial<AgentLoopDeps> = {}) {
  const calls: ChatWithToolsArgs[] = [];
  const debugLines: string[] = [];
  const deps: AgentLoopDeps = {
    chatFn: async (args) => {
      calls.push({ ...args, messages: [...args.messages] });
      return script[Math.min(calls.length - 1, script.length - 1)]!;
    },
    apiKey: "k",
    model: "m",
    system: "SYSTEM",
    firstUser: "USER",
    ctx,
    maxSteps: 10,
    debug: (l) => debugLines.push(l),
    ...overrides,
  };
  return { deps, calls, debugLines };
}

describe("runAgentLoop", () => {
  test("happy path: findings collected, finish ends the loop", async () => {
    const { deps, calls } = makeDeps([
      asst(null, toolCall("a", "submit_finding", { severity: "major", file: "src/login.ts", line: 3, comment: "bug" })),
      asst(null, toolCall("b", "finish_review", { overview: "done" })),
    ]);
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("finished");
    expect(out.findings.length).toBe(1);
    expect(out.overview).toBe("done");
    expect(out.stepsUsed).toBe(2);
    expect(calls.length).toBe(2);
    // messages as of the 2nd call: system, user, assistant(+tool_calls), tool-result
    const msgs = calls[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[3]!.tool_call_id).toBe("a");
    expect(msgs[3]!.content).toContain("finding recorded (1 total)");
  });

  test("parallel tool calls in one step each get a tool result", async () => {
    const { deps, calls } = makeDeps([
      asst(null, toolCall("a", "get_file_diff", { path: "src/login.ts" }), toolCall("b", "list_dir", { path: "src" })),
      asst(null, toolCall("c", "finish_review", {})),
    ]);
    await runAgentLoop(deps);
    const toolMsgs = calls[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  test("tool errors are fed back, loop continues", async () => {
    const { deps, calls } = makeDeps([
      asst(null, toolCall("a", "read_file", { path: "ghost.ts" })), // snapshot stub -> tool failure
      asst(null, toolCall("b", "finish_review", {})),
    ]);
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("finished");
    const toolMsg = calls[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toMatch(/failed|cannot read|error/i);
  });

  test("max steps cutoff keeps findings collected so far", async () => {
    const finding = toolCall("a", "submit_finding", { severity: "nit", file: "README.md", line: null, comment: "typo" });
    const { deps, calls } = makeDeps([asst(null, finding)], { maxSteps: 4 });
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("max-steps");
    expect(out.stepsUsed).toBe(4);
    expect(calls.length).toBe(4);
    expect(out.findings.length).toBe(4);
  });

  test("first plain text gets a nudge, second ends the loop", async () => {
    const { deps, calls } = makeDeps([asst("hmm"), asst("still thinking")]);
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("text-only");
    expect(calls.length).toBe(2);
    const nudge = calls[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("finish_review");
  });

  test("text after tool use resets the streak", async () => {
    const { deps, calls } = makeDeps([
      asst("let me look"),
      asst(null, toolCall("a", "finish_review", {})),
    ]);
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("finished");
    expect(calls.length).toBe(2);
  });

  test("finish mid-parallel-calls returns immediately", async () => {
    const { deps, calls } = makeDeps([
      asst(null, toolCall("a", "finish_review", {}), toolCall("b", "grep", { pattern: "x" })),
    ]);
    const out = await runAgentLoop(deps);
    expect(out.finishReason).toBe("finished");
    expect(calls.length).toBe(1);
  });

  test("debug hook receives step and tool traces", async () => {
    const { deps, debugLines } = makeDeps([
      asst(null, toolCall("a", "get_file_diff", { path: "src/login.ts" })),
      asst(null, toolCall("b", "finish_review", {})),
    ]);
    await runAgentLoop(deps);
    expect(debugLines.some((l) => l.includes("[step 1]") && l.includes("get_file_diff"))).toBe(true);
    expect(debugLines.some((l) => l.includes("[step 2]"))).toBe(true);
  });

  test("chatFn receives tools and temperature", async () => {
    const { deps, calls } = makeDeps([asst(null, toolCall("a", "finish_review", {}))]);
    await runAgentLoop(deps);
    expect(calls[0]!.tools!.length).toBe(6);
    expect(calls[0]!.temperature).toBe(0.2);
    expect(calls[0]!.model).toBe("m");
  });
});
