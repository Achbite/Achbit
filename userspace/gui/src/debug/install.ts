import { createDebugUiRegistry } from './registry';
import { createOwnershipInspector } from './ownership';
import sources from 'virtual:achbit-ui-sources';

const ownership = createOwnershipInspector(sources);
window.__ACHBIT_DEBUG_UI__ = {
  ...createDebugUiRegistry(ownership.component),
  identity: ownership.identity,
  setOverlay: ownership.setOverlay,
  overlayStatus: ownership.status,
};

// The Debug script loads in <head>. At interactive, the body exists and the
// workbench's deferred module can mount its controls with inspection active.
const enableOverlay = () => ownership.setOverlay(true);
if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', enableOverlay, { once: true });
} else {
  enableOverlay();
}
