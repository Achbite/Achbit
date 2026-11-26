import type { ChangedFile } from './fileChangeSummary';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import type { ArtifactProjection } from '@achbit/protocol';
import { canonicalFileKey, type SourcePosition } from './resourceLinks';
import type { NativePage } from '../../services/nativeBrowser';
export type AgentReaderTarget = { kind: 'agent'; parentSessionId: string; agentSessionId?: string; entryId?: string };
export type ReaderFileTarget = (({ kind: 'workspace'; workspaceId: string; logicalPath: string } & SourcePosition)
  | { kind: 'resource'; resource: ResourceReference; name: string }
  | { kind: 'file'; path: string }) & { canonicalPath?: string; sourceSessionId?: string; mediaType?: string };
export type ReaderTarget = ReaderFileTarget | ({ kind: 'diff'; file: ChangedFile }
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

/** Only an explicit close of the selected tab may choose its successor. */
export function removeReaderTab(state: ReaderViewState, id: string, selectRemaining: boolean): ReaderViewState {
  const tabs = state.tabs.filter(tab => tab.id !== id);
  const activeId = state.activeId === id || state.activeId === null
    ? selectRemaining ? tabs.at(-1)?.id ?? null : null
    : state.activeId;
  return { ...state, tabs, activeId };
}
/** File-backed outputs and body links use the file manager's ordinary target.
 * Inline component previews keep their explicit archived HTML placement. */
export function artifactReaderTarget(artifact: ArtifactProjection): ResolvedReaderTarget {
  return artifact.workspaceId && artifact.logicalPath
    ? { kind: 'workspace', workspaceId: artifact.workspaceId, logicalPath: artifact.logicalPath }
    : { kind: 'artifact', artifact };
}

export function isReaderFile(target: ReaderTarget): target is ReaderFileTarget {
  return target.kind === 'workspace' || target.kind === 'resource' || target.kind === 'file';
}

type IdentifyReaderFile = (ownerSessionId: string, target: ReaderFileTarget) => Promise<string>;

export async function identifyReaderFiles(sessionId: string, target: ReaderFileTarget, tabs: ReaderTab[], identify: IdentifyReaderFile) {
  const owner = target.sourceSessionId ?? sessionId;
  const located = { ...target, canonicalPath: target.canonicalPath ?? await identify(owner, target) };
  // Recover the physical identity of tabs restored from an earlier interface or package.
  const restored = new Map<ReaderTarget, ReaderFileTarget>();
  await Promise.all(tabs.map(async tab => {
    const previous = tab.target;
    if (!isReaderFile(previous) || previous.canonicalPath || (previous.sourceSessionId ?? sessionId) !== owner) return;
    try {
      const path = await identify(owner, previous);
      restored.set(previous, { ...previous, canonicalPath: path });
    } catch {
      // An unrelated missing or revoked restored file has no confirmed alias.
    }
  }));
  return { located, restored };
}

export function selectReaderTarget(state: ReaderViewState, sessionId: string | null, target: ResolvedReaderTarget,
  activate = true, restored?: Map<ReaderTarget, ReaderFileTarget>): ReaderViewState {
  const key = readerTargetKey(target);
  const before = state.sessionId === sessionId ? state.tabs : [];
  const tabs = restored?.size ? before.map(tab => restored.has(tab.target) ? { ...tab, target: restored.get(tab.target)! } : tab) : before;
  const matches = tabs.filter(tab => {
    const other = tab.target;
    if (isReaderFile(target) && isReaderFile(other)) {
      if ((target.sourceSessionId ?? sessionId) !== (other.sourceSessionId ?? sessionId)) return false;
      if (target.canonicalPath && other.canonicalPath) return canonicalFileKey(target.canonicalPath) === canonicalFileKey(other.canonicalPath);
      return readerResourceKey(other) === readerResourceKey(target);
    }
    return tab.id === key || target.kind === 'browser' && tab.page?.previewId === target.previewId;
  });
  const existing = matches.find(tab => tab.id === state.activeId) ?? matches[0];
  // A slower earlier click may open a different tab in the background, but cannot overwrite a newer location.
  if (!activate && existing) return state;
  let nextTabs: ReaderTab[];
  if (existing) {
    const update = target.kind === 'workspace' || target.kind === 'agent'
      || target.kind === 'resource' && existing.target.kind === 'file';
    const selected = target.kind === 'workspace' && target.line === undefined && !target.fragment && existing.target.kind === 'workspace' && existing.target.line !== undefined
      ? { ...target, line: existing.target.line, column: existing.target.column } : target;
    nextTabs = tabs.filter(tab => tab === existing || !matches.includes(tab))
      .map(tab => tab === existing && update ? { ...tab, target: selected } : tab);
  } else nextTabs = [...tabs, { id: key, target }];
  return { sessionId, tabs: nextTabs, activeId: activate ? existing?.id ?? key : state.activeId,
    visible: activate || state.visible, expanded: state.sessionId === sessionId && state.expanded };
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
  const key = isReaderFile(target) && target.canonicalPath ? 'file:' + canonicalFileKey(target.canonicalPath) : readerResourceKey(target);
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
