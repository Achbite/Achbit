// TCR: .task-artifacts/frontend-fixes-20261113/TCR.md.
// Real browser/remote picker, with explicit failure and out-of-order read fixtures.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProjectFolderDialog from '../../src/components/workspace-open-dialog/ProjectFolderDialog';
import { createInteractionFocus, installInteractionFocus, InteractionFocusContext } from '../../src/components/shared/interactionFocus';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/components/shared/focus.css';

type RequestTrace = { id: number; path: string; status: 'pending' | 'success' | 'failure'; kind: 'initial' | 'browse' };
type Confirmation = { path: string; kind: string; latestNavigation: RequestTrace | null; pending: number[]; errorVisible: boolean };
let nextId = 0;
const requests: RequestTrace[] = [], confirmations: Confirmation[] = [], unexpected: string[] = [];
const pending = new Map<number, { path: string; resolve: (response: Response) => void }>();
const latest = () => requests.filter(row => row.kind === 'browse').at(-1) ?? null;
const canonical = (path: string) => /\/(one\.txt|two\.md)$/.test(path) ? path.slice(0, path.lastIndexOf('/')) : path;
const success = (path: string) => { const directory = canonical(path); return { ok: true, data: {
  absolutePath: directory, parentPath: '/audit', entries: [
    { name: 'nested', type: 'directory', absolutePath: directory + '/nested', hidden: false, isCodeWorkspace: false },
    ...['one.txt', 'two.md'].map(name => ({ name, type: 'file', absolutePath: directory + '/' + name, hidden: false, isCodeWorkspace: false })),
  ],
} }; };
const failure = (path: string) => ({ ok: false, error: 'host_browse_unavailable', message: `Fixture browse failed for ${path}` });
function finish<T extends { ok: boolean }>(id: number, reply: T) {
  requests.find(row => row.id === id)!.status = reply.ok ? 'success' : 'failure';
  return Response.json(reply);
}
window.__ACHBIT_BROWSER_PREVIEW__ = true;
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'GET' || !['/api/fs/initial-locations', '/api/fs/browse'].includes(url.pathname)) {
    const message = `Unexpected fixture request: ${method} ${url.pathname}`; unexpected.push(message); throw new Error(message);
  }
  const initial = url.pathname === '/api/fs/initial-locations';
  const path = initial ? '(initial-locations)' : url.searchParams.get('path') ?? '/audit/A';
  const id = ++nextId;
  requests.push({ id, path, status: 'pending', kind: initial ? 'initial' : 'browse' });
  if (initial) return finish(id, { ok: true, data: { platform: 'linux', locations: [
    { kind: 'home', label: 'Fixture A', absolutePath: '/audit/A' },
    { kind: 'workspace', label: 'Slow B', absolutePath: '/audit/slow-B' },
    { kind: 'workspace', label: 'Immediate C', absolutePath: '/audit/C' },
  ] } });
  if (path === '/audit/slow-B') return new Promise<Response>(resolve => pending.set(id, { path, resolve }));
  return finish(id, path === '/audit/missing/child' ? failure(path) : success(path));
};
function observe() {
  const dialog = document.querySelector<HTMLDialogElement>('dialog.ws-open-dialog__backdrop');
  const confirm = dialog?.querySelector<HTMLButtonElement>('.ws-open-dialog__btn--primary');
  const active = document.activeElement;
  return { dialogOpen: dialog?.open ?? false,
    address: dialog?.querySelector<HTMLInputElement>('.ws-open-dialog__address')?.value ?? null,
    footerPath: dialog?.querySelector('.ws-open-dialog__footer-info')?.textContent ?? null,
    confirmDisabled: confirm?.disabled ?? null,
    error: dialog?.querySelector('.ws-open-dialog__error')?.textContent ?? null,
    rows: [...(dialog?.querySelectorAll<HTMLElement>('.ws-open-dialog__entry') ?? [])].map(row => ({
      text: row.textContent, tabIndex: row.tabIndex, nativeControls: row.querySelectorAll('button,input,[tabindex="0"]').length,
    })),
    activeElement: active instanceof HTMLElement ? { tag: active.tagName, text: active.textContent?.slice(0, 100),
      className: active.className, isFileEntry: Boolean(active.closest('.ws-open-dialog__entry')) } : null,
  };
}
const audit = { observe,
  snapshot: () => structuredClone({ requests, confirmations, unexpected }),
  check: () => ({ dom: observe(), snapshot: structuredClone({ requests, confirmations, unexpected }) }),
  release(id: number, outcome: 'success' | 'failure' = 'success') {
    const operation = pending.get(id); if (!operation) throw new Error(`No pending browse ${id}`);
    pending.delete(id); operation.resolve(finish(id, outcome === 'success' ? success(operation.path) : failure(operation.path)));
  },
};
declare global { interface Window { __sharedControlsAudit: typeof audit } }
window.__sharedControlsAudit = audit;
const interaction = createInteractionFocus(), stopFocus = installInteractionFocus(document, interaction);
installPaletteDefaults();
function Fixture() {
  const [mode, setMode] = useState<'directory' | 'file' | 'messageAttachment' | null>(null);
  const [selected, setSelected] = useState('');
  return <>
    <header style={{ padding: 20 }}><h1>Path picker interactions</h1>
      <p>Actual component with synthetic transport. This is not a native OS picker or SSH end-to-end test.</p>
      <button id="open-directory" onClick={() => setMode('directory')}>Choose directory</button>{' '}
      <button id="open-file" onClick={() => setMode('file')}>Choose file</button>{' '}
      <button id="open-attachments" onClick={() => setMode('messageAttachment')}>Choose attachments</button>
      <output id="selection">{selected}</output>
    </header>
    {mode && <ProjectFolderDialog language="en-US" selectionMode={mode} onCancel={() => setMode(null)}
      onSelect={(path, kind) => {
        confirmations.push({ path, kind, latestNavigation: latest() ? { ...latest()! } : null,
          pending: requests.filter(row => row.status === 'pending').map(row => row.id), errorVisible: Boolean(observe().error) });
        setSelected(path); setMode(null);
      }} onSelectMany={mode === 'messageAttachment' ? items => { setSelected(JSON.stringify(items)); setMode(null); } : undefined} />}
  </>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<InteractionFocusContext.Provider value={interaction}><Fixture /></InteractionFocusContext.Provider>);
window.addEventListener('pagehide', () => { root.unmount(); stopFocus(); window.fetch = originalFetch; }, { once: true });
