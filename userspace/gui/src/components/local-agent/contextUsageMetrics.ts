import type { ContextCompositionPartitionKind, ContextCompositionProjection, ContextUsageProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import type { InputCacheMetric } from '../../utils/providerUsage';

export type ContextFocusKey = 'input' | 'output' | 'free' | ContextCompositionPartitionKind;

interface ContextDisplayMetric {
  key: ContextFocusKey;
  label: string;
  tokens: number | null;
  percent: number | null;
  itemCount?: number;
  estimated?: boolean;
  percentScope?: 'window';
}

interface ContextBarSegment {
  metric: ContextDisplayMetric;
  truePercent: number;
}

export function buildCapacityMetrics(
  usage: ContextUsageProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  const labels = {
    input: t(language, 'agent.context.capacity.input'),
    output: t(language, 'agent.context.capacity.output'),
    free: t(language, 'agent.context.capacity.free'),
  };
  if (!usage) {
    return [
      { key: 'input', label: labels.input, tokens: null, percent: null },
      { key: 'output', label: labels.output, tokens: null, percent: null },
      { key: 'free', label: labels.free, tokens: null, percent: null },
    ];
  }
  const freeTokens = Math.max(
    0,
    usage.contextWindowTokens - usage.inputTokens - usage.outputTokens,
  );
  return [
    {
      key: 'input',
      label: labels.input,
      tokens: usage.inputTokens,
      percent: percentOf(usage.inputTokens, usage.contextWindowTokens),
      percentScope: 'window',
    },
    {
      key: 'output',
      label: labels.output,
      tokens: usage.outputTokens,
      percent: percentOf(usage.outputTokens, usage.contextWindowTokens),
      percentScope: 'window',
    },
    {
      key: 'free',
      label: labels.free,
      tokens: freeTokens,
      percent: percentOf(freeTokens, usage.contextWindowTokens),
      percentScope: 'window',
    },
  ];
}

export function buildCompositionSegments(
  usage: ContextUsageProjection | null,
  capacityMetrics: readonly ContextDisplayMetric[],
  requestSections: readonly ContextDisplayMetric[],
): ContextBarSegment[] {
  if (!usage || usage.contextWindowTokens <= 0) return [];
  const input = capacityMetrics.find((metric) => metric.key === 'input');
  const output = capacityMetrics.find((metric) => metric.key === 'output');
  const free = capacityMetrics.find((metric) => metric.key === 'free');
  if (!input || !output || !free) return [];

  const inputPercent = precisePercentOf(usage.inputTokens, usage.contextWindowTokens);
  const sectionWeight = requestSections.reduce(
    (total, section) => total + Math.max(0, section.percent ?? 0),
    0,
  );
  const inputSegments = requestSections.length > 0 && sectionWeight > 0
    ? requestSections.map((section) => ({
        metric: section,
        truePercent: inputPercent * (Math.max(0, section.percent ?? 0) / sectionWeight),
      }))
    : [{ metric: input, truePercent: inputPercent }];

  return [
    ...inputSegments,
    {
      metric: output,
      truePercent: precisePercentOf(usage.outputTokens, usage.contextWindowTokens),
    },
    {
      metric: free,
      truePercent: precisePercentOf(
        Math.max(0, usage.contextWindowTokens - usage.inputTokens - usage.outputTokens),
        usage.contextWindowTokens,
      ),
    },
  ];
}

export function buildRequestSections(
  receipt: ContextCompositionProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  if (!receipt) return [];
  const hasCompleteTokenEstimate = receipt.partitions.every((partition) => (
    partition.tokenSource === 'sessionEstimated'
    && partition.estimatedInputTokens !== undefined
  ));
  const totalWeight = receipt.partitions.reduce((total, partition) => (
    total + (hasCompleteTokenEstimate
      ? partition.estimatedInputTokens ?? 0
      : partition.requestShapeUnits)
  ), 0);
  return receipt.partitions.map((partition) => ({
    key: partition.kind,
    label: contextPartitionLabel(partition.kind, language),
    tokens: partition.tokenSource === 'sessionEstimated'
      ? partition.estimatedInputTokens ?? null
      : null,
    percent: percentOf(
      hasCompleteTokenEstimate
        ? partition.estimatedInputTokens ?? 0
        : partition.requestShapeUnits,
      totalWeight,
    ),
    itemCount: partition.itemCount,
    estimated: true,
  }));
}

function contextPartitionLabel(
  kind: ContextCompositionPartitionKind,
  language: UiLanguage,
): string {
  return t(language, `agent.context.partition.${kind}`);
}

export function metricValue(metric: ContextDisplayMetric, language: UiLanguage): string {
  if (metric.tokens === null) {
    return metric.percent === null
      ? t(language, 'agent.context.tokensUnavailable')
      : t(language, 'agent.context.estimatedShare', {
          percent: formatPercent(metric.percent, true),
        });
  }
  const formattedPercent = metric.percent === null
    ? null
    : formatPercent(metric.percent, Boolean(metric.estimated));
  const percent = formattedPercent === null
    ? ''
    : metric.percentScope === 'window'
      ? ` · ${t(language, 'agent.context.windowShare', { percent: formattedPercent })}`
      : ` · ${formattedPercent}%`;
  const estimate = metric.estimated ? '≈' : '';
  return t(language, 'agent.context.tokenMetric', {
    estimate,
    tokens: formatTokens(metric.tokens, language),
    percent,
  });
}

export function metricAriaLabel(metric: ContextDisplayMetric, language: UiLanguage): string {
  return `${metric.label} ${metricValue(metric, language)}`;
}

export function cacheAriaLabel(
  cache: InputCacheMetric,
  language: UiLanguage,
): string {
  return t(language, cache.complete
    ? 'agent.context.cacheAria'
    : 'agent.context.cachePartialAria', {
    input: formatTokens(cache.inputTokens, language),
    hit: formatTokens(cache.hitTokens, language),
    miss: formatTokens(cache.missTokens, language),
    reported: cache.reportedCallCount,
    calls: cache.providerCallCount,
  });
}

export function formatItemCount(value: number, language: UiLanguage): string {
  return t(language, 'agent.context.itemCount', {
    count: value.toLocaleString(language),
  });
}

export function formatTokens(value: number, language: UiLanguage): string {
  return value.toLocaleString(language);
}

export function formatPercent(value: number, estimated = false): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const fractionDigits = estimated
    ? 1
    : value < 0.1
      ? 4
      : value < 10
        ? 3
        : 1;
  return value
    .toFixed(fractionDigits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

export function percentOf(value: number, total: number): number | null {
  if (total <= 0) return null;
  return precisePercentOf(value, total);
}

function precisePercentOf(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}
