import { readerTargetKey, type ReaderLocation } from '../../components/local-agent/readerState';

/** UI locations only; conversation contents and execution remain in the shared store. */
export interface WorkbenchLocation {
  sessionId: string | null;
  draftProjectId: string | null;
  settingsOpen: boolean;
  reader: ReaderLocation;
}
export interface NavigationHistory { entries: WorkbenchLocation[]; cursor: number }

export function locationKey(location: WorkbenchLocation): string {
  const { target, visible, expanded } = location.reader;
  return JSON.stringify([location.sessionId, location.draftProjectId, location.settingsOpen,
    visible, expanded, target && readerTargetKey(target),
    target?.kind === 'workspace' ? [target.line, target.column] : null]);
}

export function visitLocation(history: NavigationHistory, location: WorkbenchLocation): NavigationHistory {
  const current = history.entries[history.cursor];
  if (current && locationKey(current) === locationKey(location)) return history;
  const entries = [...history.entries.slice(0, history.cursor + 1), location];
  return { entries, cursor: entries.length - 1 };
}

/** Closing a native page releases its identity; history must not reactivate it. */
export function forgetClosedBrowser(history: NavigationHistory, sessionId: string | null, tabId: string): NavigationHistory {
  const keep = (location: WorkbenchLocation) => location.sessionId !== sessionId
    || location.reader.target?.kind !== 'browser' || readerTargetKey(location.reader.target) !== tabId;
  const entries = history.entries.filter(keep);
  return entries.length === history.entries.length ? history : {
    entries, cursor: history.entries.slice(0, history.cursor + 1).filter(keep).length - 1,
  };
}
