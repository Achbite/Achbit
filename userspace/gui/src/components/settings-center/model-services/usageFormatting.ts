import type { UsageQuery, UsageTotals } from '@achbit/protocol';

export function periodQuery(days: number, connectionId?: string, now = new Date()): UsageQuery {
  const from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - days + 1);
  const to = new Date(now); to.setHours(24, 0, 0, 0);
  return { from: +from, to: +to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    granularity: days === 1 ? 'hour' : 'day', ...(connectionId ? { connectionId } : {}) };
}
// Keep the same decimal K/M/B notation in both UI languages (zh-CN compact uses 万/亿).
export const formatUsageTokens = new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 2,
}).format;

function cacheReportedInput(totals: UsageTotals): number | null {
  // When every usage report includes cache, the total input is the paired subtotal,
  // even on a running Host that does not yet send cacheReportedInputTokens.
  return totals.cacheReportedCalls === totals.reportedCalls ? totals.inputTokens : totals.cacheReportedInputTokens ?? null;
}
export function usageTokenBreakdown(totals: UsageTotals) {
  const paired = cacheReportedInput(totals);
  const hit = totals.cacheReportedCalls > 0 ? totals.cacheReadTokens : null;
  const miss = hit !== null && paired !== null ? paired - hit : null;
  return { hit, miss, unknown: totals.inputTokens - (hit ?? 0) - (miss ?? 0), output: totals.outputTokens };
}
export function cacheHitRate(totals: UsageTotals): string | null {
  const input = cacheReportedInput(totals);
  return totals.cacheReportedCalls > 0 && input !== null && input > 0 ? `${(100 * totals.cacheReadTokens / input).toFixed(1)}%` : null;
}
