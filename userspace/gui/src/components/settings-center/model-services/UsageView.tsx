import NativeSelect from '../../shared/NativeSelect';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary, UsageQuery, UsageReport, UsageBucket } from '@achbit/protocol';
import { queryModelUsage } from '../../../services/apiClient';
import { UiSettingsContributions, useDisplayTheme } from '../../../ui-plugins/UiPlugins';
import { Cost, data, Hint, message, useMoneyFormatter, periodQuery, useModelLanguage } from './shared';

export default function UsageView({ connections, initialConnection }: { connections: ConnectionSummary[]; initialConnection?: string }) {
  const { text, language } = useModelLanguage();
  const theme = useDisplayTheme();
  const money = useMoneyFormatter();
  const [connectionId, setConnectionId] = useState(initialConnection ?? '');
  const [days, setDays] = useState(30);
  const [day, setDay] = useState<UsageBucket | null>(null);
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const query: UsageQuery = useMemo(() => ({ ...periodQuery(days, connectionId), ...(day ? { from: day.start, to: day.end, granularity: 'hour' as const } : {}) }), [days, connectionId, day, revision]);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setFocused(null);
    void queryModelUsage(query, controller.signal).then(response => { if (controller.signal.aborted) return; try { setReport(data(response)); } catch (e) { setError(message(e)); } });
    return () => controller.abort();
  }, [query]);
  const isSubscription = connections.find(c => c.id === connectionId)?.billingMode === 'subscription';
  const buckets = report?.buckets ?? [];
  const values = buckets.map(b => metric === 'tokens' || isSubscription ? b.inputTokens + b.outputTokens : b.estimatedCost ?? 0);
  const max = Math.max(...values, 1);
  const selected = focused === null ? null : buckets[focused];
  const totals = report?.totals;
  return <div className="model-usage-view">
    <div className="model-heading"><h2>{text('用量统计', 'Usage')}</h2><button onClick={() => setRevision(n => n + 1)}>{text('刷新', 'Refresh')}</button></div>
    <div className="model-filters"><NativeSelect aria-label={text('连接', 'Connection')} value={connectionId} onChange={e => { setConnectionId(e.target.value); setDay(null); }}><option value="">{text('全部连接', 'All connections')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
      {day ? <button className="model-push" onClick={() => setDay(null)}>{text('返回按日统计', 'Back to daily usage')} · {new Date(day.start).toLocaleDateString(language)}</button> : <NativeSelect className="model-push" aria-label={text('统计周期', 'Period')} value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>{text('今日', 'Today')}</option><option value={7}>{text('近 7 天', 'Last 7 days')}</option><option value={30}>{text('近 30 天', 'Last 30 days')}</option></NativeSelect>}
    </div>
    {error ? <div className="settings-error" role="alert">{error}</div> : !report ? <div role="status">{text('正在读取…', 'Loading…')}</div> : <>
      <div className="model-usage-totals">
        {!isSubscription && <div><small>{text('API 费用估算', 'Estimated API cost')}<Hint>{text('按调用时的官方价格及实际返回用量计算；不包含套餐订阅费或服务方额外工具费。缺失部分不计作零。', 'Calculated from reported usage and the official price snapshot for each call. Plan fees and provider tool charges are excluded. Missing data is not zero.')}</Hint></small><strong><Cost totals={totals} /></strong></div>}
        <div><small>{text('输入 / 输出 tokens', 'Input / output tokens')}</small><strong>{totals?.reportedCalls ? `${totals.inputTokens.toLocaleString()} / ${totals.outputTokens.toLocaleString()}` : '—'}</strong></div>
        <div><small>{text('调用', 'Calls')}</small><strong>{totals?.calls}</strong></div>
        <div><small>{text('缓存命中率', 'Cache hit rate')}<Hint>{text('仅全部调用均报告缓存字段时显示精确比例。', 'An exact rate requires cache fields for every call.')}</Hint></small><strong>{totals && totals.calls > 0 && totals.cacheReportedCalls === totals.calls && totals.inputTokens > 0 ? `${(100 * totals.cacheReadTokens / totals.inputTokens).toFixed(1)}%` : '—'}</strong></div>
      </div>
      <div className="model-chart-heading"><div className="model-segments"><button aria-pressed={metric === 'tokens' || isSubscription} onClick={() => setMetric('tokens')}>Tokens</button>{!isSubscription && <button aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>{text('费用', 'Cost')}</button>}</div><Hint>{text('近 30 天包含今天和之前 29 个本地日期。点击某天查看小时分布。', 'Last 30 days includes today and the preceding 29 local dates. Select a day for hourly usage.')} {text('记录起始', 'Records since')}: {new Date(report.coverageFrom).toLocaleString(language)}</Hint></div>
      <div className="model-chart" role="group" aria-label={text('用量统计图', 'Usage chart')} onMouseLeave={() => setFocused(null)}>
        <div className="model-chart-grid" aria-hidden="true"><span>{metric === 'cost' && !isSubscription ? money(max) : max.toLocaleString()}</span><span>0</span></div>
        <div className="model-bars">{buckets.map((bucket, index) => {
          const unrecorded = bucket.end <= report.coverageFrom;
          const valueLabel = unrecorded ? text('未开始记录', 'Not yet recorded')
            : metric === 'cost' && !isSubscription ? money(bucket.estimatedCost)
            : bucket.calls > 0 && bucket.reportedCalls === 0 ? text('用量未报告', 'Usage not reported')
            : `${values[index]} tokens`;
          return <button key={bucket.start} className={`model-bar ${unrecorded ? 'model-bar--unrecorded' : ''}`} aria-label={`${bucket.label}: ${valueLabel}`} onFocus={() => setFocused(index)} onMouseEnter={() => setFocused(index)} onBlur={() => setFocused(null)} onClick={() => { if (query.granularity === 'day') setDay(bucket); }}>
            <span className="model-bar-fill" style={{ height: `${values[index] / max * 100}%`, minHeight: values[index] > 0 ? 3 : 0 }} /><small>{buckets.length <= 7 || index % 5 === 0 || index === buckets.length - 1 ? bucket.label : ''}</small>
          </button>;
        })}</div>
        {selected && <div className="model-chart-tooltip" role="status"><strong>{new Date(selected.start).toLocaleString(language)}</strong><span>{selected.end <= report.coverageFrom ? text('未开始记录', 'Not yet recorded') : `${selected.calls} ${text('次调用', 'calls')} · ${selected.calls > 0 && selected.reportedCalls === 0 ? text('用量未报告', 'Usage not reported') : `${(selected.inputTokens + selected.outputTokens).toLocaleString()} tokens`}`}</span>{!isSubscription && selected.end > report.coverageFrom && <Cost totals={selected} />}</div>}
      </div>
      <UiSettingsContributions slot="settings.usage.panel" input={{ kind: 'settings.usage', query, report, locale: language, theme }} />
      <div className="model-coverage"><Hint label={text('统计范围', 'Coverage')}>{text('已报告用量', 'Reported usage')}: {totals?.reportedCalls}/{totals?.calls} · {text('完整计价', 'Fully priced')}: {totals?.pricedCalls}/{totals?.calls}</Hint></div>
    </>}
  </div>;
}
