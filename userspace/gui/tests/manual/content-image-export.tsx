// Production components; only fixture artifact transport and optional save capture are substituted.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownContent } from '../../src/components/local-agent/BufferedMarkdown';
import { PreviewArtifactsScope } from '../../src/components/local-agent/InteractivePreview';
import { useConversationHost } from '../../src/components/local-agent/ConversationHost';
import { RichContentScope } from '../../src/components/local-agent/RichContentIdentity';
import { ConversationVirtualRow } from '../../src/components/local-agent/ConversationVirtualRow';
import { ConversationVirtualizer } from '../../src/components/local-agent/conversationVirtualizer';
import { ImageReview } from '../../src/components/local-agent/ImageReview';
import { type ContentImage } from '../../src/components/local-agent/contentImage';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/theme/builtinFonts.css';
import '../../src/components/shared/focus.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/richContent.css';

installPaletteDefaults();
const host = useConversationHost();
const capture = new URLSearchParams(location.search).has('capture');
const saved: ContentImage[] = [];
if (capture) host.saveImage = async file => { saved.push(file); window.dispatchEvent(new Event('fixture:image-saved')); };
const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;background:#fff;color:#172b4d;font:18px sans-serif}canvas{display:block}button{font:inherit}</style></head><body>'
  + '<h2>当前状态 / Current state</h2><button id="increase">增加</button> <output id="value">1</output><canvas id="chart" width="480" height="100"></canvas>'
  + '<script>let value=1;const canvas=document.getElementById("chart");function paint(){document.getElementById("value").textContent=String(value);const c=canvas.getContext("2d");c.fillStyle=value===1?"#e43b44":"#1466bb";c.fillRect(0,0,480,100);c.fillStyle="#fff";c.font="32px sans-serif";c.fillText("VALUE "+value,20,62)}document.getElementById("increase").onclick=()=>{value++;paint()};addEventListener("message",e=>{if(e.data==="fixture:increase")document.getElementById("increase").click()});paint();</script></body></html>';
const previousRead = host.readArtifact;
host.readArtifact = async (session, id, signal) => id === 'artifact:export-preview'
  ? new Blob([html], { type: 'text/html' }) : previousRead(session, id, signal);
const artifact = { artifactId: 'artifact:export-preview', label: 'current-state.html', contentMode: 'fixed' as const, contentType: 'text/html' };
const fence = String.fromCharCode(96).repeat(3);
const table = '| 项目 | 状态 | 说明 | 数量 | 中文 | 公式 | 图标 | 最后一列 |\n|---|---|---|---|---|---|---|---|\n'
  + Array.from({ length: 24 }, (_, i) => '| 项目 ' + (i + 1) + ' | 完成 | 保留全部内容和中文排版 | ' + i + ' | 完整导出 | $x^2$ | ✅ | ' + (i === 23 ? '最终单元格 END' : '末列 ' + i) + ' |').join('\n');
