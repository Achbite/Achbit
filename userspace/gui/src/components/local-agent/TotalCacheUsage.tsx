import type { SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { inputCacheMetric } from '../../utils/providerUsage';

/** Display the Session-owned aggregate for this conversation and its descendant Agents. */
export default function TotalCacheUsage({ projection, language }: {
  projection: SessionProjection | null;
  language: UiLanguage;
}) {
  const summary = cacheHitSummary(projection, language);
  return <span className="local-agent__total-cache" title={summary.title}>
    <span>{t(language, 'deepcodeGui.cache.label')}</span>
    <span>{summary.value}</span>
  </span>;
}

function cacheHitSummary(
  projection: SessionProjection | null,
  language: UiLanguage,
): { value: string; title: string } {
  const usage = projection?.totalTokenUsage;
  const cache = inputCacheMetric(usage);
  const running = projection?.run?.status === 'running';
  if (cache) {
    const percent = `${formatCachePercent(cache.hitPercent)}%`;
    return {
      value: percent,
      title: t(language, 'deepcodeGui.cache.calculatedTitle', {
        input: cache.inputTokens.toLocaleString(language),
        hit: cache.hitTokens.toLocaleString(language),
        miss: cache.missTokens.toLocaleString(language),
      }) + (!cache.complete ? ` ${t(language, 'deepcodeGui.cache.partialTitle', {
        reported: cache.reportedCallCount,
        calls: cache.providerCallCount,
      })}` : '') + (running ? ` ${t(language, 'deepcodeGui.cache.updatingTitle')}` : ''),
    };
  }
  if (running) {
    return {
      value: t(language, 'deepcodeGui.cache.pendingValue'),
      title: t(language, 'deepcodeGui.cache.pendingTitle'),
    };
  }
  if (!usage?.providerCallCount) {
    return {
      value: t(language, 'deepcodeGui.cache.emptyValue'),
      title: t(language, 'deepcodeGui.cache.emptyTitle'),
    };
  }
  return {
    value: t(language, 'deepcodeGui.cache.unavailableValue'),
    title: t(language, 'deepcodeGui.cache.unavailableTitle', {
      calls: usage.providerCallCount.toLocaleString(language),
    }),
  };
}

function formatCachePercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
