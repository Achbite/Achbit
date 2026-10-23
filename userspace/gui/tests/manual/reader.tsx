// Real Reader and CodeMirror lifecycle; only resource transport is simulated.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResourcePreview, useResourcePreview } from '../../src/components/local-agent/ResourcePreview';
import { useConversationHost } from '../../src/components/local-agent/ConversationHost';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/local-agent/localAgentPanel.css';

installPaletteDefaults();
const content = Array.from({ length: 24000 }, (_, i) => `int value_${i} = ${i}; // Reader lifecycle line ${i}\n`).join('');
const reads = new Map<string, number>(), watches = new Map<string, () => void>();
let serial = 0, aborted = 0;
const host = useConversationHost();
host.resources = { ...host.resources,
  async watchResources(_session, resources, signal, changed) {
    const key = resources[0].logicalPath;
    const notify = () => changed([0]);
    watches.set(key, notify);
    // ready is asynchronous, as it is on the real SSE transport.
    await Promise.resolve();
    if (!signal.aborted) notify();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      aborted++; watches.delete(key); resolve();
    }, { once: true }));
  },
  async readResourceReference(_session, resource) {
    const key = resource.logicalPath;
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return { content: key === 'large.cpp' ? content + `// revision ${serial}\n` : 'Small second file\n',
      startLine: 1, truncated: false } as Awaited<ReturnType<typeof host.resources.readResourceReference>>;
  },
};

function Fixture() {
  const preview = useResourcePreview('session:reader-lifecycle');
  const [receipt, setReceipt] = useState('尚未运行');
  const target = (logicalPath: string) => ({ kind: 'workspace' as const, workspaceId: 'workspace:fixture', logicalPath });
  const firstEditor = React.useRef<Element | null>(null);
  const inspect = () => {
    const editors = [...document.querySelectorAll('.cm-editor')];
    firstEditor.current ??= editors[0] ?? null;
    setReceipt(JSON.stringify({ bytes: new Blob([content]).size, reads: Object.fromEntries(reads),
      watches: watches.size, aborted, editors: editors.length,
      originalEditorRetained: firstEditor.current !== null && editors.includes(firstEditor.current) }, null, 2));
  };
  return <>
    <style>{`body{margin:0;font:14px system-ui}header{padding:12px;display:flex;gap:8px}pre{margin:0;padding:12px;white-space:pre-wrap}main{height:65vh;display:flex}.local-agent__reader{width:100%;height:100%}.reader-workspace{height:100%}.reader-tree{display:none}`}</style>
    <header>
      <button onClick={() => preview.openTarget(target('large.cpp'))}>打开大文件</button>
      <button onClick={() => preview.openTarget(target('small.txt'))}>打开第二文件</button>
      <button onClick={preview.toggle}>收起或展开</button>
      <button onClick={() => { serial++; watches.get('large.cpp')?.(); }}>通知内容变更</button>
      <button onClick={inspect}>读取检查结果</button>
    </header>
    <pre aria-label="生命周期结果">{receipt}</pre>
    <main><ResourcePreview language="zh-CN" preview={{ ...preview, treeVisible: false }} /></main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
