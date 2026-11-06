// Isolated review fixture: actual registered controls, no backend or Session writes.
import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, CloseButton, IconButton, ModalDialog, NativeSelect, PanelHeader, ToggleSwitch, UI_COMPONENTS, UI_REGION_SLOTS } from '../../src/ui-components';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();

function Catalog() {
  const [modal, setModal] = useState(false);
  const [panel, setPanel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const record = (event: string) => setEvents(previous => [...previous, event]);
  const submit = (event: FormEvent) => { event.preventDefault(); record('submit'); };
  const close = () => { setModal(false); record('modal-close'); };
  return <main>
    <PanelHeader><h1>Achbit · 共享组件</h1><Button onClick={() => {
      const next = !dark; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light';
    }}>{dark ? '浅色' : '深色'}</Button></PanelHeader>
    <p>注册目录 → 复用基础控件 → 参数或组合扩展。此页只验证前端，不调用模型。</p>
    <section>
      <PanelHeader><h2>按钮与状态</h2><ToggleSwitch aria-label="禁用控件" checked={busy} onChange={event => setBusy(event.target.checked)} /></PanelHeader>
      <form onSubmit={submit}>
        <Button disabled={busy} onClick={() => record('ghost')}>普通操作</Button>
        <Button disabled={busy} variant="secondary" onClick={() => record('secondary')}>次要操作</Button>
        <Button disabled={busy} variant="primary" type="submit">提交表单</Button>
        <Button disabled={busy} variant="danger" onClick={() => record('danger')}>危险操作</Button>
        <IconButton disabled={busy} icon="plus" aria-label="新增" onClick={() => record('new')} />
        <CloseButton disabled={busy} aria-label="紧凑关闭" size="compact" onClick={() => record('compact-close')} />
        <CloseButton disabled={busy} aria-label="标准关闭" onClick={() => record('standard-close')} />
        <CloseButton disabled={busy} aria-label="大号关闭" size="large" onClick={() => record('large-close')} />
      </form>
    </section>
    <section>
      <PanelHeader><h2>面板与原有弹层</h2><Button onClick={() => setPanel(true)}>重新展开</Button></PanelHeader>
      {panel && <div className="sample-panel">
        <PanelHeader><strong>展开面板</strong><CloseButton aria-label="关闭面板" onClick={() => { setPanel(false); record('panel-close'); }} /></PanelHeader>
        <p>标题和右侧操作复用同一结构，关闭仍由调用方决定。</p>
      </div>}
      <div className="row"><Button id="open-dialog" variant="secondary" onClick={() => setModal(true)}>打开弹窗</Button>
        <NativeSelect aria-label="尺寸示例"><option>紧凑</option><option>标准</option><option>大号</option></NativeSelect></div>
    </section>
    <section><h2>注册目录</h2><ul>{Object.entries(UI_COMPONENTS).map(([name, entry]) => <li key={name}>
      <code>{name}</code>{'base' in entry ? ` ← ${entry.base}` : ''}
    </li>)}</ul><small>{Object.keys(UI_REGION_SLOTS).length} 个既有可替换区域；没有新增插件接口。</small></section>
    <section><h2>操作记录</h2><output id="events" aria-live="polite">{events.join(' · ') || '尚无操作'}</output></section>
    {modal && <ModalDialog className="catalog-overlay" aria-labelledby="dialog-title" onClose={close} busy={busy}>
      <div className="modal-card"><PanelHeader><h2 id="dialog-title">共享弹窗</h2><CloseButton aria-label="关闭弹窗" disabled={busy} onClick={close} /></PanelHeader>
        <label>测试输入 <input aria-label="测试输入" /></label><p>Escape 与关闭按钮沿用现有焦点恢复机制。</p>
        <Button onClick={close} disabled={busy}>返回</Button>
      </div>
    </ModalDialog>}
  </main>;
}

const style = document.createElement('style');
style.textContent = `*{box-sizing:border-box}body{margin:0;background:var(--ac-background);color:var(--ac-foreground);font:14px/1.6 system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:24px}h1{font-size:20px}h2{font-size:15px;margin:0}p,small{color:var(--ac-muted)}section{margin:20px 0;padding:16px;border:1px solid var(--ac-border);border-radius:var(--ac-radius-inner);background:var(--ac-surface)}form,.row{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px}.sample-panel{margin:12px 0;padding:12px;background:var(--ac-surface-subtle);border-radius:var(--ac-radius-control)}.catalog-overlay{display:grid;place-items:center;background:color-mix(in srgb,var(--ac-shadow-color) 30%,transparent)}.modal-card{width:min(420px,calc(100vw - 32px));padding:18px;border-radius:var(--ac-radius-outer);background:var(--ac-surface-raised)}.modal-card label{display:block;margin-top:20px}.modal-card input{max-width:100%}output{overflow-wrap:anywhere}ul{padding-left:20px}@media(max-width:480px){main{padding:12px}section{padding:12px}}`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<Catalog />);
