import type { ChangedFile } from './fileChangeSummary';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import type { ArtifactProjection } from '@achbit/protocol';
import type { SourcePosition } from './resourceLinks';
import type { NativePage } from '../../services/nativeBrowser';
export type AgentReaderTarget = { kind: 'agent'; parentSessionId: string; agentSessionId?: string; entryId?: string };
export type ReaderTarget = (({ kind: 'workspace'; workspaceId: string; logicalPath: string } & SourcePosition)
  | { kind: 'resource'; resource: ResourceReference; name: string }
  | { kind: 'diff'; file: ChangedFile }
  | { kind: 'file'; path: string }
  | { kind: 'artifact'; artifact: ArtifactProjection; interactive?: boolean }
  | AgentReaderTarget) & { sourceSessionId?: string }
  | { kind: 'browser'; previewId?: string; url?: string; filePath?: string; selfPreview?: boolean };
export type ResolvedReaderTarget = Exclude<ReaderTarget, { kind: 'browser' }>
  | (Extract<ReaderTarget, { kind: 'browser' }> & { previewId: string });
export interface ReaderLocation {
  sessionId: string | null;
  target: ResolvedReaderTarget | null;
  visible: boolean;
  expanded: boolean;
}
export interface ReaderNavigationRequest { id: number; location: ReaderLocation }
export interface ReaderNavigation {
  request: ReaderNavigationRequest | null;
  onChange: (location: ReaderLocation) => void;
  onTabClosed: (sessionId: string | null, tabId: string) => void;
}
export type ReaderTab = { id: string; target: ResolvedReaderTarget; page?: NativePage };
export interface ReaderViewState {
  sessionId: string | null;
  tabs: ReaderTab[];
  activeId: string | null;
  visible: boolean;
  expanded: boolean;
}

/** Restoring a selection is not an explicit request to reveal the Reader. */
export function readReaderViewState(sessionId: string | null): ReaderViewState {
  const selected = sessionId ? readViewState<ReaderTarget | null>(sessionId + ':selection', null) : null;
  // Native pages are restored by their owning Host's page catalogue.
  const tabs: ReaderTab[] = selected && selected.kind !== 'browser'
    ? [{ id: readerTargetKey(selected), target: selected }] : [];
  return { sessionId, tabs, activeId: tabs[0]?.id ?? null,
    visible: sessionId ? readViewState(sessionId + ':visible', tabs.length > 0) : false, expanded: false };
}

export function reconcileReaderPages(state: ReaderViewState, pages: NativePage[], savedSelection?: ReaderTarget | null): ReaderViewState {
  const available = new Map(pages.filter(page => page.sessionId === state.sessionId && page.status !== 'closed').map(page => [page.previewId, page]));
  const tabs = state.tabs.flatMap(tab => {
    if (tab.target.kind !== 'browser') return [tab];
    const page = available.get(tab.target.previewId);
    if (!page) return [];
    available.delete(page.previewId);
    return [{ ...tab, page }];
  });
  for (const page of available.values()) {
    const target: ResolvedReaderTarget = { kind: 'browser', previewId: page.previewId };
    tabs.push({ id: readerTargetKey(target), target, page });
  }
  const selected = state.activeId ?? (state.tabs.length === 0 && savedSelection ? readerTargetKey(savedSelection) : null);
  return { ...state, tabs, activeId: tabs.some(tab => tab.id === selected) ? selected : null };
}
/** File-backed outputs and body links use the file manager's ordinary target.
 * Inline component previews keep their explicit archived HTML placement. */
export function artifactReaderTarget(artifact: ArtifactProjection): ResolvedReaderTarget {
  return artifact.workspaceId && artifact.logicalPath
    ? { kind: 'workspace', workspaceId: artifact.workspaceId, logicalPath: artifact.logicalPath }
    : { kind: 'artifact', artifact };
}

export function selectReaderTarget(state: ReaderViewState, sessionId: string, target: ResolvedReaderTarget): ReaderViewState {
  const key = readerTargetKey(target);
  const tabs = state.sessionId === sessionId ? state.tabs : [];
  const existing = tabs.find(tab => tab.id === key
    || target.kind === 'browser' && tab.page?.previewId === target.previewId);
  return { sessionId,
    tabs: existing ? tabs.map(tab => tab === existing && (target.kind === 'workspace' || target.kind === 'agent')
      ? { ...tab, target } : tab) : [...tabs, { id: key, target }],
    activeId: existing?.id ?? key, visible: true,
    expanded: state.sessionId === sessionId && state.expanded };
}

export const READER_OPEN_EVENT = 'achbit:reader-open';
export function requestReader(sessionId: string, target: ReaderTarget): void {
  window.dispatchEvent(new CustomEvent(READER_OPEN_EVENT, {detail: {sessionId, target}}));
}
export function requestWorkspacePreview(sessionId: string, workspaceId: string, logicalPath: string): Promise<void> {
  requestReader(sessionId, {kind:'workspace', workspaceId, logicalPath});
  return Promise.resolve();
}
export function readViewState<T>(key: string, initial: T): T {
  try { const saved = sessionStorage.getItem(`achbit:reader:${key}`); return saved ? JSON.parse(saved) as T : initial; }
  catch { return initial; }
}
export function saveViewState(key: string, value: unknown): void {
  sessionStorage.setItem(`achbit:reader:${key}`, JSON.stringify(value));
}

export function readerTargetKey(target: ReaderTarget): string {
  const key = readerResourceKey(target);
  return target.kind !== 'browser' && target.kind !== 'agent' && target.sourceSessionId ? JSON.stringify([target.sourceSessionId, key]) : key;
}

function readerResourceKey(target: ReaderTarget): string {
  if (target.kind === 'agent') return 'agents';
  if (target.kind === 'diff') return 'diff:' + JSON.stringify(target.file.changes.map(entry => [entry.recordId, entry.index]));
  if (target.kind === 'resource') return 'resource:' + resourceKey(target.resource);
  if (target.kind === 'file') return 'file:' + target.path;
  if (target.kind === 'workspace')
    return 'resource:' + resourceKey({ workspaceId: target.workspaceId, logicalPath: target.logicalPath });
  if (target.kind === 'artifact') return (target.interactive ? 'preview:' : 'artifact:') + target.artifact.artifactId;
  return 'browser:' + target.previewId;
}
