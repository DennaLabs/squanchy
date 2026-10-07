export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };

export function addUsage(total: TokenUsage, delta: TokenUsage | undefined): TokenUsage {
  if (!delta) return total;
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    costUsd:
      delta.costUsd === null ? total.costUsd : (total.costUsd ?? 0) + delta.costUsd,
  };
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  if (usd === 0) return "$0 (free)";
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function formatUsage(usage: TokenUsage): string {
  return `${formatTokens(usage.inputTokens)} tok in · ${formatTokens(usage.outputTokens)} tok out · cost ${formatCost(usage.costUsd)}`;
}
