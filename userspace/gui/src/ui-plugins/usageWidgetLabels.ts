import { t, type UiLanguage } from '../i18n';

const keys = ['settings', 'hide', 'show', 'unavailable', 'noCalls', 'unpriced', 'remaining', 'today', 'resets', 'estimate', 'tokens', 'cached', 'calls', 'priced', 'coverage', 'hourly', 'todayEstimate', 'collapse'] as const;
export type UsageWidgetLabels = Readonly<Record<typeof keys[number], string>>;

export function usageWidgetLabels(language: UiLanguage): UsageWidgetLabels {
  return Object.fromEntries(keys.map(key => [key, t(language, `gui.usageWidget.${key}`)])) as UsageWidgetLabels;
}
