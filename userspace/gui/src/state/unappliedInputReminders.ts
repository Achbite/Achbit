const storageKey = (sessionId: string) => `achbit:unapplied-dismissed:${sessionId}`;
const listeners = new Set<(sessionId: string, commandIds: string[]) => void>();

/** Window-local reminder visibility; never changes queued inputs or Session history. */
export function readDismissedUnappliedInputs(sessionId: string): string[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(sessionId)) ?? '[]');
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) {
      throw new Error('unapplied_dismissal_receipt_invalid');
    }
    return value;
  } catch (error) {
    console.error('Cannot read dismissed message reminders.', error);
    return [];
  }
}

export function dismissUnappliedInputs(sessionId: string, commandIds: readonly string[]): string[] {
  const next = [...new Set([...readDismissedUnappliedInputs(sessionId), ...commandIds])];
  // A failed receipt write must not promise a dismissal that will reappear.
  sessionStorage.setItem(storageKey(sessionId), JSON.stringify(next));
  for (const listener of listeners) listener(sessionId, next);
  return next;
}

export function subscribeUnappliedInputReminders(sessionId: string, onChange: (commandIds: string[]) => void): () => void {
  const listener = (id: string, commandIds: string[]) => { if (id === sessionId) onChange(commandIds); };
  listeners.add(listener);
  onChange(readDismissedUnappliedInputs(sessionId));
  return () => { listeners.delete(listener); };
}
