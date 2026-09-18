import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseBotCommand, type BotCommand, type BotDefaults } from "../src/action/command";
import { DEFAULT_DEPTHS } from "../src/review/depth";

const defaults: BotDefaults = { model: "default-model", depths: DEFAULT_DEPTHS };

function review(cmd: BotCommand) {
  if (cmd.type !== "review") throw new Error(`expected review, got ${cmd.type}`);
  return cmd.options;
}

describe("parseBotCommand", () => {
  test("non-command comments are ignored", () => {
    expect(parseBotCommand("looks great!", defaults).type).toBe("none");
    expect(parseBotCommand("/other review", defaults).type).toBe("none");
    expect(parseBotCommand("LGTM /squanchy is nice", defaults).type).toBe("none"); // not at start
    expect(parseBotCommand("", defaults).type).toBe("none");
  });

  test("case-insensitive trigger and leading whitespace", () => {
    expect(review(parseBotCommand("  /Squanchy REVIEW", defaults)).model).toBe("default-model");
  });

  test("bare /squanchy replies with help", () => {
    const cmd = parseBotCommand("/squanchy", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("squanchy commands");
  });

  test("help command", () => {
    const cmd = parseBotCommand("/squanchy help", defaults);
    expect(cmd).toEqual({ type: "reply", reply: HELP_TEXT });
  });

  test("bare review uses defaults, mode is always review", () => {
    const opts = review(parseBotCommand("/squanchy review", defaults));
    expect(opts).toEqual({ mode: "review", model: "default-model", depths: DEFAULT_DEPTHS });
  });

  test("--depth overrides, csv parsed", () => {
    const opts = review(parseBotCommand("/squanchy review --depth nits", defaults));
    expect(opts.depths).toEqual(["nits"]);
    const two = review(parseBotCommand("/squanchy review -d vulnerabilities,minor", defaults));
    expect(two.depths).toEqual(["vulnerabilities", "minor"]);
  });

  test("--model overrides", () => {
    const opts = review(parseBotCommand("/squanchy review -m openai/gpt-5", defaults));
    expect(opts.model).toBe("openai/gpt-5");
  });

  test("flags combine in any order", () => {
    const opts = review(
      parseBotCommand("/squanchy review --model x/y --depth full -m z/w", defaults),
    );
    expect(opts.model).toBe("z/w"); // last wins
    expect(opts.depths).toContain("full");
  });

  test("full shorthand expands depths", () => {
    const opts = review(parseBotCommand("/squanchy full", defaults));
    expect(opts.depths).toEqual(["vulnerabilities", "major", "minor", "nits", "full"]);
    expect(opts.model).toBe("default-model");
  });

  test("--overview captures multiline text to end of comment", () => {
    const opts = review(
      parseBotCommand("/squanchy review --overview refactors the auth flow\nit touches login and session", defaults),
    );
    expect(opts.overview).toBe("refactors the auth flow\nit touches login and session");
  });

  test("--overview combined with other flags before it", () => {
    const opts = review(parseBotCommand("/squanchy review -d major --overview watch the retries", defaults));
    expect(opts.depths).toEqual(["major"]);
    expect(opts.overview).toBe("watch the retries");
  });

  test("unknown flag replies with error", () => {
    const cmd = parseBotCommand("/squanchy review --bogus x", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("--bogus");
  });

  test("unknown subcommand replies with error", () => {
    const cmd = parseBotCommand("/squanchy dance", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("unknown command");
  });

  test("missing flag value replies with error", () => {
    const cmd = parseBotCommand("/squanchy review --model", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("missing value");
    const cmd2 = parseBotCommand("/squanchy review --overview", defaults);
    if (cmd2.type === "reply") expect(cmd2.reply).toContain("missing text");
    else throw new Error("expected reply");
  });

  test("invalid depth replies with error", () => {
    const cmd = parseBotCommand("/squanchy review --depth bogus", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("invalid --depth");
  });

  test("stray positional argument replies with error", () => {
    const cmd = parseBotCommand("/squanchy review now please", defaults);
    expect(cmd.type).toBe("reply");
    if (cmd.type === "reply") expect(cmd.reply).toContain("now");
  });

  test("flags directly after trigger (review implied)", () => {
    const opts = review(parseBotCommand("/squanchy --depth minor", defaults));
    expect(opts.depths).toEqual(["minor"]);
  });
});
