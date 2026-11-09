// Local samples exercise the shared image viewer without any resource transport.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageReview } from '../../src/components/local-agent/ImageReview';
import { MermaidContent } from '../../src/components/local-agent/MermaidContent';
import { MarkdownTable } from '../../src/components/local-agent/MarkdownTable';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/theme/builtinFonts.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/richContent.css';

installPaletteDefaults();
const samples = [
  { name: '横向大图', width: 3000, height: 1840 },
  { name: '纵向大图', width: 900, height: 2400 },
  { name: '小图', width: 400, height: 240 },
].map(sample => {
  const { width, height } = sample;
  const textSize = Math.min(width, height) / 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><pattern id="grid" width="${width / 10}" height="${height / 10}" patternUnits="userSpaceOnUse"><path d="M0 ${height / 10}V0H${width / 10}" fill="none" stroke="#cbd5e1" stroke-width="2"/></pattern></defs>
    <rect width="${width}" height="${height}" fill="#eff6ff"/><rect width="${width}" height="${height}" fill="url(#grid)"/>
    <rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#2563eb" stroke-width="16"/>
    <g font-family="sans-serif" font-size="${textSize}" fill="#1e3a8a"><text x="${textSize / 2}" y="${textSize * 1.4}">TOP LEFT</text>
    <text x="${width - textSize / 2}" y="${textSize * 1.4}" text-anchor="end">TOP RIGHT</text>
    <text x="${textSize / 2}" y="${height - textSize / 2}">BOTTOM LEFT</text>
    <text x="${width - textSize / 2}" y="${height - textSize / 2}" text-anchor="end">BOTTOM RIGHT</text>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle">${width} × ${height}</text></g></svg>`;
  return { ...sample, source: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
});
function Preview() {
  const [index, setIndex] = useState(0);
  const sample = samples[index];
  return <>
    <style>{`body{margin:0;color:var(--ac-foreground);background:var(--ac-surface);font:var(--ac-font-body)/1.5 var(--ac-font-ui)}main.fixture{display:block;max-width:800px;height:auto;margin:40px auto;padding:24px}.fixture select{font:inherit}.fixture>p{margin:24px 0}.fixture>.conversation-image-review__open{max-width:360px;max-height:480px}`}</style>
    <main className="local-agent fixture">
      <label>图片样例 <select value={index} onChange={event => setIndex(Number(event.target.value))}>{samples.map((item, i) => <option key={item.name} value={i}>{item.name}</option>)}</select></label>
      <p>图片、Mermaid 和表格应使用相同的弹窗边界与留白。图片和图表默认完整适配，调整窗口后仍完整可见；放大后可恢复适配。</p>
      <ImageReview source={sample.source} alt={`${sample.name} · ${sample.width} × ${sample.height}`} />
      <section className="conversation-markdown">
        <h2>纵向流程图</h2>
        <MermaidContent source={'flowchart TD\n' + Array.from({ length: 12 }, (_, i) => `N${i}[步骤 ${i + 1}] --> N${i + 1}[步骤 ${i + 2}]`).join('\n')} />
        <h2>宽表格</h2>
        <MarkdownTable>
          <thead><tr>{['项目', '当前状态', '说明', '下一步', '结果'].map(title => <th key={title}>{title}</th>)}</tr></thead>
          <tbody>{Array.from({ length: 8 }, (_, i) => <tr key={i}><td>项目 {i + 1}</td><td>已检查</td><td>保留表格可读性与独立滚动区域</td><td>调整窗口并检查缩放</td><td>待确认</td></tr>)}</tbody>
        </MarkdownTable>
      </section>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
