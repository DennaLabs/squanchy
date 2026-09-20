import * as p from "@clack/prompts";
import { parseDepths } from "../review/depth";
import { DEPTHS } from "../types";
import { maskSecret, type AskInit, type InitAnswers, type Reporter } from "./prompts";

function cancelled(): never {
  p.cancel("Cancelled — nothing was written.");
  process.exit(1);
}

const DEPTH_HINTS: Record<string, string> = {
  vulnerabilities: "security issues",
  major: "logic bugs, data loss, broken error handling",
  minor: "edge cases, missing validation/tests",
  nits: "style and wording only",
  full: "everything + PR overview",
};

export const askInitClack: AskInit = async (state, helpers) => {
  p.intro("squanchy init");
  p.log.info(`scanned repo: ${state.stackLine}`);

  // --- credentials ---
  let openrouterApiKey: string | undefined;
  let githubToken: string | undefined;
  let secretsChanged = false;
  let saveGlobal = false;

  if (state.locked.credentials) {
    p.log.info("using credentials from CLI flags");
    openrouterApiKey = state.existing?.openrouterApiKey;
    githubToken = state.existing?.githubToken;
  } else if (state.existing?.openrouterApiKey) {
    const shown = [
      `OpenRouter ${maskSecret(state.existing.openrouterApiKey)}`,
      state.existing.githubToken ? `GitHub ${maskSecret(state.existing.githubToken)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const reuse = await p.confirm({
      message: `Reuse existing credentials? (${shown} — from ${state.existing.source})`,
      initialValue: true,
    });
    if (p.isCancel(reuse)) cancelled();
    if (reuse) {
      openrouterApiKey = state.existing.openrouterApiKey;
      githubToken = state.existing.githubToken;
    }
  }

  if (!openrouterApiKey) {
    const key = await p.password({
      message: "OpenRouter API key",
      validate: (v) => (v?.trim() ? undefined : "required — get one at https://openrouter.ai/settings/keys"),
    });
    if (p.isCancel(key)) cancelled();
    openrouterApiKey = (key as string).trim();
    secretsChanged = true;

    const token = await p.password({
      message: "GitHub personal token (optional — leave empty to skip; used for CLI reviews)",
    });
    if (p.isCancel(token)) cancelled();
    githubToken = (token as string).trim() || undefined;

    const save = await p.confirm({
      message: "Save credentials to ~/.config/squanchy for future repos? (file mode 600)",
      initialValue: true,
    });
    if (p.isCancel(save)) cancelled();
    saveGlobal = save as boolean;
  }

  // --- depths ---
  let depths = state.currentDepths;
  if (!state.locked.depths) {
    const picked = await p.multiselect({
      message: "Default review depth (space to toggle, enter to confirm)",
      options: DEPTHS.map((d) => ({ value: d, label: d, hint: DEPTH_HINTS[d] })),
      initialValues: state.currentDepths,
      required: true,
    });
    if (p.isCancel(picked)) cancelled();
    depths = parseDepths((picked as string[]).join(","));
  }

  // --- model ---
  let model = state.currentModel;
  if (!state.locked.model) {
    const s = p.spinner();
    s.start("fetching available models from OpenRouter");
    let options: Awaited<ReturnType<typeof helpers.fetchModels>> = [];
    try {
      options = await helpers.fetchModels(openrouterApiKey!);
      s.stop(`found ${options.length} recommended models`);
    } catch {
      s.stop("could not fetch the model list (offline?) — enter a model id manually");
    }
    const CUSTOM = "__custom__";
    if (options.length > 0) {
      const items = [
        ...options.map((o) => ({
          value: o.id,
          label: o.id,
          hint: `${o.isFree ? "free" : "paid"} · ${Math.round(o.contextLength / 1000)}k ctx`,
        })),
        { value: CUSTOM, label: "other... (enter a model id)" },
      ];
      const initialValue = items.some((i) => i.value === model) ? model : (options[0]!.id as string | typeof CUSTOM);
      const sel = await p.select({ message: "Default model", options: items, initialValue });
      if (p.isCancel(sel)) cancelled();
      if (sel === CUSTOM) {
        model = await typeModelId(model);
      } else {
        model = sel as string;
      }
    } else {
      model = await typeModelId(model);
    }
  }

  // --- advanced ---
  let maxSteps = state.currentMaxSteps;
  const adv = await p.confirm({ message: "Configure advanced settings? (max agent steps per review)", initialValue: false });
  if (p.isCancel(adv)) cancelled();
  if (adv) {
    const ms = await p.text({
      message: "Max agent steps per review (1-100)",
      initialValue: String(maxSteps),
      validate: (v) => {
        const n = Number(v ?? "");
        return Number.isInteger(n) && n >= 1 && n <= 100 ? undefined : "integer between 1 and 100";
      },
    });
    if (p.isCancel(ms)) cancelled();
    maxSteps = Number(ms);
  }

  const answers: InitAnswers = {
    openrouterApiKey: openrouterApiKey!,
    githubToken,
    secretsChanged,
    saveGlobal,
    model,
    depths,
    maxSteps,
  };
  return answers;
};

async function typeModelId(initial: string): Promise<string> {
  const typed = await p.text({
    message: "Default model (OpenRouter id, e.g. anthropic/claude-sonnet-4.5)",
    initialValue: initial,
    validate: (v) => (v?.trim().includes("/") ? undefined : "expected format: org/model[:variant]"),
  });
  if (p.isCancel(typed)) cancelled();
  return (typed as string).trim();
}

/** clack-backed Reporter with an elapsed-seconds spinner. */
export function createClackReporter(): Reporter {
  let spin: ReturnType<typeof p.spinner> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let base = "";
  let startedAt = 0;
  const tick = () => {
    if (spin) spin.message(`${base} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  };
  return {
    info: (m) => p.log.info(m),
    start: (m) => {
      base = m;
      startedAt = Date.now();
      spin = p.spinner();
      spin.start(m);
      timer = setInterval(tick, 1000);
    },
    update: (m) => {
      base = m;
      tick();
    },
    stop: (m) => {
      if (timer) clearInterval(timer);
      timer = null;
      spin?.stop(m);
      spin = null;
    },
    done: (m) => p.outro(m),
  };
}
