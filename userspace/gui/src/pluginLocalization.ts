import type { GuidanceReference, PluginCatalogItem, PluginCatalogProjection, PluginSelectionInput } from '@achbit/protocol';
import { t, type UiLanguage } from './i18n';

const builtinText: Record<string, string> = {
  'plugin://github@first-party': 'github',
  'plugin://pdf@first-party': 'pdf',
  'plugin://arxiv@first-party': 'arxiv',
  'plugin://computer-use@builtin': 'computerUse',
  'plugin://chrome-devtools@builtin': 'chrome',
  'plugin://containers@builtin': 'containers',
  'plugin://session-diagnostics@builtin': 'sessionDiagnostics',
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

/** Translate official UI metadata while respecting the labels in customized copies. */
export function uiPluginText(
  language: UiLanguage,
  plugin: { id: string; name: string; description?: string; kind?: string } | null | undefined,
  field: 'name' | 'description',
): string | undefined {
  const value = plugin?.[field];
  if (plugin?.id !== 'achbit.session-usage' || (plugin.kind && plugin.kind !== 'ui') || !value) return value;
  const key = 'plugins.builtin.sessionUsage.' + field;
  return value === t('en-US', key) || value === t('zh-CN', key) ? t(language, key) : value;
}

// A newer GUI may be connected to a Host that still offers these original built-ins.
const retiredGuides = new Map<string, string | null>([
  ['plugin://achbit-product@builtin', 'operations.md'],
  ['plugin://achbit-session@builtin', 'session-query.md'],
  ['plugin://achbit-iteration@builtin', null],
  ['plugin://achbit-release-audit@builtin', null],
]);

export function retiredDraftSkillNotice(catalog: PluginCatalogProjection, selections: PluginSelectionInput[],
  references: GuidanceReference[] | undefined, language: UiLanguage): string | null {
  if (!catalog.plugins.length || (!selections.length && !references?.length)) return null;
  const missing = [...selections, ...(references ?? [])].find(item =>
    (!('toolName' in item) || item.toolName === 'skill.read') && retiredGuides.has(item.uri)
    && !catalog.plugins.some(plugin => plugin.uri === item.uri));
  if (!missing) return null;
  const guide = retiredGuides.get(missing.uri);
  return guide ? t(language, 'agent.plugin.retiredPublic', { name: missing.label, guide })
    : t(language, 'agent.plugin.retiredLocal', { name: missing.label });
}
