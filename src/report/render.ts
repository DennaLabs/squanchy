import pc from "picocolors";
import type { Depth, Finding, Mode, ReviewResult } from "../types";

export interface ReportMeta {
  repo?: string;
  prNumber?: number;
  title?: string;
  mode?: Mode;
  model?: string;
  depths?: Depth[];
  seconds?: number;
  headSha?: string;
  postedUrl?: string;
}

export interface RenderOptions {
  /** default: auto (colors only when the terminal supports them; NO_COLOR respected) */
  color?: boolean;
  /** total line width; default: terminal width or 80 */
  width?: number;
  meta?: ReportMeta;
}

const ORDER = ["vulnerability", "major", "minor", "nit", "info"] as const;
type Severity = (typeof ORDER)[number];

const GLYPH: Record<Severity, string> = {
  vulnerability: "▲",
  major: "✖",
  minor: "◆",
  nit: "▸",
  info: "○",
};

const ORANGE_256 = 208;

interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  severity: Record<Severity, (s: string) => string>;
}

function makePalette(color: boolean): Palette {
  const c = pc.createColors(color);
  const orange = color ? (s: string) => `\x1b[38;5;${ORANGE_256}m${s}\x1b[39m` : (s: string) => s;
  return {
    bold: c.bold,
    dim: c.dim,
    green: c.green,
    severity: {
      vulnerability: c.magenta,
      major: c.red,
      minor: orange,
      nit: c.yellow,
      info: c.cyan,
    },
  };
}

/** Greedy word wrap preserving explicit newlines; long words are hard-split. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      let rest = word;
      while (rest.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      const candidate = line ? `${line} ${rest}` : rest;
      if (candidate.length > width && line) {
        out.push(line);
        line = rest;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** OSC-8 terminal hyperlink (degrades to plain text when colors/tty are off). */
function link(text: string, url: string | undefined, enabled: boolean): string {
  if (!url || !enabled) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function blobUrl(meta: ReportMeta | undefined, file: string, line: number | null): string | undefined {
  if (!meta?.repo || !meta?.headSha) return undefined;
  const anchor = line ? `#L${line}` : "";
  return `https://github.com/${meta.repo}/blob/${meta.headSha}/${file}${anchor}`;
}

function headerLines(meta: ReportMeta | undefined, pal: Palette, color: boolean): string[] {
  const pr = meta?.repo && meta?.prNumber ? `${meta.repo}#${meta.prNumber}` : null;
  const title = `squanchy review${pr ? ` — ${pr}` : ""}`;
  const lines = [`┌ ${color ? pal.bold(title) : title}`];
  if (meta?.title) lines.push(`│ ${pal.dim(meta.title)}`);
  const details = [
    meta?.mode ?? null,
    meta?.model ?? null,
    meta?.depths?.length ? `depths: ${meta.depths.join(",")}` : null,
    meta?.seconds !== undefined ? `${meta.seconds}s` : null,
  ].filter(Boolean);
  if (details.length > 0) lines.push(`│ ${pal.dim(details.join(" · "))}`);
  if (meta?.postedUrl) lines.push(`│ ${pal.dim(`posted: ${meta.postedUrl}`)}`);
  return lines;
}

function countsLine(findings: Finding[], pal: Palette, color: boolean): string {
  const counts = ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const).filter(
    ([, n]) => n > 0,
  );
  return counts
    .map(([sev, n]) => {
      const part = `${GLYPH[sev]} ${n} ${sev}${n === 1 ? "" : "s"}`;
      return color ? pal.bold(pal.severity[sev](part)) : part;
    })
    .join("   ");
}

function findingBlock(f: Finding, pal: Palette, color: boolean, width: number, meta: ReportMeta | undefined): string[] {
  const sevColor = pal.severity[f.severity];
  const label = `${GLYPH[f.severity]} ${f.severity.toUpperCase()}`;
  const lines = [`┌ ${color ? pal.bold(sevColor(label)) : label}`];
  const location = `${f.file}${f.line ? `:${f.line}` : ""}`;
  lines.push(`│ ${link(pal.dim(location), blobUrl(meta, f.file, f.line), color)}`);
  for (const wl of wrapText(f.comment, width - 2)) lines.push(`│ ${wl}`);
  if (f.suggestion) {
    lines.push(`│`);
    lines.push(`│ ${pal.dim("suggestion:")}`);
    for (const sl of wrapText(f.suggestion, width - 4)) lines.push(`│   ${pal.dim(sl)}`);
  }
  lines.push("└");
  return lines;
}

export function renderReport(result: ReviewResult, opts: RenderOptions = {}): string {
  const color = opts.color ?? pc.isColorSupported;
  const width = Math.max(40, opts.width ?? process.stdout.columns ?? 80);
  const pal = makePalette(color);
  const meta = opts.meta;
  const lines: string[] = [];

  lines.push(...headerLines(meta, pal, color));

  const overview = result.overview?.replace(/\n*Posted: \S+\s*$/, "").trim();
  if (overview) {
    lines.push("│");
    lines.push(`│ ${pal.dim("overview")}`);
    for (const wl of wrapText(overview, width - 2)) lines.push(`│ ${wl}`);
  }

  if (result.findings.length === 0) {
    lines.push("│");
    const lgtm = "✓ no findings — LGTM 🐱";
    lines.push(`│ ${color ? pal.bold(pal.green(lgtm)) : lgtm}`);
    lines.push("└");
    return lines.join("\n");
  }

  lines.push("└");
  lines.push("");
  lines.push(countsLine(result.findings, pal, color));

  for (const sev of ORDER) {
    for (const f of result.findings.filter((x) => x.severity === sev)) {
      lines.push("");
      lines.push(...findingBlock(f, pal, color, width, meta));
    }
  }

  lines.push("");
  for (const wl of wrapText("squanchy · AI-generated review — you are always in control of approving this PR.", width)) {
    lines.push(pal.dim(wl));
  }
  return lines.join("\n");
}
