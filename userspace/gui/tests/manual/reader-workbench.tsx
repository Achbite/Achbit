import readme from '../../../../README.md?raw';
import development from '../../../../docs/development.md?raw';
import React from 'react';
import { emptySessionState, projectSession } from '../../../session-core/src/local-agent/reducer';
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
const progressiveSource = ['# Progressive document', '[Go to final heading](#last-section) · [defined below][end]', '',
  '| left | right |', '|---|---|', '| A &amp; B | &copy; |', '', ...Array.from({ length: 1250 }, (_, n) => 'Paragraph ' + n + ' with **formatted text** and a named reference [end].\n'),
  '## Last section', 'FINAL-READER-MARKER $x^2$', '', '[end]: ../Agent.md'].join('\n');
const saves: { bytes: number; type: string; width: number; height: number }[] = [];
host.saveImage = async ({ blob }) => {
  const image = await createImageBitmap(blob);
  saves.push({ bytes: blob.size, type: blob.type, width: image.width, height: image.height });
  image.close();
};
const directorySize = new URLSearchParams(location.search).get('files') === '5000' ? 5000 : 0;
const largeFiles = Array.from({ length: directorySize }, (_, index) => {
  const name = 'large-' + String(index + 1).padStart(5, '0') + '.md';
  return { kind: 'file' as const, name, resource: { workspaceId: 'fixture', logicalPath: name } };
});
const openingFence = '```text\n';
const longCode = 'a'.repeat(4096 - 5 - openingFence.length) + 'BOUNDARYMARKER' + 'b'.repeat(28_000) + 'FENCE-END';
const manyCodeLines = Array.from({ length: 1000 }, (_, i) => 'source line ' + i + ' (complete immutable code)').join('\n');
const copies: string[] = [];
host.copyText = async value => { copies.push(value); };
const documents = new Map([
  ['notes/long-code.md', openingFence + longCode + '\n```'],
  ['notes/many-lines.md', openingFence + manyCodeLines + '\n```'],
  ['notes/progressive.md', progressiveSource],
  ['notes/paths.md', 'A path /fixture/2026#2.md and a path /fixture/draft?again.md or `/fixture/literal%23.md`.'],
  ['2026#2.md', '# Physical number sign'],
  ['draft?again.md', '# Physical question mark'],
  ['literal%23.md', '# Physical percent sequence'],
  [doc, '[Notes folder](../notes/) · [Agent file](../Agent.md) · [Website](https://example.org/reader) · [Build](../README.md#build-from-source) · [Literal](encoded%23%3F.md?v=1#same-1)'],
  ['README.md', readme], ['docs/development.md', development],
  ['notes/encoded#?.md', '# Same\n\n' + 'filler paragraph\n\n'.repeat(60) + '## Same\n\nEnd.'],
  ['Agent.md', '# Agent file opened from a workspace'],
]);
for (const file of largeFiles) documents.set(file.name, '# Document ' + file.name);
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
    if (largeFiles.length) return largeFiles;
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
const changePath = 'many-changes.txt';
const openDiff = () => requestReader(sessionId, { kind: 'diff', file: { key: changePath, path: changePath, changes: [{
  recordId: 'record:many-changes', index: 0, change: { workspaceId: 'fixture', path: changePath, kind: 'modify',
    before: { exists: true }, after: { exists: true } },
}] } });
host.readChange = async (_session, recordId, index) => {
  if (recordId !== 'record:many-changes' || index !== 0) throw new Error('Unknown test record');
  const side = (prefix: string) => Array.from({ length: 6000 }, (_, i) => {
    const line = i + 1;
    const tag = line === 1 || line % 50 === 0 ? (prefix === 'OLD' ? 'OLD 🧪' : 'NEW 🦊') : 'unchanged 🧭';
    const singleCR = line === 1 ? '\r' + prefix + '-CR-ONE' : '';
    const ending = line === 6000 ? '' : (line + (prefix === 'OLD' ? 0 : 1)) % 2 ? '\r\n' : '\n';
    return tag + ' row ' + line + ' value ' + line * line + singleCR + ending;
  }).join('');
  return { workspaceId: 'fixture', path: changePath, before: side('OLD'), after: side('NEW') };
};
host.openExternalLink = async url => { external.push(url); };
host.locatePath = async path => { folders.push(path); };
host.selectedFilePath = async path => path;
host.readLocalFile = async path => new Blob(['# ' + path], { type: 'text/plain' });
host.openFile = async path => { opened.push(path); };
saveViewState(sessionId + ':selection', file('Agent.md'));
saveViewState(sessionId + ':visible', true);
saveViewState('file-tree', false);
useLocalAgentStore.setState({ sessionId, runtimeReady: true, profileRead: { phase: 'ready' },
  projection: projectSession(emptySessionState(sessionId)) });
Object.assign(window, { readerWorkbench: { open: (name: string) => requestReader(sessionId, file(name)), openDiff, progressiveSource, saves, copies, longCode, manyCodeLines, opened, folders, external, watching,
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
