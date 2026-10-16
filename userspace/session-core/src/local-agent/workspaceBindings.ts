import type { FilesystemReference, SessionEvent, WorkspaceBindingDisplay } from '@deepcode/protocol';

/** Resource addresses extend a request's lookup view, never the Run's working directories. */
export function appendResourceBindings(
  bindings: readonly WorkspaceBindingDisplay[],
  references: readonly FilesystemReference[] = [],
): WorkspaceBindingDisplay[] {
  const result = bindings.map(binding => ({ ...binding }));
  const known = new Set(result.map(binding => binding.workspaceId));
  for (const reference of references) {
    if (known.has(reference.workspaceId)) continue;
    known.add(reference.workspaceId);
    result.push({ workspaceId: reference.workspaceId, displayName: reference.displayName });
  }
  return result;
}

export function requestResourceBindings(
  bindings: readonly WorkspaceBindingDisplay[],
  events: readonly SessionEvent[],
  throughSequence = Infinity,
): WorkspaceBindingDisplay[] {
  return appendResourceBindings(bindings, events.flatMap(event => (
    event.sequence <= throughSequence && event.type === 'message.committed' && event.payload.role === 'user'
      ? event.payload.filesystemReferences ?? [] : []
  )));
}
