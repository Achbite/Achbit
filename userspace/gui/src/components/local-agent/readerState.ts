import type { ChangedFile } from './fileChangeSummary';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import type { ArtifactProjection } from '@deepcode/protocol';
import type { SourcePosition } from './resourceLinks';
import type { NativePage } from '../../services/nativeBrowser';
export type ReaderTarget = (({ kind: 'workspace'; workspaceId: string; logicalPath: string } & SourcePosition)
  | { kind: 'resource'; resource: ResourceReference; name: string }
  | { kind: 'diff'; file: ChangedFile }
  | { kind: 'file'; path: string }
  | { kind: 'artifact'; artifact: ArtifactProjection }) & { sourceSessionId?: string }
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
export const READER_OPEN_EVENT = 'deepcode:reader-open';
export function requestReader(sessionId: string, target: ReaderTarget): void {
  window.dispatchEvent(new CustomEvent(READER_OPEN_EVENT, {detail: {sessionId, target}}));
}
export function requestWorkspacePreview(sessionId: string, workspaceId: string, logicalPath: string): Promise<void> {
  requestReader(sessionId, {kind:'workspace', workspaceId, logicalPath});
  return Promise.resolve();
}
export function readViewState<T>(key: string, initial: T): T {
  try { const saved = sessionStorage.getItem(`deepcode:reader:${key}`); return saved ? JSON.parse(saved) as T : initial; }
  catch { return initial; }
}
export function saveViewState(key: string, value: unknown): void {
  sessionStorage.setItem(`deepcode:reader:${key}`, JSON.stringify(value));
}

export function readerTargetKey(target: ReaderTarget): string {
  const key = readerResourceKey(target);
  return target.kind !== 'browser' && target.sourceSessionId ? JSON.stringify([target.sourceSessionId, key]) : key;
}

function readerResourceKey(target: ReaderTarget): string {
  if (target.kind === 'diff') return 'diff:' + JSON.stringify(target.file.changes.map(entry => [entry.recordId, entry.index]));
  if (target.kind === 'resource') return 'resource:' + resourceKey(target.resource);
  if (target.kind === 'file') return 'file:' + target.path;
  if (target.kind === 'workspace')
    return 'resource:' + resourceKey({ workspaceId: target.workspaceId, logicalPath: target.logicalPath });
  if (target.kind === 'artifact') return 'artifact:' + target.artifact.artifactId;
  return 'browser:' + target.previewId;
}
