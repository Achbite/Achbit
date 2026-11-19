import readme from '../../../../README.md?raw';
import development from '../../../../docs/development.md?raw';
import React from 'react';
import { createRoot } from 'react-dom/client';
import AchbitWorkbenchLayout from '../../src/achbit-gui/layout/AchbitWorkbenchLayout';
import { ConversationDisplayProvider } from '../../src/components/local-agent/ConversationDisplayProvider';
import { useConversationHost } from '../../src/components/local-agent/ConversationHost';
import { requestReader, saveViewState } from '../../src/components/local-agent/readerState';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import { UiPluginsProvider } from '../../src/ui-plugins/UiPlugins';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/achbitGui.css';

const sessionId = 'session:reader-workbench';
const file = (name: string) => ({ kind: 'file' as const, path: '/fixture/' + name });
const host = useConversationHost();
const opened: string[] = [];
const folders: string[] = [], external: string[] = [];
const watching = new Set<string>();
let treeGeneration = 0;
const treeResources: { generation: number; ref: WeakRef<object> }[] = [];
const directoryListeners = new Set<() => void>();
const doc = 'notes/index.md';
const documents = new Map([
  ['notes/paths.md', 'A path /fixture/2026#2.md and a path /fixture/draft?again.md or `/fixture/literal%23.md`.'],
  ['2026#2.md', '# Physical number sign'],
  ['draft?again.md', '# Physical question mark'],
  ['literal%23.md', '# Physical percent sequence'],
  [doc, '[Notes folder](../notes/) · [Agent file](../Agent.md) · [Website](https://example.org/reader) · [Build](../README.md#build-from-source) · [Literal](encoded%23%3F.md?v=1#same-1)'],
  ['README.md', readme], ['docs/development.md', development],
  ['notes/encoded#?.md', '# Same\n\n' + 'filler paragraph\n\n'.repeat(60) + '## Same\n\nEnd.'],
  ['Agent.md', '# Agent file opened from a workspace'],
]);
host.resolveResource = async (_session, workspace, path) => {
  if (workspace !== 'fixture') throw new Error('unknown workspace');
  if (path === '.' || path === 'notes') return { path: path === '.' ? '/fixture' : '/fixture/' + path, kind: 'directory' };
  if (!documents.has(path)) throw new Error('missing ' + path);
  return { path: '/fixture/' + path, kind: 'file' };
};
host.resources = { ...host.resources,
  async listResourceRoots() {
    return [{ kind: 'directory', category: 'project', name: 'Fixture project', resource: { workspaceId: 'fixture', logicalPath: '' } }];
  },
  async listResourceDirectory(_session, reference) {
    if (reference.logicalPath) return [];
    const name = 'generation-' + treeGeneration + '.md';
    const resource = { kind: 'file' as const, name, resource: { workspaceId: 'fixture', logicalPath: name } };
    treeResources.push({ generation: treeGeneration, ref: new WeakRef(resource) });
    return [resource, { kind: 'file', name: 'Agent.md', resource: { workspaceId: 'fixture', logicalPath: 'Agent.md' } }];
  },
  async resolveResourceReference(session, reference) {
    if (!('workspaceId' in reference)) throw new Error('unknown reference');
    return host.resolveResource(session, reference.workspaceId, reference.logicalPath);
  },
  async readResourceBlob(_session, reference) {
    const text = documents.get(reference.logicalPath);
    if (text === undefined) throw new Error('missing ' + reference.logicalPath);
    return new Blob([text], { type: 'text/markdown' });
  },
  async watchResources(_session, references, signal, changed) {
    const key = references[0].logicalPath;
    const directory = references.findIndex(item => item.logicalPath === '');
    const update = () => changed([directory]);
    if (directory !== -1) directoryListeners.add(update);
    watching.add(key);
    changed([0]);
    await new Promise<void>(done => signal.addEventListener('abort', () => { watching.delete(key); directoryListeners.delete(update); done(); }, { once: true }));
  },
};
host.openExternalLink = async url => { external.push(url); };
host.locatePath = async path => { folders.push(path); };
host.selectedFilePath = async path => path;
host.readLocalFile = async path => new Blob(['# ' + path], { type: 'text/plain' });
host.openFile = async path => { opened.push(path); };
saveViewState(sessionId + ':selection', file('Agent.md'));
saveViewState(sessionId + ':visible', true);
saveViewState('file-tree', false);
useLocalAgentStore.setState({ sessionId, runtimeReady: true });
Object.assign(window, { readerWorkbench: { open: (name: string) => requestReader(sessionId, file(name)), opened, folders, external, watching,
  changeDirectory() { treeGeneration++; directoryListeners.forEach(update => update()); },
  directoryMemory: () => ({ reads: treeResources.length, removed: treeResources.filter(item => item.generation < treeGeneration).length,
    retained: treeResources.filter(item => item.generation < treeGeneration && item.ref.deref()).map(item => item.generation) }),
  openDocument: (path = doc) => requestReader(sessionId, { kind: 'workspace', workspaceId: 'fixture', logicalPath: path }) } });
installPaletteDefaults();

createRoot(document.getElementById('root')!).render(
  <UiPluginsProvider><ConversationDisplayProvider>
    <AchbitWorkbenchLayout apiStatus="checking" />
  </ConversationDisplayProvider></UiPluginsProvider>,
);
