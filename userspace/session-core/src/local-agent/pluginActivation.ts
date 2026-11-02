import type { PluginUri } from '@achbit/protocol';
import { SESSION_DIAGNOSTICS_URI } from './sessionReading.js';
import { LoopFailure } from './loopFailure.js';
import type { PluginActivationInput } from './plugins.js';

/** Activation prepares a replacement tool view; Kernel owns binding and retirement. */
export function preparePluginActivation(input: PluginActivationInput) {
  const { runtime, sessionId, runId, nextId, preparation } = input;
  const selected = runtime.selectedPlugins.plugins.map(plugin => plugin.uri);
  if (input.pluginUris.includes(SESSION_DIAGNOSTICS_URI) && !selected.includes(SESSION_DIAGNOSTICS_URI)) {
    throw new LoopFailure('plugin_user_selection_required', 'Session Diagnostics requires an explicit user selection.');
  }
  const uris = [...new Set([...selected, ...input.pluginUris])];
  return preparation.prepare({
    sessionId, runId, profileId: runtime.provider.profileId,
    environment: runtime.environment,
    ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
    previousProviderToolAliases: runtime.providerToolAliases,
    pluginSelections: uris.map(uri => ({ selectionId: nextId('plugin-selection'), uri: uri as PluginUri, label: uri.slice(0, 160) })),
  });
}
