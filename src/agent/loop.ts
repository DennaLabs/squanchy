import type { AssistantMessage, ChatMessage, ChatWithToolsArgs } from "../openrouter/client";
import type { Finding } from "../types";
import { TOOL_DEFS, executeTool, type ToolCtx } from "./tools";

export interface AgentLoopDeps {
  chatFn: (args: ChatWithToolsArgs) => Promise<AssistantMessage>;
  apiKey: string;
  model: string;
  system: string;
  firstUser: string;
  ctx: ToolCtx;
  maxSteps: number;
  temperature?: number;
  debug?: (line: string) => void;
}

export interface AgentLoopResult {
  findings: Finding[];
  overview: string | null;
  stepsUsed: number;
  finishReason: "finished" | "max-steps" | "text-only";
}

const NUDGE =
  "Continue the review. Record each finding with submit_finding, then call finish_review when you are done.";

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export async function runAgentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const log = deps.debug ?? (() => {});
  const messages: ChatMessage[] = [
    { role: "system", content: deps.system },
    { role: "user", content: deps.firstUser },
  ];
  const findings: Finding[] = [];
  let overview: string | null = null;
  let textStreak = 0;

  for (let step = 1; step <= deps.maxSteps; step++) {
    const asst: AssistantMessage = await deps.chatFn({
      apiKey: deps.apiKey,
      model: deps.model,
      messages,
      tools: TOOL_DEFS,
      temperature: deps.temperature ?? 0.2,
    });
    messages.push({
      role: "assistant",
      content: asst.content,
      ...(asst.toolCalls.length > 0 ? { tool_calls: asst.toolCalls } : {}),
    });
    log(
      `[step ${step}] assistant: ${
        asst.toolCalls.length > 0
          ? asst.toolCalls.map((c) => c.function.name).join(", ")
          : `text (${asst.content?.length ?? 0} chars)`
      }`,
    );

    if (asst.toolCalls.length === 0) {
      textStreak++;
      if (textStreak >= 2) {
        log(`[loop] plain text twice in a row; finishing with ${findings.length} finding(s)`);
        return { findings, overview, stepsUsed: step, finishReason: "text-only" };
      }
      messages.push({ role: "user", content: NUDGE });
      continue;
    }
    textStreak = 0;

    for (const call of asst.toolCalls) {
      const outcome = await executeTool(call.function.name, call.function.arguments, deps.ctx);
      log(`[step ${step}] tool ${call.function.name}(${truncate(call.function.arguments, 120)}) -> ${outcome.kind}`);
      if (outcome.kind === "finding") {
        findings.push(outcome.finding);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `finding recorded (${findings.length} total)`,
        });
        continue;
      }
      if (outcome.kind === "finish") {
        if (outcome.overview) overview = outcome.overview;
        return { findings, overview, stepsUsed: step, finishReason: "finished" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
    }
  }

  log(`[loop] max steps (${deps.maxSteps}) reached; finishing with ${findings.length} finding(s)`);
  return { findings, overview, stepsUsed: deps.maxSteps, finishReason: "max-steps" };
}