const code = fence + 'typescript\n' + Array.from({ length: 45 }, (_, i) => 'const value' + i + ' = "中文代码，第 ' + (i + 1) + ' 行";').join('\n') + '\n' + fence;
const sourceImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="360" height="120" fill="#1466bb"/><text x="20" y="70" fill="white" font-size="28">Original image</text></svg>');
const virtualizer = new ConversationVirtualizer(new Map(), () => {});
function Fixture() {
  const [previewKey, setPreviewKey] = useState(0);
  const [dark, setDark] = useState(false);
  return <><style>{'body{margin:0;background:var(--ac-surface);color:var(--ac-foreground);font:14px/1.5 var(--ac-font-ui)}.export-fixture{max-width:820px;margin:32px auto;padding:20px}.export-fixture>section{margin:28px 0}.export-fixture>header{display:flex;gap:20px}.export-fixture .conversation-code{max-width:100%}'}</style>
    <main className="export-fixture local-agent"><header><h1>图片导出检查</h1>
      <button onClick={() => { document.documentElement.dataset.theme = dark ? 'light' : 'dark'; setDark(!dark); }}>切换主题</button><button id="remount-preview" onClick={() => setPreviewKey(key => key + 1)}>重挂预览</button></header>
      <RichContentScope.Provider value={{ sessionId: 'session:export', rowKey: 'row:export', contentKey: 'fixture' }}>
        <section id="table"><h2>宽长表格</h2><MarkdownContent>{table}</MarkdownContent></section>
        <section id="mermaid"><h2>Mermaid</h2><MarkdownContent>{fence + 'mermaid\nflowchart TD\nA[中文图表] --> B[保存 PNG]\nB --> C[仍可导出 SVG]\n' + fence}</MarkdownContent></section>
        <section id="formula"><h2>公式</h2><MarkdownContent>{'$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$'}</MarkdownContent></section>
        <section id="code"><h2>代码</h2><MarkdownContent>{code}</MarkdownContent></section>
        <section id="image"><h2>原始图片</h2><ImageReview source={sourceImage} alt="original.svg" /></section>
        <section id="preview"><h2>交互预览</h2><ConversationVirtualRow key={previewKey} rowKey="preview" virtualizer={virtualizer} eager>{() => <PreviewArtifactsScope.Provider value={{ sessionId: 'session:export', artifacts: [artifact as never] }}>
          <MarkdownContent>{fence + 'achbit-preview\nartifact://artifact:export-preview\n' + fence}</MarkdownContent>
        </PreviewArtifactsScope.Provider>}</ConversationVirtualRow></section>
      </RichContentScope.Provider>
    </main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  const current = read(); if (current) return current;
  return new Promise((resolve, reject) => {
    const stop = () => { observer.disconnect(); clearTimeout(timer); window.removeEventListener('fixture:image-saved', check); };
    const check = () => { const value = read(); if (value) { stop(); resolve(value); } };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { stop(); reject(new Error('Fixture wait timed out: ' + (document.querySelector('[role=alert]')?.textContent || 'no result'))); }, 30_000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener('fixture:image-saved', check);
  });
}
async function save(selector: string) {
  const button = await until(() => document.querySelector<HTMLButtonElement>(selector + ' button[aria-label="保存为图片"]:not(:disabled)'));
  const before = saved.length;
  button.scrollIntoView({ block: 'center' });
  button.click();
  const file = await until(() => saved.length > before && saved.at(-1));
  const bitmap = await createImageBitmap(file.blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { filename: file.filename, size: file.blob.size, type: file.blob.type, ...dimensions };
}
Object.assign(window, { imageExportFixture: { saved, sourceImage, async run() {
  if (!capture) throw new Error('Use capture mode for automated assertions; ordinary mode uses the actual save dialog.');
  const table = await until(() => document.querySelector<HTMLTableElement>('#table table'));
  const viewport = table.parentElement!;
  viewport.scrollLeft = 200;
  const scroll = viewport.scrollLeft;
  const tableSize = { width: Math.max(table.offsetWidth, table.scrollWidth) * 2, height: Math.max(table.offsetHeight, table.scrollHeight) * 2 };
  const result: Record<string, unknown> = { table: await save('#table') };
  if ((result.table as {width:number}).width !== tableSize.width || (result.table as {height:number}).height !== tableSize.height) throw new Error('Table export was clipped.');
  if (viewport.scrollLeft !== scroll) throw new Error('Export changed live table scroll.');
  result.mermaid = await save('#mermaid'); result.formula = await save('#formula'); result.code = await save('#code');
  result.previewBefore = await save('#preview');
  document.querySelector<HTMLIFrameElement>('#preview iframe')!.contentWindow!.postMessage('fixture:increase', '*');
  result.previewAfter = await save('#preview');
  const before = new Uint8Array(await saved.at(-2)!.blob.arrayBuffer()), after = new Uint8Array(await saved.at(-1)!.blob.arrayBuffer());
  if (before.length === after.length && before.every((value, i) => value === after[i])) throw new Error('Preview exported its original state.');
  return result;
} } });
