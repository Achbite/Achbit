import { useLayoutEffect, type RefObject } from 'react';

/** Keep an existing anchored surface within the window without changing its
 * owner, DOM parent, preferred placement, or focus/dismissal behavior. */
export function useViewportBounds(ref: RefObject<HTMLElement | null>, enabled = true): void {
  // Conditional surfaces can mount after an earlier render with an empty ref.
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!enabled || !surface) return;
    const original = { translate: surface.style.translate, maxHeight: surface.style.maxHeight,
      overflowY: surface.style.overflowY };
    const place = () => {
      if (!surface.isConnected) return;
      surface.style.translate = original.translate;
      surface.style.maxHeight = original.maxHeight;
      surface.style.overflowY = original.overflowY;
      let bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const margin = 8;
      const availableHeight = Math.max(0, window.innerHeight - margin * 2);
      if (bounds.height > availableHeight) {
        surface.style.maxHeight = `${availableHeight}px`;
        surface.style.overflowY = 'auto';
        bounds = surface.getBoundingClientRect();
      }
      const x = bounds.left < margin ? margin - bounds.left
        : bounds.right > window.innerWidth - margin ? window.innerWidth - margin - bounds.right : 0;
      const y = bounds.top < margin ? margin - bounds.top
        : bounds.bottom > window.innerHeight - margin ? window.innerHeight - margin - bounds.bottom : 0;
      // Individual translate composes with the existing transform used by
      // centered file-change lists; it does not rewrite that transform.
      if (x || y) surface.style.translate = `${x}px ${y}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(surface);
    // Reader resizing and draft attachments can move the anchor without a
    // window resize. Observe its existing ancestor boxes, not a global store.
    for (let node = surface.parentElement; node; node = node.parentElement) observer.observe(node);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      Object.assign(surface.style, original);
    };
  });
}
