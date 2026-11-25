import { firstReadingAnchor, type ConversationAnchors } from '../components/local-agent/conversationAnchors';

// Only diagnostic metadata crosses this boundary. Drafts, provider text and error messages do not.
const observationFields = [
  'sessionId', 'commandId', 'submissionId', 'messageId', 'instanceId', 'revision', 'replyRevision',
  'source', 'reason', 'phase', 'rowKey', 'anchorKey', 'offset', 'selectedIndex', 'visibleFirst', 'visibleLast',
  'scrollTop', 'distanceToBottom', 'viewportHeight', 'viewportWidth', 'followingTail', 'wheelCount',
  'trustedWheelCount', 'wheelDeltaY', 'direction', 'inViewport', 'documentVisible', 'sequence',
] as const;

export type ObservationFields = Partial<Record<typeof observationFields[number], string | number | boolean | null | undefined>>;
export type Observe = (componentId: string, event: string, fields: ObservationFields) => void;

export function copyObservationFields(fields: ObservationFields) {
  const result: ObservationFields = {};
  for (const key of observationFields) {
    const value = fields[key];
    if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

/** At rest, sample the actual scroll container and the displayed ticks. Wheel events only increment counters. */
export function observeReading(sessionId: string, body: HTMLElement, rail: HTMLElement | null, anchors: ConversationAnchors, observe: Observe) {
  let timer: number | undefined;
  let wheelCount = 0;
  let trustedWheelCount = 0;
  let wheelDeltaY = 0;
  let scrolled = false;
  const snapshot = (source: string) => {
    const top = body.getBoundingClientRect().top;
    const anchor = firstReadingAnchor(anchors.read(body).nodes, top);
    const bounds = rail?.getBoundingClientRect();
    const visible = bounds && [...rail!.querySelectorAll<HTMLElement>('[data-navigation-index]')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0;
    });
    const selected = rail?.querySelector<HTMLElement>('[aria-current="location"]');
    observe('conversation.navigation', 'reading.viewport', { sessionId, source,
      anchorKey: anchor?.dataset.conversationAnchor, offset: anchor && anchor.getBoundingClientRect().top - top,
      selectedIndex: selected ? Number(selected.dataset.navigationIndex) : undefined,
      visibleFirst: visible?.length ? Number(visible[0]!.dataset.navigationIndex) : undefined,
      visibleLast: visible?.length ? Number(visible.at(-1)!.dataset.navigationIndex) : undefined,
      scrollTop: body.scrollTop, distanceToBottom: Math.max(0, body.scrollHeight - body.clientHeight - body.scrollTop),
      viewportHeight: body.clientHeight, viewportWidth: body.clientWidth, followingTail: body.hasAttribute('data-following-tail'),
      wheelCount, trustedWheelCount, wheelDeltaY, documentVisible: document.visibilityState === 'visible' });
    wheelCount = 0;
    trustedWheelCount = 0;
    wheelDeltaY = 0;
    scrolled = false;
  };
  const settle = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => snapshot(wheelCount ? 'wheel-batch' : scrolled ? 'scroll' : 'activation'), 120);
  };
  const wheel = (event: WheelEvent) => {
    if (rail?.contains(event.target as Node)) return;
    wheelCount++;
    if (event.isTrusted) trustedWheelCount++;
    // deltaMode can differ across devices. Only sum comparable CSS-pixel deltas.
    if (event.deltaMode === 0) wheelDeltaY += event.deltaY;
    settle();
  };
  const scroll = () => { scrolled = true; settle(); };
  body.addEventListener('wheel', wheel, { passive: true });
  body.addEventListener('scroll', scroll, { passive: true });
  rail?.addEventListener('scroll', scroll, { passive: true });
  settle();
  return () => {
    body.removeEventListener('wheel', wheel);
    body.removeEventListener('scroll', scroll);
    rail?.removeEventListener('scroll', scroll);
    window.clearTimeout(timer);
  };
}
