// Local samples exercise the shared image viewer without any resource transport.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageReview } from '../../src/components/local-agent/ImageReview';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/deepcode-gui/styles/deepcodeDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/theme/builtinFonts.css';
import '../../src/components/local-agent/localAgentPanel.css';

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
    <style>{`body{margin:0;color:var(--dc-foreground);background:var(--dc-surface);font:var(--dc-font-body)/1.5 var(--dc-font-ui)}main.fixture{display:block;max-width:800px;height:auto;margin:40px auto;padding:24px}.fixture select{font:inherit}.fixture>p{margin:24px 0}.fixture>.conversation-image-review__open{max-width:360px;max-height:480px}`}</style>
    <main className="local-agent fixture">
      <label>图片样例 <select value={index} onChange={event => setIndex(Number(event.target.value))}>{samples.map((item, i) => <option key={item.name} value={i}>{item.name}</option>)}</select></label>
      <p>点击图片检查全窗口适配。放大、缩小和恢复适配只修改本地查看比例，四角文字用于确认图片是否完整可见。</p>
      <ImageReview source={sample.source} alt={`${sample.name} · ${sample.width} × ${sample.height}`} />
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
