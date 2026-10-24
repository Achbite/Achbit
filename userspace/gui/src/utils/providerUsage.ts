import type { ProviderTokenUsage } from '@achbit/protocol';

export interface CanonicalProviderInputCacheUsage {
  providerCallCount: number;
  reportedCallCount: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheMissInputTokens: number;
  cacheAvailable: boolean;
  cacheComplete: boolean;
  cacheHitRatio: number | null;
}

export interface InputCacheMetric {
  inputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitPercent: number;
  providerCallCount: number;
  reportedCallCount: number;
  complete: boolean;
}

export function inputCacheMetric(
  usage: CanonicalProviderInputCacheUsage | null | undefined,
): InputCacheMetric | null {
  if (!usage?.cacheAvailable || usage.cacheHitRatio === null) return null;
  return {
    inputTokens: usage.inputTokens,
    hitTokens: usage.cacheReadInputTokens,
    missTokens: usage.cacheMissInputTokens,
    hitPercent: usage.cacheHitRatio * 100,
    providerCallCount: usage.providerCallCount,
    reportedCallCount: usage.reportedCallCount,
    complete: usage.cacheComplete,
  };
}

export function lastCallInputCacheMetric(
  usage: ProviderTokenUsage | null | undefined,
): InputCacheMetric | null {
  if (!usage || usage.inputTokens === 0
    || usage.cacheReadInputTokens === undefined
    || usage.cacheMissInputTokens === undefined) return null;
  return {
    inputTokens: usage.inputTokens,
    hitTokens: usage.cacheReadInputTokens,
    missTokens: usage.cacheMissInputTokens,
    hitPercent: usage.cacheReadInputTokens / usage.inputTokens * 100,
    providerCallCount: 1,
    reportedCallCount: 1,
    complete: true,
  };
}
