import { useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { UsageBucket, UsageReport } from '@achbit/protocol';
import { useModelLanguage } from './modelServiceSettings';
import { ModelSettingsHelp } from './ModelSettingsHelp';
import { cacheHitRate, formatUsageTokens, usageTokenBreakdown } from './usageFormatting';
import { useMoneyFormatter } from './UsageCost';
import UsageChartTooltip, { type UsageAnchor } from './UsageChartTooltip';

export type UsageMetric = 'tokens' | 'cost';

const tokenSeries = [
  { id: 'hit', zh: '输入（命中缓存）', en: 'Input (cache hit)' },
  { id: 'miss', zh: '输入（未命中缓存）', en: 'Input (cache miss)' },
  { id: 'unknown', zh: '输入（缓存状态未知）', en: 'Input (cache status unknown)' },
  { id: 'output', zh: '输出', en: 'Output' },
] as const;

export default function UsageChart({ report, metric, showCost, onMetricChange, onSelectDay }: {
  report: UsageReport; metric: UsageMetric; showCost: boolean;
  onMetricChange(metric: UsageMetric): void; onSelectDay(bucket: UsageBucket): void;
}) {
  const { text, language } = useModelLanguage();
  const money = useMoneyFormatter();
  const exact = useMemo(() => new Intl.NumberFormat(language).format, [language]);
  const plot = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState<UsageAnchor | null>(null);
  const [focused, setFocused] = useState<UsageAnchor | null>(null);
  const active = hovered ?? focused;
  const { buckets, coverageFrom, query } = report;
  const isTokens = metric === 'tokens', isDaily = query.granularity === 'day';
  const values = buckets.map(b => isTokens ? b.inputTokens + b.outputTokens : b.estimatedCost ?? 0);
  const max = Math.max(1, ...values);
  const breakdowns = buckets.map(usageTokenBreakdown);
  const series = tokenSeries.filter(s => s.id !== 'unknown' || breakdowns.some(b => b.unknown > 0));
  const selected = active && buckets[active.index];
  const rowsFor = (bucket: UsageBucket, index: number) => series.flatMap(s => {
    const count = breakdowns[index][s.id];
    if (s.id === 'unknown' && !count) return [];
    const rate = s.id === 'hit' ? cacheHitRate(bucket) : null;
    return [{ ...s, label: text(s.zh, s.en), value: count === null ? '—' : `${exact(count)}${rate ? ` (${rate})` : ''}` }];
  });
  const hover = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    if (hovered?.bar !== event.currentTarget) setHovered({ index, bar: event.currentTarget, pointerY: event.clientY });
  };

  return <>
    <div className="model-chart-heading">
      <div className="model-segments"><button aria-pressed={isTokens} onClick={() => onMetricChange('tokens')}>Tokens</button>{showCost && <button aria-pressed={!isTokens} onClick={() => onMetricChange('cost')}>{text('费用', 'Cost')}</button>}</div>
      {isTokens && <div className="model-chart-legend">{series.map(s => <span key={s.id} data-series={s.id}><i className="model-chart-swatch" aria-hidden="true" />{text(s.zh, s.en)}</span>)}</div>}
      <ModelSettingsHelp>{text('记录起始', 'Records since')}: {new Date(coverageFrom).toLocaleString(language)}{isDaily && ` · ${text('点击某天查看小时分布。', 'Select a day for hourly usage.')}`}</ModelSettingsHelp>
    </div>
    <div className="model-chart-region">
      <div ref={plot} className="model-chart" role="group" aria-label={text('用量统计图', 'Usage chart')}>
        <div className="model-chart-grid" aria-hidden="true"><span>{isTokens ? formatUsageTokens(max) : money(max)}</span><span>0</span></div>
        <div className="model-bars">{buckets.map((bucket, index) => {
          const unrecorded = bucket.end <= coverageFrom;
          const valueLabel = unrecorded ? text('未开始记录', 'Not yet recorded')
            : !isTokens ? money(bucket.estimatedCost)
            : bucket.calls > 0 && !bucket.reportedCalls ? text('用量未报告', 'Usage not reported')
            : `${exact(values[index])} tokens`;
          const description = isTokens && !unrecorded && bucket.reportedCalls > 0 ? rowsFor(bucket, index).map(r => `${r.label}: ${r.value}`).join(' · ') : undefined;
          return <button key={bucket.start} className={`model-bar${unrecorded ? ' model-bar--unrecorded' : ''}`} aria-label={`${bucket.label}: ${valueLabel}`}
            aria-description={description} aria-describedby={active?.index === index ? tooltipId : undefined}
            onFocus={e => { if (e.currentTarget.matches(':focus-visible')) { setHovered(null); setFocused({ index, bar: e.currentTarget }); } }} onBlur={() => setFocused(null)}
            onMouseEnter={e => hover(index, e)} onMouseMove={e => hover(index, e)} onMouseLeave={() => setHovered(null)}
            onClick={e => { if (isDaily) onSelectDay(bucket); else if (e.detail) hover(index, e); else setFocused({ index, bar: e.currentTarget }); }}>
            <span className="model-bar-fill" aria-hidden="true" style={{ height: `${values[index] / max * 100}%`, minHeight: values[index] > 0 ? 3 : 0 }}>
              {isTokens && series.map(s => {
                const count = breakdowns[index][s.id];
                return count !== null && count > 0 ? <span key={s.id} data-series={s.id} style={{ flexGrow: count }} /> : null;
              })}
            </span>
            <small>{buckets.length <= 7 || index % 5 === 0 || index === buckets.length - 1 ? bucket.label : ''}</small>
          </button>;
        })}</div>
      </div>
      {active && selected && <UsageChartTooltip anchor={active} plotRef={plot} id={tooltipId}>
        <strong>{isDaily ? new Date(selected.start).toLocaleDateString(language) : new Date(selected.start).toLocaleString(language)}</strong>
        {selected.end <= coverageFrom ? <span>{text('未开始记录', 'Not yet recorded')}</span> : <>
          <span>{exact(selected.calls)} {text('次调用', 'calls')} · {selected.calls > 0 && !selected.reportedCalls ? text('用量未报告', 'Usage not reported') : `${exact(selected.inputTokens + selected.outputTokens)} tokens`}</span>
          {isTokens && selected.reportedCalls > 0 && <dl className="model-chart-breakdown">{rowsFor(selected, active.index).map(r =>
            <div key={r.id} data-series={r.id}><dt><i className="model-chart-swatch" aria-hidden="true" />{r.label}</dt><dd>{r.value}</dd></div>
          )}</dl>}
          {showCost && <span>{money(selected.estimatedCost)}{selected.estimatedCost !== null && selected.pricedCalls < selected.calls && ` · ${text('部分计价', 'Partially priced')}`}</span>}
        </>}
      </UsageChartTooltip>}
    </div>
  </>;
}
