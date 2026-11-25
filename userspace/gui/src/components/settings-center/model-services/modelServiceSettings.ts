import type { ApiResponse } from '@achbit/protocol';
import { normalizeUiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

export function useModelLanguage() {
  const language = normalizeUiLanguage(useSettingsStore(s => s.effectiveSettings['workbench.language']));
  return { language, text: (zh: string, en: string) => language === 'zh-CN' ? zh : en };
}
export function requireServiceData<T>(response: ApiResponse<T>): T {
  if (!response.ok || response.data === undefined) throw new Error(response.message ?? response.error ?? 'Empty service response');
  return response.data;
}
export function serviceErrorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
