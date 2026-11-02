/** Keep the SVG's own coordinate system for viewing and export. A responsive 100% width is not an intrinsic image size. */
export async function renderMermaidImage(id: string, source: string, theme: string) {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    htmlLabels: false, theme: theme === 'dark' ? 'dark' : 'neutral',
    flowchart: { nodeSpacing: 42, rankSpacing: 33, padding: 13 } });
  const rendered = await mermaid.render(id, source);
  // Mermaid emits an HTML fragment, including HTML void elements inside foreignObject.
  // Parse it the way the transcript does before serializing it as standalone XML.
  const template = document.createElement('template');
  template.innerHTML = rendered.svg;
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) throw new Error('Mermaid did not return an SVG diagram.');
  const box = svg.viewBox.baseVal;
  const hasViewBox = box.width > 0 && box.height > 0;
  if (hasViewBox) {
    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    svg.style.removeProperty('max-width');
  }
  let entryX = 0.5;
  if (rendered.diagramType.startsWith('flowchart')) {
    const dark = theme === 'dark';
    const ink = dark ? '#9fc8ff' : '#1466bb';
    const surface = dark ? '#202f43' : '#e2edfa';
    const border = dark ? '#405267' : '#c3d2e3';
    const paper = dark ? '#1e1f22' : '#fff';
    const style = document.createElementNS(svg.namespaceURI, 'style');
    // Only style ordinary nodes. Mermaid keeps explicit classDef and inline styles.
    style.textContent = [
      '#' + id + ' .node.default > rect.label-container { rx: 10px; ry: 10px; fill: ' + surface + '; stroke: ' + border + '; }',
      '#' + id + ' .node.default > polygon.label-container { fill: ' + paper + '; stroke: ' + ink + '; stroke-dasharray: 3 3; }',
      '#' + id + ' .node.default .nodeLabel, #' + id + ' .node.default .nodeLabel p, #' + id + ' .node.default text { color: ' + ink + '; fill: ' + ink + '; }',
      '#' + id + ' .edgeLabel .background { fill: ' + paper + '; stroke: ' + ink + '; stroke-width: .85px; opacity: 1; }',
      '#' + id + ' .edgeLabel text { fill: ' + ink + '; }',
    ].join('\n');
    svg.append(style);
    for (const rect of svg.querySelectorAll<SVGRectElement>('.edgeLabel rect.background[width]')) {
      rect.setAttribute('rx', '10');
      rect.setAttribute('x', String(rect.x.baseVal.value - 4));
      rect.setAttribute('width', String(rect.width.baseVal.value + 8));
    }
    const first = svg.querySelector<SVGGElement>('g.node');
    const x = first?.transform.baseVal.consolidate()?.matrix.e;
    if (x !== undefined && hasViewBox) entryX = Math.max(0, Math.min(1, (x - box.x) / box.width));
  }
  return { svg: new XMLSerializer().serializeToString(svg), title: svg.querySelector(':scope > title')?.textContent,
    size: hasViewBox ? { width: box.width, height: box.height, entryX } : undefined };
}
