(() => {
  // Native child WebViews have their own document. Dispatch a small, page-bound
  // chrome action through the Host's navigation handler without navigating.
  addEventListener('keydown', event => {
    if (!event.isTrusted || event.isComposing || event.defaultPrevented || event.altKey) return;
    const modifier = /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (!modifier || event.shiftKey && !['+', '='].includes(event.key)) return;
    const action = ({ l: 'address', f: 'find', r: 'reload', w: 'close', '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '0': 'resetZoom' })[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    location.href = 'achbit-browser-control://shortcut/' + action;
  }, true);
})();
