export interface UiSourceLocation { file: string; symbol: string; line: number }
export type UiSourceMap = Record<string, UiSourceLocation[]>;

export function createOwnershipInspector(sources: UiSourceMap) {
  // This is a document identity; native surfaceId/framePath remain the outer authority.
  const documentId = `document:${crypto.randomUUID()}`;
  const sourceFor = (id: string) => sources[id] ?? (id.startsWith('region.') ? sources['region.*'] : undefined) ?? [];
  const identity = (element: Element | null) => {
    const owner = element?.closest<HTMLElement>('[data-ui-owner][data-ui-instance]');
    if (!owner) return { coverage: 'uncovered' as const, documentId };
    const renderer = element?.closest<HTMLElement>('[data-ui-plugin]');
    const pluginInternal = element !== owner && owner.dataset.uiPart === 'renderer';
    return { coverage: element === owner ? 'declared' as const : 'inherited' as const,
      documentId, ownerId: owner.dataset.uiOwner!, instanceId: owner.dataset.uiInstance!,
      partId: owner.dataset.uiPart ?? null, source: sourceFor(owner.dataset.uiOwner!),
      implementationCoverage: pluginInternal ? 'plugin-internal-unmapped' as const : 'owner-source' as const,
      renderer: renderer ? { pluginId: renderer.dataset.uiPlugin!, generation: renderer.dataset.uiGeneration ?? null } : null,
    };
  };
  const boundaries = (instanceId: string) => {
    const roots = [...document.querySelectorAll<HTMLElement>(`[data-ui-instance="${CSS.escape(instanceId)}"]`)];
    return roots.map(root => {
      // Existing display:contents regions have no own box. Publish actual child boxes.
      const boxes = (element: Element): DOMRect[] => getComputedStyle(element).display === 'contents'
        ? [...element.children].flatMap(boxes) : [element.getBoundingClientRect()];
      return { ...identity(root), parent: identity(root.parentElement),
        bounds: boxes(root).filter(rect => rect.width > 0 && rect.height > 0)
          .map(({ x, y, width, height }) => ({ x, y, width, height })),
      };
    });
  };
  let enabled = false;
  let target: Element | null = null;
  let pointer: { x: number; y: number } | null = null;
  let overlay: HTMLDivElement | null = null;
  const hide = () => {
    if (!overlay) return;
    overlay.hidden = true;
    if (overlay.matches(':popover-open')) overlay.hidePopover();
  };
  const paint = () => {
    if (!overlay) return;
    const owner = target?.closest<HTMLElement>('[data-ui-owner][data-ui-instance]');
    if (!owner?.isConnected) { hide(); return; }
    const rect = (getComputedStyle(owner).display === 'contents' ? target! : owner).getBoundingClientRect();
    if (!rect.width || !rect.height) { hide(); return; }
    const info = identity(target);
    const sources = info.source ?? [];
    overlay.hidden = false;
    const label = overlay.firstElementChild as HTMLElement;
    const outline = overlay.children[1] as HTMLElement;
    Object.assign(outline.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const actionLine = owner.dataset.uiAction ? `\nactionId ${owner.dataset.uiAction}` : '';
    label.textContent = 'ownerId' in info
      ? `${info.ownerId} / ${info.partId ?? '—'} · ${info.instanceId}${actionLine}\n${sources.length === 1
        ? `${sources[0].file}:${sources[0].line} · ${sources[0].symbol}`
        : sources.length ? `source: ambiguous (${sources.length} declarations)` : 'source: uncovered'}` : 'uncovered';
    // The label belongs to the viewport, not to the inspected icon/divider's box.
    const width = Math.max(0, Math.min(420, window.innerWidth - 16));
    Object.assign(label.style, { width: `${width}px`, maxHeight: `${Math.max(0, window.innerHeight - 16)}px` });
    if (!overlay.matches(':popover-open')) overlay.showPopover();
    const height = label.getBoundingClientRect().height;
    const below = rect.y + rect.height + 6;
    const above = rect.y - height - 6;
    Object.assign(label.style, {
      left: `${Math.max(8, Math.min(rect.x, window.innerWidth - width - 8))}px`,
      top: `${Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : above,
        window.innerHeight - height - 8))}px`,
    });
  };
  const move = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    target = event.target instanceof Element ? event.target : null; paint();
  };
  const focus = (event: FocusEvent) => {
    pointer = null; target = event.target instanceof Element ? event.target : null; paint();
  };
  const leave = (event: PointerEvent) => { if (!event.relatedTarget) { pointer = null; target = null; hide(); } };
  const blur = () => { pointer = null; target = null; hide(); };
  const reposition = () => {
    if (pointer) target = document.elementFromPoint(pointer.x, pointer.y);
    paint();
  };
  const layerChanged = (event: Event) => {
    if (!(event.target instanceof Element) || event.target === overlay || !event.target.matches('dialog, [popover]')) return;
    // A later modal/popover sits above an already open diagnostic. Re-enter after it,
    // and inspect the new hit target without changing business focus or close behavior.
    if (pointer) target = document.elementFromPoint(pointer.x, pointer.y);
    hide(); paint();
  };
  const mutations = new MutationObserver(() => { if (target && !target.isConnected) hide(); });
  const setOverlay = (value: boolean) => {
    if (typeof value !== 'boolean') throw Error('debug_overlay_boolean_required');
    if (value === enabled) return { enabled, documentId };
    enabled = value;
    if (enabled) {
      overlay = document.createElement('div');
      overlay.dataset.achbitDiagnostic = 'ownership';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('popover', 'manual');
      overlay.hidden = true;
      overlay.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;width:100vw;height:100vh;max-width:none;max-height:none;overflow:hidden;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:0;background:transparent;';
      const label = document.createElement('span');
      label.style.cssText = 'position:absolute;padding:4px 6px;box-sizing:border-box;overflow:hidden;background:#172033;color:#fff;font:11px/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;z-index:1;';
      const outline = document.createElement('div');
      outline.style.cssText = 'position:absolute;box-sizing:border-box;border:1px solid #3b82f6;pointer-events:none;';
      const style = document.createElement('style');
      style.textContent = '[data-achbit-diagnostic="ownership"]::backdrop{background:transparent;pointer-events:none}';
      overlay.append(label, outline, style); document.body.append(overlay);
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerout', leave, true);
      document.addEventListener('focusin', focus, true);
      document.addEventListener('toggle', layerChanged, true);
      document.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition);
      window.addEventListener('blur', blur);
      mutations.observe(document.body, { childList: true, subtree: true });
    } else {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('toggle', layerChanged, true);
      document.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition);
      window.removeEventListener('blur', blur);
      mutations.disconnect(); hide(); overlay?.remove(); overlay = null; target = null; pointer = null;
    }
    return { enabled, documentId };
  };
  return { identity, setOverlay, status: () => ({ enabled, documentId }),
    component: (id: string, source: { ownerId?: string }) => {
      const roots = boundaries(id);
      return { documentId, source: source.ownerId ? sourceFor(source.ownerId) : [], boundaries: roots,
        coverage: roots.length ? 'declared-boundaries' : 'no-dom-boundary' };
    },
  };
}
