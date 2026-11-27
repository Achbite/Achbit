import { permissionPolicyConstraints, type AgentRecipe, type PluginUri } from '@achbit/protocol';
import { SESSION_DIAGNOSTICS_URI } from './sessionReading.js';
import { capturedPresentation } from './codingPrompt.js';
import { LoopFailure } from './loopFailure.js';
import type { PluginActivationInput } from './plugins.js';

/** Optional reader selections go through the same enabled-catalog admission as inherited selections. */
export function linkedReaderUris(text: string, recipe: AgentRecipe): PluginUri[] {
  if (recipe.tools?.plugins === false || recipe.workspaceSandbox?.requireIsolatedProcesses) return [];
  const policy = permissionPolicyConstraints(recipe.permissionPolicy);
  if (!policy.allowHostExecution || !policy.allowExternalTools) return [];
  const found = new Set<PluginUri>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\u0060，。！？；）】]+/giu)) {
    let url: URL;
    try { url = new URL(match[0].replace(/[).,;\]]+$/u, '')); } catch { continue; }
    if (url.username || url.password || url.port) continue;
    const path = url.pathname.replace(/\/$/u, '');
    if (url.protocol === 'https:' && ['github.com', 'www.github.com'].includes(url.hostname)
      && /^\/[\w.-]+\/[\w.-]+(?:\/(?:issues\/[1-9]\d*|pull\/[1-9]\d*(?:\/(?:files|commits))?))?$/u.test(path)) {
      found.add('plugin://github@first-party');
    } else if (['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)
      && /^\/(?:abs|pdf|html)\/(?:\d{4}\.\d{4,5}|[a-zA-Z][a-zA-Z.-]*\/\d{7})(?:v[1-9]\d*)?(?:\.pdf)?$/u.test(path)) {
      found.add('plugin://arxiv@first-party');
    }
  }
  return [...found];
}

/** Activation prepares a replacement tool view; Kernel owns binding and retirement. */
export function preparePluginActivation(input: PluginActivationInput) {
  const { runtime, sessionId, runId, nextId, preparation } = input;
  const selected = runtime.selectedPlugins.plugins.map(plugin => plugin.uri);
  if (input.pluginUris.includes(SESSION_DIAGNOSTICS_URI) && !selected.includes(SESSION_DIAGNOSTICS_URI)) {
    throw new LoopFailure('plugin_user_selection_required', 'Session Diagnostics requires an explicit user selection.');
  }
  const selection = (uri: string) => ({ selectionId: nextId('plugin-selection'), uri: uri as PluginUri, label: uri.slice(0, 160) });
  return preparation.prepare({
    sessionId, runId, profileId: runtime.provider.profileId,
    environment: runtime.environment,
    ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
    previousProviderToolAliases: runtime.providerToolAliases,
    existingPresentation: capturedPresentation(runtime),
    workspaceBindingIds: input.workspaceBindingIds, modelActivation: true,
    pluginSelections: input.pluginUris.map(selection),
    inheritedPluginSelections: selected.filter(uri => !input.pluginUris.includes(uri)).map(selection),
  });
}
