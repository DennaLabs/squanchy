import { parseDepths } from "../review/depth";
import type { Depth, ReviewOptions } from "../types";

export type BotCommand =
  | { type: "none" } // not a squanchy command at all
  | { type: "reply"; reply: string } // help or parse error: post reply, do not review
  | { type: "review"; options: Omit<ReviewOptions, "repo" | "prNumber"> };

export interface BotDefaults {
  model: string;
  depths: Depth[];
}

export const HELP_TEXT = [
  "**squanchy commands** (comment on a PR):",
  "- `/squanchy review` — review with the repo defaults",
  "- `/squanchy review --depth vulnerabilities,major,minor,nits,full` — pick focus areas (csv)",
  "- `/squanchy review --model <openrouter-model-id>` — pick the model",
  "- `/squanchy review --overview <text>` — what the PR is about (text runs to the end of the comment)",
  "- `/squanchy full` — shorthand for a full-depth review",
  "- `/squanchy help` — this message",
  "",
  "Flags combine: `/squanchy review --depth minor,nits --model openai/gpt-5`.",
  "squanchy always posts COMMENT reviews with inline findings; it never approves and never requests changes.",
].join("\n");

const TRIGGER = /^\s*\/squanchy\b[ \t]*/i;
const FLAG = /^(--depth|-d|--model|-m|--overview)\b[ \t]*/;

/** Parse a PR comment into a squanchy command. Anything not starting with /squanchy is `none`. */
export function parseBotCommand(body: string, defaults: BotDefaults): BotCommand {
  const trigger = body.match(TRIGGER);
  if (!trigger) return { type: "none" };
  let rest = body.slice(trigger[0].length);

  const reply = (text: string): BotCommand => ({ type: "reply", reply: `squanchy: ${text}` });

  // subcommand
  let depths = defaults.depths;
  let model = defaults.model;
  const sub = rest.match(/^(\S+)[ \t]*/);
  const subName = (sub?.[1] ?? "").toLowerCase();
  if (subName === "") return { type: "reply", reply: HELP_TEXT };
  if (subName === "help") return { type: "reply", reply: HELP_TEXT };
  if (subName === "full") {
    depths = parseDepths("full");
    rest = rest.slice(sub![0].length);
  } else if (subName === "review") {
    rest = rest.slice(sub![0].length);
  } else if (!subName.startsWith("-")) {
    return reply(`unknown command \`${sub![1]}\`. Try \`/squanchy help\`.`);
  }

  // flags
  let overview: string | undefined;
  while (rest.trim().length > 0) {
    const flag = rest.match(FLAG);
    if (!flag) {
      const word = rest.trim().split(/\s/)[0];
      return reply(`unexpected argument \`${word}\`. Try \`/squanchy help\`.`);
    }
    rest = rest.slice(flag[0].length);
    const name = flag[1];
    if (name === "--overview") {
      overview = rest.trim();
      if (overview === "") return reply("missing text after --overview");
      rest = "";
      break;
    }
    const value = rest.match(/^(\S+)[ \t\s]*/);
    if (!value) return reply(`missing value for ${name}`);
    rest = rest.slice(value[0].length);
    if (name === "--depth" || name === "-d") {
      try {
        depths = parseDepths(value[1]!);
      } catch (err) {
        return reply(
          `invalid --depth \`${value[1]}\`: ${err instanceof Error ? err.message : String(err)}. ` +
            "Valid: vulnerabilities,major,minor,nits,full",
        );
      }
    } else {
      model = value[1]!;
    }
  }

  return {
    type: "review",
    options: { mode: "review", model, depths, ...(overview !== undefined ? { overview } : {}) },
  };
}
