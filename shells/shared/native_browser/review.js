(function startReview({ labels, annotation, reviewId }) {
  window.__achbitReview?.dispose();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { color-scheme:light; }
    * { box-sizing:border-box; }
    .box { position:fixed; border:1.5px solid #588870; background:#608a7408; pointer-events:none; border-radius:3px; }
    .label { position:absolute; left:-8px; top:-10px; background:#fff; color:#547861; border:1px solid #9fb9a9; border-radius:12px; padding:1px 6px; font:11px/1.4 system-ui; }
    .editor { position:fixed; pointer-events:auto; width:min(300px,calc(100vw - 16px)); max-height:calc(100vh - 16px); overflow:auto; padding:12px; border:1px solid #dce2e6; border-radius:10px; background:#fff; color:#29313a; box-shadow:0 8px 28px #28352b1c; font:12px/1.5 system-ui; scrollbar-width:thin; scrollbar-color:#89929b55 transparent; }
    .heading { font-weight:600; margin-bottom:9px; }
    button { padding:6px 10px; border:1px solid #e1e5e9; border-radius:7px; font:inherit; background:#fff; color:#29313a; cursor:pointer; }
    button[type=submit] { font-weight:600; border-color:#c4cbd2; }
    button:hover { border-color:#aeb8c3; box-shadow:0 1px 5px #26313d12; }
    button:active { box-shadow:inset 0 1px 4px #26313d22; }
    button:focus-visible, textarea:focus-visible { outline:2px solid #8b96a2; outline-offset:2px; }
    textarea { width:100%; height:85px; resize:vertical; padding:7px; font:inherit; color:#29313a; background:#fff; border:1px solid #dce2e6; border-radius:7px; }
    .actions { margin-top:8px; display:flex; justify-content:flex-end; gap:7px; }
    .hint { position:fixed; bottom:0; left:0; right:0; padding:5px 10px; background:#f8faf9e8; color:#7c8c83; font:10px/1.4 system-ui; }
    [hidden] { display:none !important; }
  </style>
  <div class="box" hidden><span class="label">1</span></div>
  <form class="editor" role="dialog" aria-label="${labels.annotation}" hidden>
    <div class="heading">${labels.annotation}</div>
    <textarea required aria-label="${labels.comment}" placeholder="${labels.placeholder}"></textarea>
    <div class="actions"><button type="button" data-cancel>${labels.cancel}</button><button type="submit">${labels.save}</button></div>
  </form><div class="hint"></div>`;
  document.documentElement.append(host);
  const box = root.querySelector('.box'), editor = root.querySelector('.editor'), input = root.querySelector('textarea');
  const hint = root.querySelector('.hint');
  const events = new AbortController();
  let selected = null, origin = null, pending = null, pressTimer = null, dragging = false, editingId = null, pointerId = null;
  const state = { reviewId, active: true, pending: null, dispose, acknowledge };
  window.__achbitReview = state;
  function clearPress() { clearTimeout(pressTimer); pressTimer = null; }
  function dispose(reason) {
    endGesture(); events.abort(); host.remove(); state.active = false;
    state.exitReason = reason === 'escape' ? 'escape' : null;
  }
  function updateHint() { hint.textContent = labels.hint; }
  function endGesture() {
    clearPress(); origin = null; dragging = false;
    if (pointerId !== null && shield.hasPointerCapture(pointerId)) shield.releasePointerCapture(pointerId);
    pointerId = null;
  }
  function cancel() { endGesture(); editor.hidden = true; selected = null; box.hidden = true; input.value = ''; editingId = null; }
  function acknowledge(id) {
    if (pending?.id !== id) return;
    pending = null; state.pending = null; cancel();
  }
  function paint(rect) {
    box.hidden = false;
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function selector(element) {
    const parts = [];
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.localName;
      const siblings = [...(node.parentElement?.children ?? [])].filter(other => other.localName === node.localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  function elementTarget(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    return { mode: 'element', rect: { x, y, width: Math.max(0, Math.min(innerWidth, rect.right) - x), height: Math.max(0, Math.min(innerHeight, rect.bottom) - y) }, selector: selector(element),
      text: (element.innerText ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 1600), tag: element.localName };
  }
  function targetAt(x, y) {
    host.style.visibility = 'hidden';
    try { return elementTarget(document.elementFromPoint(x, y)); }
    finally { host.style.visibility = ''; }
  }
  function region(x, y) {
    const endX = Math.max(0, Math.min(innerWidth, x)), endY = Math.max(0, Math.min(innerHeight, y));
    return { mode: 'region', rect: { x: Math.min(origin.x, endX), y: Math.min(origin.y, endY), width: Math.abs(endX - origin.x), height: Math.abs(endY - origin.y) }, selector: null, text: '', tag: null };
  }
  function positionEditor() {
    if (!selected || editor.hidden) return;
    const r = selected.rect, w = editor.offsetWidth, h = editor.offsetHeight, margin = 8, gap = 12;
    const clamp = (v, max) => Math.max(margin, Math.min(v, Math.max(margin, max)));
    const x = clamp(r.x + r.width - w, innerWidth - w - margin), y = clamp(r.y, innerHeight - h - margin);
    const candidates = [{ x, y: r.y + r.height + gap }, { x, y: r.y - h - gap }, { x: r.x + r.width + gap, y }, { x: r.x - w - gap, y }];
    const overlap = p => Math.max(0, Math.min(p.x+w,r.x+r.width)-Math.max(p.x,r.x)) * Math.max(0,Math.min(p.y+h,r.y+r.height)-Math.max(p.y,r.y));
    const chosen = candidates.find(p => p.x >= margin && p.y >= margin && p.x+w <= innerWidth-margin && p.y+h <= innerHeight-margin)
      ?? candidates.map(p => ({ x: clamp(p.x,innerWidth-w-margin), y: clamp(p.y,innerHeight-h-margin) })).sort((a,b) => overlap(a)-overlap(b))[0];
    Object.assign(editor.style, { left: `${chosen.x}px`, top: `${chosen.y}px` });
  }
  function openEditor() {
    if (!selected || selected.rect.width < 2 || selected.rect.height < 2) return;
    editor.hidden = false; positionEditor(); input.focus();
  }
  const shield = document.createElement('div');
  shield.style.cssText = 'position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none;user-select:none';
  root.prepend(shield);
  shield.addEventListener('pointermove', event => {
    if (!editor.hidden || pending) return;
    if (origin && dragging) selected = region(event.clientX,event.clientY);
    else {
      if (origin && Math.hypot(event.clientX-origin.x,event.clientY-origin.y)>7) clearPress();
      selected = targetAt(event.clientX,event.clientY);
    }
    if (selected) paint(selected.rect); else box.hidden = true;
  });
  shield.addEventListener('pointerdown', event => {
    if (event.button !== 0 || origin || !editor.hidden || pending) return;
    event.preventDefault(); event.stopPropagation(); document.getSelection()?.removeAllRanges();
    pointerId = event.pointerId; shield.setPointerCapture(pointerId); origin = { x: event.clientX, y: event.clientY }; dragging = false;
    selected = targetAt(event.clientX,event.clientY);
    clearPress(); pressTimer = setTimeout(() => { if (origin) { dragging = true; selected = region(origin.x, origin.y); paint(selected.rect); } },420);
  });
  shield.addEventListener('pointerup', event => {
    clearPress(); if (!shield.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    if (origin && dragging) selected = region(event.clientX,event.clientY);
    endGesture();
    if (selected) { paint(selected.rect); openEditor(); }
  });
  shield.addEventListener('pointercancel', cancel);
  shield.addEventListener('lostpointercapture', () => { if (origin) cancel(); });
  shield.addEventListener('wheel', event => event.preventDefault(), { passive: false });
  root.querySelector('[data-cancel]').addEventListener('click', cancel);
  editor.addEventListener('submit', event => {
    event.preventDefault(); if (!selected || !input.value.trim()) return;
    pending = { id: editingId ?? crypto.randomUUID(), ...selected, url: location.href, title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, comment: input.value.trim() };
    state.pending = pending; editor.hidden = true;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dispose('escape'); }
    else if (!event.composedPath().includes(host)) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true, signal: events.signal });
  window.addEventListener('resize', () => {
    endGesture();
    if (selected?.selector) {
      selected = elementTarget(document.querySelector(selected.selector));
      if (selected) { paint(selected.rect); positionEditor(); return; }
    }
    // Toolbar/layout changes can resize a native child view immediately after
    // entering annotation mode. Re-select geometry, never end the interaction.
    selected = null; box.hidden = true; editor.hidden = true;
    updateHint();
  }, { signal: events.signal });
  window.addEventListener('pagehide', dispose, { signal: events.signal });
  updateHint();
  if (annotation) {
    try {
      if (annotation.url !== location.href) throw new Error(labels.pageChanged);
      if (annotation.mode === 'element') selected = elementTarget(document.querySelector(annotation.selector));
      else {
        const v = annotation.viewport;
        if (v.width !== innerWidth || v.height !== innerHeight || v.scrollX !== scrollX || v.scrollY !== scrollY)
          throw new Error(labels.viewportChanged);
        selected = { mode: 'region', rect: annotation.rect, selector: null, text: annotation.text, tag: null };
      }
      if (!selected || selected.rect.width < 2 || selected.rect.height < 2) throw new Error(labels.notVisible);
      editingId = annotation.id; input.value = annotation.comment; paint(selected.rect); openEditor();
    } catch (error) { dispose(); throw error; }
  }
  return { active: true };
})
