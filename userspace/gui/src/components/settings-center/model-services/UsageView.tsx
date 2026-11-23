import { NativeSelect } from '../../../ui-components';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary, UsageQuery, UsageReport, UsageBucket } from '@achbit/protocol';
import { queryModelUsage } from '../../../services/apiClient';
import { UiSettingsContributions, useDisplayTheme } from '../../../ui-plugins/UiPlugins';
import { cacheHitRate, Cost, data, formatUsageTokens, Hint, message, periodQuery, useModelLanguage } from './shared';
import UsageChart, { type UsageMetric } from './UsageChart';

export default function UsageView({ connections, initialConnection }: { connections: ConnectionSummary[]; initialConnection?: string }) {
  const { text, language } = useModelLanguage();
  const theme = useDisplayTheme();
  const [connectionId, setConnectionId] = useState(initialConnection ?? '');
  const [days, setDays] = useState(30);
  const [day, setDay] = useState<UsageBucket | null>(null);
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const query: UsageQuery = useMemo(() => ({ ...periodQuery(days, connectionId), ...(day ? { from: day.start, to: day.end, granularity: 'hour' as const } : {}) }), [days, connectionId, day, revision]);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError('');
    void queryModelUsage(query, controller.signal).then(response => { if (controller.signal.aborted) return; try { setReport(data(response)); } catch (e) { setError(message(e)); } });
    return () => controller.abort();
  }, [query]);
  const isSubscription = connections.find(c => c.id === connectionId)?.billingMode === 'subscription';
  const totals = report?.totals;
  return <div className="model-usage-view">
    <div className="model-heading"><h2>{text('用量统计', 'Usage')}</h2><button onClick={() => setRevision(n => n + 1)}>{text('刷新', 'Refresh')}</button></div>
    <div className="model-filters"><NativeSelect aria-label={text('连接', 'Connection')} value={connectionId} onChange={e => { setConnectionId(e.target.value); setDay(null); }}><option value="">{text('全部连接', 'All connections')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>
      {day ? <button className="model-push" onClick={() => setDay(null)}>{text('返回按日统计', 'Back to daily usage')} · {new Date(day.start).toLocaleDateString(language)}</button> : <NativeSelect className="model-push" aria-label={text('统计周期', 'Period')} value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>{text('今日', 'Today')}</option><option value={7}>{text('近 7 天', 'Last 7 days')}</option><option value={30}>{text('近 30 天', 'Last 30 days')}</option></NativeSelect>}
    </div>
    {error ? <div className="settings-error" role="alert">{error}</div> : !report ? <div role="status">{text('正在读取…', 'Loading…')}</div> : <>
      <div className="model-usage-totals">
        {!isSubscription && <div><small>{text('API 费用估算', 'Estimated API cost')}<Hint>{text('按调用时的官方价格及实际返回用量计算；不包含套餐订阅费或服务方额外工具费。缺失部分不计作零。', 'Calculated from reported usage and the official price snapshot for each call. Plan fees and provider tool charges are excluded. Missing data is not zero.')}</Hint></small><strong><Cost totals={totals} /></strong></div>}
        <div><small>{text('输入 / 输出 tokens', 'Input / output tokens')}</small><strong title={totals?.reportedCalls ? `${totals.inputTokens.toLocaleString(language)} / ${totals.outputTokens.toLocaleString(language)}` : undefined}>{totals?.reportedCalls ? `${formatUsageTokens(totals.inputTokens)} / ${formatUsageTokens(totals.outputTokens)}` : '—'}</strong></div>
        <div><small>{text('调用', 'Calls')}</small><strong>{totals?.calls}</strong></div>
        <div><small>{text('缓存命中', 'Cache hit')}</small><strong>{cacheHitRate(report.totals) ?? '—'}</strong></div>
      </div>
      <UsageChart report={report} metric={isSubscription ? 'tokens' : metric} showCost={!isSubscription} onMetricChange={setMetric} onSelectDay={setDay} />
      <UiSettingsContributions slot="settings.usage.panel" input={{ kind: 'settings.usage', query, report, locale: language, theme }} />
      <div className="model-coverage"><Hint label={text('统计范围', 'Coverage')}>{text('已报告用量', 'Reported usage')}: {totals?.reportedCalls}/{totals?.calls} · {text('完整计价', 'Fully priced')}: {totals?.pricedCalls}/{totals?.calls}</Hint></div>
    </>}
  </div>;
}
