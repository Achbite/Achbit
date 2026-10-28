import { restoreAfterProductUpdate, installProductUpdateMonitor } from '../services/productUpdates';
import { installInterfaceReloadShortcut } from '../services/interfaceReload';
import InterfaceReloadDialog from '../components/shared/InterfaceReloadDialog';
import { requestInterfaceReload } from '../services/interfaceReload';
import GuiTypography from '../theme/GuiTypography';
import PaletteOverrides from '../theme/PaletteOverrides';
import { installPaletteDefaults } from '../theme/palette';
import { installInterfaceUpdateMonitor } from '../services/interfaceUpdates';
import { InterfaceUpdateNotice } from '../components/shared/InterfaceUpdateNotice';
import React from 'react';
import '../theme/controls.css';
import ReactDOM from 'react-dom/client';
import AchbitGuiApp from './AchbitGuiApp';
import { installNativeContextMenuGuard } from '../utils/nativeContextMenuGuard';
import { activeT } from '../i18n';
import { UiPluginsProvider } from '../ui-plugins/UiPlugins';

const removePaletteDefaults = installPaletteDefaults();

function formatBootstrapError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  try {
    return JSON.stringify(reason, null, 2);
  } catch {
    return String(reason);
  }
}

function renderBootstrapError(reason: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  const message = formatBootstrapError(reason);
  root.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'achbit-gui-bootstrap-error';
  shell.innerHTML = `
    <div class="achbit-gui-bootstrap-error__card">
      <h1>${activeT('achbitGui.bootstrap.startFailedTitle')}</h1>
      <p>${activeT('achbitGui.bootstrap.startFailedBody')}</p>
      <pre></pre>
    </div>
  `;
  const pre = shell.querySelector('pre');
  if (pre) pre.textContent = message;
  root.appendChild(shell);
}

let reactRootCreated = false;

window.addEventListener('error', (event) => {
  if (!event.error) {
    console.warn('[Achbit browser diagnostic]', event.message);
    return;
  }
  console.error('[Achbit runtime]', event.error ?? event.message);
  if (!reactRootCreated) renderBootstrapError(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Achbit runtime rejection]', event.reason);
  if (!reactRootCreated) renderBootstrapError(event.reason);
});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Achbit]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="achbit-gui-bootstrap-error">
          <div className="achbit-gui-bootstrap-error__card">
            <h1>{activeT('achbitGui.bootstrap.renderFailedTitle')}</h1>
            <p>{activeT('achbitGui.bootstrap.renderFailedBody')}</p>
            <pre>{this.state.error.stack ?? this.state.error.message}</pre>
            <button className="settings-button" type="button" onClick={() => requestInterfaceReload()}>
              {activeT('settings.common.reload')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error(activeT('app.bootstrap.rootMissing'));
}

const isTauriShell =
  window.location.protocol === 'tauri:' ||
  '__TAURI_INTERNALS__' in window ||
  '__TAURI__' in window;

document.documentElement.dataset.product = 'achbit-gui';
document.documentElement.dataset.shell = isTauriShell ? 'tauri' : 'browser';

installNativeContextMenuGuard();

async function mountProduct(rootEl: HTMLElement) {
  await restoreAfterProductUpdate();
  const stopProductUpdates = await installProductUpdateMonitor();
  const stopReloadShortcut = installInterfaceReloadShortcut();
  const stopUpdateMonitor = installInterfaceUpdateMonitor();
  const root = ReactDOM.createRoot(rootEl);
  let compositionDisposed = false;
  const disposeComposition = () => {
    if (compositionDisposed) return;
    compositionDisposed = true;
    window.removeEventListener('pagehide', handlePageHide);
    stopProductUpdates();
    stopUpdateMonitor();
    stopReloadShortcut();
    root.unmount();
    removePaletteDefaults();
  };
  const handlePageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) disposeComposition();
  };
  window.addEventListener('pagehide', handlePageHide);
  import.meta.hot?.dispose(disposeComposition);

  try {
    reactRootCreated = true;
    root.render(
      <React.StrictMode>
        <InterfaceUpdateNotice />
        <InterfaceReloadDialog />
        <ErrorBoundary>
          <PaletteOverrides />
          <GuiTypography />
          <UiPluginsProvider><AchbitGuiApp /></UiPluginsProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    disposeComposition();
    if (!reactRootCreated) {
      renderBootstrapError(error);
    } else {
      console.error('[Achbit root render]', error);
    }
  }
}
void mountProduct(rootEl).catch(renderBootstrapError);
