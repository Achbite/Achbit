import { permissionPolicyConstraints, type AgentRecipe, type PluginUri } from '@achbit/protocol';
import { SESSION_DIAGNOSTICS_URI } from './sessionReading.js';
import { capturedPresentation } from './codingPrompt.js';
import { LoopFailure } from './loopFailure.js';
import type { NewSessionEvent, PreparedRequestToolView, RunRuntimeSnapshot } from '@achbit/protocol';
import type { PluginActivationInput, SessionCapabilities } from './plugins.js';
import type { AgentLoopDeps, LoopSnapshot } from './loopTypes.js';
import { localAgentError, runRuntimeSnapshot } from './loopFacts.js';

type PendingActivation = NonNullable<LoopSnapshot['state']['pendingPluginActivation']>;

export function preparedToolView(runtime: RunRuntimeSnapshot): PreparedRequestToolView {
  const { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools, toolPromptContributions,
    providerToolAliases, selectedPlugins } = runtime;
  return { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools, toolPromptContributions, providerToolAliases, selectedPlugins };
}

/** A durable preparing marker crosses the point where Kernel may have acquired resources. */
export function interruptedActivation(sessionId: string, pending: PendingActivation): Extract<NewSessionEvent, {type: 'session.plugins.failed'}> {
  const { runId, callId } = pending;
  return { type: 'session.plugins.failed', sessionId, runId, callId, payload: pending.phase === 'requested'
    ? { outcome: 'notExecuted', error: { code: 'plugin_activation_not_started', message: 'Plugin preparation did not start.' } }
    : { outcome: 'indeterminate', error: { code: 'plugin_activation_outcome_unknown',
      message: 'Plugin preparation started without a published result. Do not automatically repeat it.' } } };
}

/** Called after the original batch drains, before any new tool view, queued input or model request. */
export async function finishPluginActivation(snapshot: LoopSnapshot, pending: PendingActivation, controls: SessionCapabilities['controls'],
  deps: AgentLoopDeps, signal: AbortSignal): Promise<void> {
  const { sessionId } = snapshot.state;
  const { runId, callId, providerCallId, pluginUris, workspaceBindingIds, providerRequestId } = pending;
  const identity = { sessionId, runId, callId };
  const runtime = runRuntimeSnapshot(snapshot, runId);
  const receipt = snapshot.state.contextCompositions.find(item => item.providerRequestId === providerRequestId && item.runId === runId);
  if (!controls || !receipt || receipt.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef) {
    // A replaced Host/view is not a license to retarget the old control.
    await deps.commit({ type: 'session.plugins.failed', ...identity, payload: { outcome: 'notExecuted',
      error: { code: 'plugin_activation_binding_unavailable', message: 'The original activation binding is unavailable; no preparation was started.' } } });
    return;
  }
  await deps.commit(() => { signal.throwIfAborted(); return [{ type: 'session.plugins.preparing', ...identity, payload: {} }]; });
  signal.throwIfAborted();
  let view: PreparedRequestToolView;
  try {
    // Even if cancelled, wait for admitted preparation before freeing the run's resources.
    view = preparedToolView((await controls.preparePlugins({ sessionId, runId, runtime, pluginUris, workspaceBindingIds,
      nextId: deps.nextId, preparation: deps.composition.runPreparation })).runtimeSnapshot);
  } catch (cause) {
    if (signal.aborted && cause === signal.reason) throw cause;
    // A run can be cancelled while we drain the call. Its negative receipt still belongs to this slot.
    const error = localAgentError(cause);
    await deps.commit({ type: 'session.plugins.failed', ...identity, payload: {
      outcome: error.code === 'plugin_activation_outcome_unknown' ? 'indeterminate' : 'failed', error } });
    signal.throwIfAborted();
    return;
  }
  await deps.commit(() => {
    signal.throwIfAborted();
    return [{ type: 'session.plugins.activated', ...identity, payload: { providerCallId, pluginUris, kernelCatalogSnapshotRef: view.kernelCatalogSnapshotRef } },
      { type: 'run.tools.prepared', sessionId, runId, payload: { toolView: view } }];
  });
}

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
