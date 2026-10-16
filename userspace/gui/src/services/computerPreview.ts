import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

export function computerPreviewSources(platform: string) {
  return { desktop: /Mac|Win/.test(platform), browser: /Mac/.test(platform), stopTask: /Win/.test(platform) };
}

export interface PreviewFrame { sequence: number; capturedAt: string; width: number; height: number; dataUrl: string }
export interface DesktopPreviewTarget { windowId: number; generation: number; pid: number; app: string; title: string; width: number; height: number }
export interface BrowserPreviewTarget { previewId: string; url: string; hostInstanceId: string; windowLabel: string; sessionId: string }
export interface ComputerPreview<T = DesktopPreviewTarget> {
  state: string;
  reason?: string;
  pending?: boolean;
  target?: T;
  frame?: PreviewFrame;
  frameError?: string;
  pointer?: { x: number; y: number; coordinateSpace: 'target-normalized'; pulse: boolean; sharing?: { state: string } };
}

export function targetIdentity(target: DesktopPreviewTarget | BrowserPreviewTarget | undefined): string | undefined {
  return !target ? undefined : 'previewId' in target
    ? `${target.hostInstanceId}:${target.windowLabel}:${target.sessionId}:${target.previewId}`
    : `${target.windowId}:${target.generation}`;
}

/** Closed targets have no preview; a delta frame belongs only to its exact target. */
export function acceptPreview<T extends DesktopPreviewTarget | BrowserPreviewTarget>(previous: ComputerPreview<T> | null, next: ComputerPreview<T>): ComputerPreview<T> | null {
  if (next.state === 'closed') return null;
  if (next.pending) return previous ?? { state: 'starting' };
  if (next.state !== 'active' || !next.target) return { ...next, frame: undefined, pointer: undefined };
  const frame = next.frame ?? (!next.frameError && targetIdentity(previous?.target) === targetIdentity(next.target) ? previous?.frame : undefined);
  return { ...next, frame, pointer: next.pointer?.sharing && next.pointer.sharing.state !== 'active' ? undefined : next.pointer };
}

async function request<T>(path: string, input: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${getKernelApiBase()}/host/computer-preview${path}`, {
    method: 'POST', headers: { ...getHostConnectionHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input), signal,
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body.data as T;
}

export function readDesktopPreview(sessionId: string, runId: string, afterSequence: number | undefined, signal: AbortSignal) {
  return request<ComputerPreview>('', { sessionId, runId, afterSequence }, signal);
}
export function activateDesktopPreview(sessionId: string, runId: string, target: DesktopPreviewTarget, signal: AbortSignal) {
  return request<{ activated: boolean }>('/activate', { sessionId, runId, windowId: target.windowId, generation: target.generation }, signal);
}

export interface PreviewRect { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** UiRegion mounts through display:contents wrappers; observe the boxes they actually render. */
export function previewRailElements(rail: Element): Element[] {
  return [...rail.children].flatMap(child => getComputedStyle(child).display === 'contents'
    ? previewRailElements(child) : child.getBoundingClientRect().height > 0 ? [child] : []);
}

export function constrainPreviewPosition(position: { left: number; top: number }, size: { width: number; height: number },
  bounds: PreviewRect, viewport: { width: number; height: number }, composerTop: number) {
  const minLeft = Math.max(0, bounds.left) + 12;
  const minTop = Math.max(0, bounds.top) + 12;
  const right = Math.min(viewport.width, bounds.right) - 12;
  const bottom = Math.min(viewport.height, bounds.bottom, composerTop) - 12;
  const width = Math.min(size.width, Math.max(0, right - minLeft));
  const maxHeight = Math.max(0, bottom - minTop);
  return {
    left: Math.min(Math.max(position.left, minLeft), Math.max(minLeft, right - width)),
    top: Math.min(Math.max(position.top, minTop), Math.max(minTop, bottom - Math.min(size.height, maxHeight))),
    width, maxHeight,
  };
}

/** Fit the bounded thumbnail to actual free rail space, or to the conversation beside Reader. */
export function previewPlacement(conversation: PreviewRect, rail: PreviewRect | null, cardsBottom: number, viewport: { width: number; height: number }, composerTop: number, index = 0) {
  const margin = 12;
  const stagger = index * 24;
  const area = rail && rail.width > 0 ? rail : conversation;
  const right = Math.min(area.right, viewport.width) - margin;
  const left = Math.max(area.left, 0) + margin;
  const top = Math.max(area.top + margin, rail ? cardsBottom + margin : area.top + margin, 0) + stagger;
  const bottom = Math.min(area.bottom, viewport.height, rail ? viewport.height : composerTop) - margin;
  const width = Math.min(240, Math.max(0, right - left));
  return { left: Math.max(left, right - width - stagger), top, width, maxHeight: Math.max(0, bottom - top) };
}
