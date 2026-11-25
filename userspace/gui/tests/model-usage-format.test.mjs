// TCRs: .task-artifacts/T-024-Usage_UI-20261122/{compact-numbers,anchored-details}/TCR.md
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';

const feature = '/src/components/settings-center/model-services';

test('usage charts keep compact axes and expose exact cache hit, miss and output counts', async t => {
  const [{ default: UsageChart }, { useSettingsStore }] = await loadGuiModules(t, [`${feature}/UsageChart.tsx`, '/src/state/settingsStore.ts']);
  const initial = useSettingsStore.getInitialState(), previous = initial.effectiveSettings;
  t.after(() => { initial.effectiveSettings = previous; });
  const bucket = { start: 0, end: 3600000, label: '09:00', calls: 3, reportedCalls: 2, pricedCalls: 3, cacheReportedCalls: 2,
    inputTokens: 33491327 + 654587, outputTokens: 189765, cacheReadTokens: 33491327, cacheReportedInputTokens: 33491327 + 654587, estimatedCost: 12.34 };
  const report = { buckets: [bucket], coverageFrom: 0, query: { granularity: 'hour' }, totals: bucket };
  const render = metric => renderToStaticMarkup(createElement(UsageChart, { report, metric, showCost: true, onSelectDay() {}, onMetricChange() {} }));
  for (const language of ['zh-CN', 'en-US']) {
    initial.effectiveSettings = { ...previous, 'workbench.language': language, 'gui.usageWidget.currency': 'USD' };
    const tokens = render('tokens');
    assert.match(tokens, /<span>34\.34M<\/span>/, 'token axis');
    assert.match(tokens, /aria-label="09:00: 34,335,679 tokens"/, 'exact bucket total');
    const labels = language === 'zh-CN' ? ['输入（命中缓存）', '输入（未命中缓存）', '输出'] : ['Input (cache hit)', 'Input (cache miss)', 'Output'];
    assert.ok(tokens.includes(`aria-description="${labels[0]}: 33,491,327 (98.1%) · ${labels[1]}: 654,587 · ${labels[2]}: 189,765"`));
    const cost = render('cost');
    assert.match(cost, /\$12\.34/);
    assert.doesNotMatch(cost, /34\.34M|33\.49M|189\.77K|34,335,679|33,491,327|189,765/);
  }
});

test('only paired input can be a cache miss; unknown input retains its share of the stack', async t => {
  const [{ usageTokenBreakdown }] = await loadGuiModules(t, [`${feature}/usageFormatting.ts`]);
  const mixed = { reportedCalls: 3, cacheReportedCalls: 2, inputTokens: 1_000, cacheReadTokens: 75, cacheReportedInputTokens: 150, outputTokens: 10 };
  assert.deepEqual(usageTokenBreakdown(mixed), { hit: 75, miss: 75, unknown: 850, output: 10 });
  const unpaired = { ...mixed, cacheReportedInputTokens: undefined };
  assert.deepEqual(usageTokenBreakdown(unpaired), { hit: 75, miss: null, unknown: 925, output: 10 });
  assert.deepEqual(usageTokenBreakdown({ ...unpaired, cacheReportedCalls: 0, cacheReadTokens: 0 }), { hit: null, miss: null, unknown: 1_000, output: 10 });
  assert.deepEqual(usageTokenBreakdown({ ...unpaired, cacheReportedCalls: 3, cacheReadTokens: 0 }), { hit: 0, miss: 1_000, unknown: 0, output: 10 });
});

test('model usage keeps small counts exact and promotes rounded totals across decimal units', async t => {
  const [{ formatUsageTokens }] = await loadGuiModules(t, [`${feature}/usageFormatting.ts`]);
  for (const [value, expected] of [[0, '0'], [999, '999'], [1_000, '1K'], [999_999, '1M'], [44_000_000, '44M'],
    [133_396_235, '133.4M'], [3_186_159, '3.19M'], [999_999_999, '1B'], [2_500_000_000, '2.5B']]) {
    assert.equal(formatUsageTokens(value), expected, `tokens: ${value}`);
  }
});
