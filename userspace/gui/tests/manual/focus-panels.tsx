import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ModalDialog } from '../../src/ui-components';
import { ResourceTreeMenu } from '../../src/components/local-agent/ResourceTreeMenu';
import { MermaidContent } from '../../src/components/local-agent/MermaidContent';
import { ConversationOutputs } from '../../src/achbit-gui/layout/AchbitTaskPanel';
import SidebarMenu from '../../src/achbit-gui/layout/SidebarMenu';
import { returnFocusTo, useInteractionFocus } from '../../src/components/shared/interactionFocus';
import ThemePicker from '../../src/components/settings-center/ThemePicker';
import { InteractionPreview } from './InteractionPreview';
import { installPaletteDefaults } from '../../src/theme/palette';
import type { ArtifactProjection } from '@achbit/protocol';
import '../../src/theme/builtinFonts.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/achbit-gui/achbitGui.css';
import '../../src/achbit-gui/styles/achbitShell.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/documentPreview.css';
import '../../src/components/settings-center/appearanceConfiguration.css';
import '../../src/components/shared/focus.css';
installPaletteDefaults();
const artifacts = Array.from({ length: 4 }, (_, index) => ({ artifactId: `artifact:fixture:${index}`, sessionId: 'session:focus',
  label: `result-${index}.txt`, contentType: 'text/plain', contentMode: 'fixed', uri: `artifact://artifact:fixture:${index}`,
  createdAt: '2026-11-15T00:00:00Z' })) as ArtifactProjection[];
function Preview() {
  const interaction = useInteractionFocus();
  const [dialog, setDialog] = useState<'buttons' | 'editor' | null>(null);
  const [tree, setTree] = useState<{ x: number; y: number } | null>(null);
  const [outputs, setOutputs] = useState(false);
  const [sidebarMenu, setSidebarMenu] = useState<{ x: number; y: number } | null>(null);
  const [theme, setTheme] = useState('original');
  const treeTrigger = useRef<HTMLButtonElement>(null);
  Object.assign(window, { __focusPanels: { resetOutputs: () => setOutputs(false) } });
  return <>
    <style>{`#root{height:100%;overflow:auto;padding:24px}.focus-fixture.local-agent{display:block;height:auto;overflow:visible;width:min(900px,100%);margin:auto}.focus-fixture>section{margin:16px 0;padding:16px;border:1px solid var(--ac-border);border-radius:10px}.focus-fixture h2{font-size:15px}.focus-fixture .toolbar{display:flex;gap:12px;align-items:center}.focus-fixture input{padding:8px;background:var(--ac-surface-raised);color:var(--ac-foreground);border:1px solid var(--ac-border);border-radius:6px}.fixture-modal{padding:24px;min-width:280px}.fixture-modal>div{display:flex;gap:12px;margin-top:16px}`}</style>
    <main className="local-agent focus-fixture"><h1>同类面板焦点检查</h1><p>真实组件与正式输入方式策略。此页不连接 Host，不执行任何文件操作。</p>
      <section><h2>原生模态层</h2><div className="toolbar"><Button id="buttons-dialog" onClick={() => setDialog('buttons')}>按钮弹窗</Button><Button id="editor-dialog" onClick={() => setDialog('editor')}>编辑弹窗</Button><input id="outside-editor" aria-label="外部编辑框" placeholder="先输入，再用鼠标打开面板" /></div></section>
      <section><h2>文件右键菜单</h2><Button id="tree-trigger" ref={treeTrigger} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setTree({ x: rect.left, y: rect.bottom + 8 }); }}>文件操作</Button></section>
      <section><h2>侧栏菜单</h2><Button id="sidebar-menu-trigger" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setSidebarMenu(sidebarMenu ? null : { x: rect.left, y: rect.bottom + 8 }); }}>侧栏操作</Button></section>
      <section id="outputs"><ConversationOutputs artifacts={artifacts} language="zh-CN" expanded={outputs} onExpandedChange={setOutputs} onOpen={async () => {}} /></section>
      <section><h2>主题选择</h2><ThemePicker label="主题" mode="light" accent="blue" choices={[{ id: 'original', name: '原色', colors: {} }, { id: 'other', name: '另一个主题', colors: {} }]} selected={theme} disabled={false} onSelect={setTheme} /></section>
      <section id="diagram"><h2>图表操作菜单</h2><MermaidContent source={'flowchart LR\n A[Input] --> B[Output]'} /></section>
    </main>
    {dialog && <ModalDialog className="fixture-modal" aria-label="焦点检查弹窗" onClose={() => setDialog(null)}>
      <h2>{dialog === 'editor' ? '编辑内容' : '确认操作'}</h2>
      {dialog === 'editor' && <input id="modal-editor" aria-label="弹窗编辑框" autoFocus defaultValue="保留编辑焦点" />}
      <div><Button id="modal-cancel" autoFocus={dialog === 'buttons'} onClick={() => setDialog(null)}>取消</Button><Button onClick={() => setDialog(null)}>确认</Button></div>
    </ModalDialog>}
    {sidebarMenu && <SidebarMenu {...sidebarMenu} className="achbit-gui-project-create-menu" onClose={() => setSidebarMenu(null)}>
      <button type="button" role="menuitem" onClick={() => setSidebarMenu(null)}>查看</button><button type="button" role="menuitem" onClick={() => setSidebarMenu(null)}>关闭</button>
    </SidebarMenu>}
    {tree && <ResourceTreeMenu entry={{ name: 'sample.txt', kind: 'file', resource: { workspaceId: 'workspace:fixture', logicalPath: 'sample.txt' } }}
      sessionId="session:focus" language="zh-CN" {...tree} onOpen={() => {}}
      onClose={closing => { setTree(null); returnFocusTo(treeTrigger.current, interaction, closing); }} onError={() => {}} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<InteractionPreview><Preview /></InteractionPreview>);
