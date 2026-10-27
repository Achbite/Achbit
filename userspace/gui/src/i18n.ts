import zhCNPack from '../../../config/i18n/zh-CN.json';
import enUSPack from '../../../config/i18n/en-US.json';

export type UiLanguage = 'zh-CN' | 'en-US';

type I18nVariables = Record<string, string | number | boolean | null | undefined>;

interface SettingText {
  label?: string;
  description?: string;
  options?: Record<string, string>;
}

interface I18nPack {
  locale: string;
  name: string;
  messages?: Record<string, string>;
  settings?: Record<string, SettingText>;
}

const DEFAULT_LANGUAGE: UiLanguage = 'zh-CN';

const PACKS: Record<UiLanguage, I18nPack> = {
  'zh-CN': zhCNPack as I18nPack,
  'en-US': enUSPack as I18nPack,
};

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'en-US' ? 'en-US' : DEFAULT_LANGUAGE;
}

function initialActiveLanguage(): UiLanguage {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return normalizeUiLanguage(window.localStorage.getItem('achbit.ui.language'));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let activeLanguage: UiLanguage = initialActiveLanguage();

export function setActiveUiLanguage(value: unknown): UiLanguage {
  activeLanguage = normalizeUiLanguage(value);
  return activeLanguage;
}

function formatMessage(template: string, variables: I18nVariables = {}): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export function t(language: UiLanguage, key: string, variables?: I18nVariables): string {
  const pack = PACKS[language] ?? PACKS[DEFAULT_LANGUAGE];
  const fallbackPack = PACKS[DEFAULT_LANGUAGE];
  const template = pack.messages?.[key] ?? fallbackPack.messages?.[key] ?? key;
  return formatMessage(template, variables);
}

export function activeT(key: string, variables?: I18nVariables): string {
  return t(activeLanguage, key, variables);
}

export function settingText(language: UiLanguage, key: string): SettingText | undefined {
  const pack = PACKS[language] ?? PACKS[DEFAULT_LANGUAGE];
  return pack.settings?.[key];
}
