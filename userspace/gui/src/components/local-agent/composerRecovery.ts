import type { QueuedInputProjection } from '@achbit/protocol';
import { cloneComposerState, composerStateIsEmpty, type ComposerState } from './composerSubmission';

export function composerContentKey(state: ComposerState): string {
  const { selectionStart: _start, selectionEnd: _end, focused: _focused, ...content } = cloneComposerState(state);
  return JSON.stringify(content);
}

/** Pure draft merge. Session history is never acknowledged, mutated or submitted here. */
export function restoreUnappliedInputs(current: ComposerState, inputs: readonly QueuedInputProjection[], append = false): ComposerState {
  const restored = new Set(current.restoredInputIds ?? []);
  const additions = inputs.filter(input => input.status === 'notApplied' && !restored.has(input.commandId))
    .sort((left, right) => left.sequence - right.sequence);
  if (!additions.length) return current;
  if (!append && !composerStateIsEmpty(current)) throw new Error('composer_restore_append_confirmation');
  const next = cloneComposerState(current);
  const resourceKey = (item: QueuedInputProjection['filesystemReferences'][number]) => `${item.workspaceId}\u0000${item.logicalPath}`;
  const references = new Map((next.filesystemReferences ?? []).map(item => [resourceKey(item), item]));
  const plugins = new Map(next.pluginSelections.map(item => [item.uri, item]));
  const guidance = new Map((next.guidanceReferences ?? []).map(item => [item.referenceId, item]));
  const text = [next.draft];
  for (const input of additions) {
    if (restored.has(input.commandId)) continue;
    if (input.text) text.push(input.text);
    for (const item of input.filesystemReferences) {
      const existing = references.get(resourceKey(item));
      if (existing) {
        const { referenceId: _old, ...before } = existing, { referenceId: _new, ...after } = item;
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('composer_restore_resource_conflict');
      } else references.set(resourceKey(item), structuredClone(item));
    }
    for (const item of input.pluginSelections) plugins.set(item.uri, { ...item });
    for (const item of input.guidanceReferences ?? []) guidance.set(item.referenceId, structuredClone(item));
    restored.add(input.commandId);
  }
  if (references.size + next.filesystemPaths.length + next.pastedImages.length + next.pastedTexts.length > 8)
    throw new Error('message_filesystem_reference_limit');
  next.draft = text.filter(Boolean).join('\n\n');
  next.filesystemReferences = [...references.values()];
  next.pluginSelections = [...plugins.values()];
  next.guidanceReferences = [...guidance.values()];
  next.restoredInputIds = [...restored];
  next.selectionStart = next.selectionEnd = next.draft.length;
  next.focused = true;
  return next;
}
