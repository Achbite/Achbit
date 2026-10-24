import type { PluginCatalogItem } from '@achbit/protocol';
import { t, type UiLanguage } from './i18n';

const builtinText: Record<string, string> = {
  'plugin://github@first-party': 'github',
  'plugin://pdf@first-party': 'pdf',
  'plugin://arxiv@first-party': 'arxiv',
};

/** Translate bundled product labels without changing catalog identity or user plugin metadata. */
export function localizePlugin(plugin: PluginCatalogItem, language: UiLanguage): PluginCatalogItem {
  const key = builtinText[plugin.uri];
  return key ? {
    ...plugin,
    displayName: t(language, `plugins.builtin.${key}.name`),
    shortDescription: t(language, `plugins.builtin.${key}.description`),
  } : plugin;
}
