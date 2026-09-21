import * as p from "@clack/prompts";
import type { ReviewEvent } from "../review/run";
import type { Reporter } from "./reporter";

export const CAT_BANNER = [" /\\_/\\   squanchy", "( o.o )  is on it", "  > ^ <"].join("\n");

/** Shown above the spinner when interactive (TTY); skipped in CI/Action logs. */
export function printReviewIntro(): void {
  p.intro(CAT_BANNER);
}

export interface ReviewProgressMeta {
  repo?: string;
  prNumber?: number;
  title?: string;
  headSha?: string;
  files?: number;
  additions?: number;
  deletions?: number;
  postedUrl?: string;
  findings?: number;
  seconds?: number;
}

export interface ReviewProgress {
  onProgress(event: ReviewEvent): void;
  /** metadata collected from events, for the final report header */
  meta: ReviewProgressMeta;
}

const SNAPSHOT_MSG: Record<string, string> = {
  "git-ref": "fetching the PR snapshot via git",
  tarball: "downloading the repo snapshot",
  fs: "reading the checked-out repo",
};

function toolMessage(name: string, summary: string): string | null {
  switch (name) {
    case "read_file":
      return `reading ${summary}`;
    case "get_file_diff":
      return `reading the diff of ${summary}`;
    case "grep":
      return `searching the repo for "${summary}"`;
    case "list_dir":
      return `listing ${summary || "the repo root"}`;
    case "submit_finding":
      return "noting a finding";
    case "finish_review":
      return "wrapping up";
    default:
      return null;
  }
}

/**
 * Maps review events to coarse, friendly progress messages ("what squanchy is
 * doing in general") — detailed traces stay behind SQUANCHY_DEBUG.
 */
export function createReviewProgress(reporter: Reporter, opts: { emoji?: boolean } = {}): ReviewProgress {
  const cat = opts.emoji ? "🐱 " : "";
  const meta: ReviewProgressMeta = {};
  let base = `${cat}starting`;
  let step = 0;
  let maxSteps = 0;
  let findings = 0;

  const suffix = (): string => {
    if (step === 0) return "";
    const parts = [`step ${step}/${maxSteps}`];
    if (findings > 0) parts.push(`${findings} finding${findings === 1 ? "" : "s"}`);
    return ` (${parts.join(" · ")})`;
  };
  const show = () => reporter.update(`${base}${suffix()}`);

  return {
    meta,
    onProgress(event: ReviewEvent): void {
      switch (event.type) {
        case "pr-fetch":
          meta.repo = event.repo;
          meta.prNumber = event.prNumber;
          base = `${cat}fetching PR #${event.prNumber}`;
          reporter.start(base);
          break;
        case "pr-fetched":
          Object.assign(meta, {
            repo: event.repo,
            prNumber: event.prNumber,
            title: event.title,
            headSha: event.headSha,
            files: event.files,
            additions: event.additions,
            deletions: event.deletions,
          });
          base = `${cat}reviewing "${event.title}" — ${event.files} file${event.files === 1 ? "" : "s"} (+${event.additions}/−${event.deletions})`;
          show();
          break;
        case "snapshot":
          base = SNAPSHOT_MSG[event.kind] ?? "preparing repo snapshot";
          show();
          break;
        case "agent": {
          const e = event.event;
          if (e.type === "step") {
            step = e.n;
            maxSteps = e.maxSteps;
            base = `${cat}thinking`;
            show();
          } else if (e.type === "tool-call") {
            const msg = toolMessage(e.name, e.summary);
            if (msg) {
              base = `${cat}${msg}`;
              show();
            }
          } else if (e.type === "finding") {
            findings++;
            show();
          }
          break;
        }
        case "posted":
          meta.postedUrl = event.url;
          break;
        case "done":
          meta.findings = event.findings;
          meta.seconds = event.seconds;
          reporter.stop(
            `review complete — ${event.findings} finding${event.findings === 1 ? "" : "s"} in ${event.seconds}s`,
          );
          break;
      }
    },
  };
}
