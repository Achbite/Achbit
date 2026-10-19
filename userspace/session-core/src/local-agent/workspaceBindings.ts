import type { FilesystemReference, NewSessionEvent, SessionEvent, WorkspaceBindingDisplay } from '@deepcode/protocol';

/** Address lookup does not itself grant workspace or file authority. */
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
  const visible = events.filter(event => event.sequence <= throughSequence);
  const start = visible.findLast(event => event.type === 'run.started');
  const references = visible.flatMap(event => event.type === 'message.committed' && event.payload.role === 'user'
    ? event.payload.filesystemReferences ?? [] : []);
  const available = new Set([...bindings, ...references].map(binding => binding.workspaceId));
  const result = (start?.payload.workspaceBindings ?? bindings).map(binding => ({ ...binding }));
  const known = new Set(result.map(binding => binding.workspaceId));
  const append = (binding: WorkspaceBindingDisplay) => {
    if (!known.has(binding.workspaceId)) {
      known.add(binding.workspaceId);
      result.push({ workspaceId: binding.workspaceId, displayName: binding.displayName });
    }
  };
  // Retain first-seen address order as formal bindings grow, so existing handles
  // do not move when a queued directory becomes a project. Calls retain their receipt.
  for (const event of visible) {
    if (event.type === 'message.committed' && event.payload.role === 'user') {
      for (const reference of event.payload.filesystemReferences ?? []) append(reference);
    } else if (event.type === 'session.directory-index.attached' && event.sequence > (start?.sequence ?? 0)) {
      append(event.payload.workspaceBinding);
    } else if (event.type === 'session.workspaces.updated' && event.sequence > (start?.sequence ?? 0)) {
      for (const binding of event.payload.workspaceBindings) append(binding);
    }
  }
  for (const binding of bindings) append(binding);
  return result.filter(binding => available.has(binding.workspaceId));
}

/** User-supplied directories become bindings only when their input is consumed. */
export function directoryBindingEvents(
  sessionId: string,
  commandId: string,
  bindings: readonly WorkspaceBindingDisplay[],
  references: readonly FilesystemReference[],
): NewSessionEvent[] {
  const known = new Set(bindings.map(binding => binding.workspaceId));
  return references.flatMap(reference => {
    if (reference.kind !== 'directory' || known.has(reference.workspaceId)) return [];
    known.add(reference.workspaceId);
    return [{ type: 'session.directory-index.attached' as const, sessionId,
      payload: { commandId, workspaceBinding: { workspaceId: reference.workspaceId, displayName: reference.displayName } } }];
  });
}
