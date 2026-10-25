import usageSource from './builtinUsage.mjs?raw';
import regionSource from './builtinRegions.mjs?raw';
import type { UiPluginFile, UiRegionSlot } from './types';
export const regionSlots: UiRegionSlot[] = ['workbench.layout', 'navigation', 'conversation.header',
  'activity.row', 'activity.summary', 'activity.detail', 'composer.layout', 'composer.model',
  'composer.attachments', 'composer.actions', 'task.panel', 'artifact.panel', 'reader.layout',
  'reader.toolbar', 'reader.tree', 'settings.navigation'];
export function withBuiltinRegions(files: UiPluginFile[], usageEnabled = true): UiPluginFile[] {
  const selected = new Set(files.filter(file => file.enabled).flatMap(file => file.manifest?.slots ?? []));
  const slots = regionSlots.filter(slot => !selected.has(slot));
  const usage: UiPluginFile[] = usageEnabled && !selected.has('usage.widget') ? [{ path: 'builtin:usage', enabled: true,
    manifest: { id: 'deepcode.usage', name: 'Usage', entry: 'builtinUsage.mjs', slots: ['usage.widget'], capabilities: ['usage.read', 'quota.read'] },
    source: usageSource, error: null }] : [];
  // The selected built-in layout/navigation must not wait for usage or extension imports.
  return [...(slots.length ? [{ path: 'builtin:regions', enabled: true,
    manifest: { id: 'deepcode.regions', name: 'Achbit', entry: 'builtinRegions.mjs', slots },
    source: regionSource, error: null }] : []), ...files, ...usage];
}
