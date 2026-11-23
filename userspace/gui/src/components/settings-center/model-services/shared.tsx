import React, { useId, useState } from 'react';
import type { ApiResponse, UsageQuery, UsageTotals } from '@achbit/protocol';
import { normalizeUiLanguage } from '../../../i18n';
import { formatUsageCost, useUsageCostDisplay } from '../../../ui-plugins/usageCost';
import { useSettingsStore } from '../../../state/settingsStore';
import { useInteractionFocus } from '../../shared/interactionFocus';

export function useModelLanguage() {
  const language = normalizeUiLanguage(useSettingsStore(s => s.effectiveSettings['workbench.language']));
  return { language, text: (zh: string, en: string) => language === 'zh-CN' ? zh : en };
}
export function data<T>(response: ApiResponse<T>): T {
  if (!response.ok || response.data === undefined) throw new Error(response.message ?? response.error ?? 'Empty service response');
  return response.data;
}
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function Hint({ children, label = 'ⓘ' }: { children: React.ReactNode; label?: string }) {
  const interaction = useInteractionFocus();
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className="model-hint" data-escape-layer={open ? 'open' : undefined}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => { if (interaction?.keyboard !== false) setOpen(true); }} onBlur={() => setOpen(false)}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" aria-describedby={open ? id : undefined} aria-label={label} onClick={() => setOpen(true)}>{label}</button>
    <span id={id} role="tooltip" hidden={!open}>{children}</span>
  </span>;
}
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
export function useMoneyFormatter() {
  const display = useUsageCostDisplay();
  const { language } = useModelLanguage();
  return (value: number | null | undefined) => formatUsageCost(value, display, language);
}
export function Cost({ totals }: { totals?: UsageTotals }) {
  const { text } = useModelLanguage();
  const money = useMoneyFormatter();
  const partial = totals && totals.pricedCalls < totals.calls;
  return <span>{money(totals?.estimatedCost)}{partial && totals.estimatedCost !== null && <Hint label="*">{text('仅汇总已取得用量和官方价格的部分，未计价项不记作零。', 'Only reported, priced usage is included. Unknown charges are not zero.')}</Hint>}</span>;
}
