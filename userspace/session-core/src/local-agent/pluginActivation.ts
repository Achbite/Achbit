import type { PluginUri } from '@achbit/protocol';
import type { PluginActivationInput } from './plugins.js';

/** Activation prepares a replacement tool view; Kernel owns binding and retirement. */
export function preparePluginActivation(input: PluginActivationInput) {
  const { runtime, sessionId, runId, nextId, preparation } = input;
  const uris = [...new Set([...runtime.selectedPlugins.plugins.map(plugin => plugin.uri), ...input.pluginUris])];
  return preparation.prepare({
    sessionId, runId, profileId: runtime.provider.profileId,
    environment: runtime.environment,
    ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
    pluginSelections: uris.map(uri => ({ selectionId: nextId('plugin-selection'), uri: uri as PluginUri, label: uri.slice(0, 160) })),
  });
}
