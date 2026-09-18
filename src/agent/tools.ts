import { z } from "zod";
import type { PrBundle } from "../github/pr";
import type { ToolDef } from "../openrouter/client";
import { formatGrepMatches, type RepoSnapshot } from "../snapshot/snapshot";
import { type Finding } from "../types";

export interface ToolCtx {
  bundle: PrBundle;
  /** Lazily created (memoize at the call site): reviews that use no tools pay nothing. */
  getSnapshot: () => Promise<RepoSnapshot>;
}

export type ToolOutcome =
  | { kind: "result"; text: string }
  | { kind: "error"; text: string }
  | { kind: "finding"; finding: Finding; text: string }
  | { kind: "finish"; overview: string | null };

const PathArgs = z.object({ path: z.string().min(1) });
const ListDirArgs = z.object({ path: z.string().optional() });
const GrepArgs = z.object({ pattern: z.string().min(1), path_glob: z.string().optional() });
const SubmitFindingArgs = z.object({
  severity: z.enum(["vulnerability", "major", "minor", "nit", "info"]),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
  comment: z.string().min(1),
  suggestion: z.string().nullable().optional(),
});
const FinishArgs = z.object({ overview: z.string().nullable().optional() });

const PATH_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "repo-relative file path, exactly as listed in the changelist" },
  },
  required: ["path"],
} as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_file_diff",
      description: "Get the unified diff (patch) for one file changed in this PR.",
      parameters: PATH_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file at the PR head commit (any repo file, not just changed ones).",
      parameters: PATH_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List directory entries at the PR head commit. Empty path lists the repo root. Dirs end with '/'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "repo-relative directory; omit or empty string for repo root" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Regex-search file contents at the PR head commit. Returns matches with 3 lines of context. " +
        "Use it to find callers, definitions, and usages related to the diff.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "regular expression to search for" },
          path_glob: { type: "string", description: "optional glob to restrict paths, e.g. 'src/**/*.ts'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_finding",
      description:
        "Record one review finding. Call once per finding, as soon as you are confident it is real. " +
        "line is the NEW-file line number (from the hunk header), or null if not tied to one line.",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["vulnerability", "major", "minor", "nit", "info"] },
          file: { type: "string", description: "repo-relative path of the file the finding is about" },
          line: { type: ["integer", "null"], description: "line number in the NEW file version, or null" },
          comment: { type: "string", description: "1-3 concrete sentences explaining the problem" },
          suggestion: { type: ["string", "null"], description: "optional replacement code for the flagged line(s)" },
        },
        required: ["severity", "file", "line", "comment"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_review",
      description: "End the review. Call exactly once when all findings are submitted. " +
        "Pass overview only when the 'full' focus is active.",
      parameters: {
        type: "object",
        properties: {
          overview: { type: ["string", "null"], description: "short PR overview (only with 'full' focus), else omit" },
        },
      },
    },
  },
];

export async function executeTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<ToolOutcome> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs === "" ? "{}" : rawArgs);
  } catch (err) {
    return { kind: "error", text: `arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    switch (name) {
      case "get_file_diff": {
        const { path } = PathArgs.parse(args);
        const file = ctx.bundle.files.find((f) => f.path === path);
        if (!file) {
          const known = ctx.bundle.files.slice(0, 50).map((f) => f.path).join(", ");
          return { kind: "error", text: `no such file in this PR: ${path}. Changed files: ${known}` };
        }
        if (file.patch === undefined) {
          return {
            kind: "result",
            text: `No patch available for ${path} (binary, or dropped by the diff budget). Use read_file to inspect it at the PR head commit.`,
          };
        }
        return {
          kind: "result",
          text: `## ${file.path} (${file.status}, +${file.additions}/-${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\``,
        };
      }
      case "read_file": {
        const { path } = PathArgs.parse(args);
        const snapshot = await ctx.getSnapshot();
        const content = await snapshot.readFile(path);
        if (content === null) {
          return { kind: "error", text: `cannot read ${path} at the PR head commit (missing, binary, or a directory)` };
        }
        return { kind: "result", text: content };
      }
      case "list_dir": {
        const { path } = ListDirArgs.parse(args);
        const snapshot = await ctx.getSnapshot();
        const entries = await snapshot.listDir(path ?? "");
        if (entries === null) return { kind: "error", text: `no such directory: ${path || "(repo root)"}` };
        return { kind: "result", text: entries.length > 0 ? entries.join("\n") : "(empty directory)" };
      }
      case "grep": {
        const { pattern, path_glob } = GrepArgs.parse(args);
        const snapshot = await ctx.getSnapshot();
        const matches = await snapshot.grep(pattern, path_glob);
        if (matches.length === 0) return { kind: "result", text: `no matches for /${pattern}/` };
        return { kind: "result", text: formatGrepMatches(matches) };
      }
      case "submit_finding": {
        const a = SubmitFindingArgs.parse(args);
        const finding: Finding = {
          severity: a.severity,
          file: a.file,
          line: a.line,
          comment: a.comment,
          suggestion: a.suggestion ?? null,
        };
        return { kind: "finding", finding, text: "finding recorded" };
      }
      case "finish_review": {
        const { overview } = FinishArgs.parse(args);
        return { kind: "finish", overview: overview ?? null };
      }
      default:
        return { kind: "error", text: `unknown tool: ${name}` };
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      return { kind: "error", text: `invalid arguments for ${name}: ${issues}` };
    }
    return { kind: "error", text: `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
