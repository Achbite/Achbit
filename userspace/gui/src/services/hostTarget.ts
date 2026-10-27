/**
 * Kernel Host target resolver.
 *
 * The trusted Tauri parent injects a one-shot proxy bootstrap before any app
 * script. Ordinary browser contexts intentionally have no privileged fallback.
 */

interface KernelHostTarget {
  host: string;
  port: string;
  uiToken: string;
  windowChrome: 'custom' | 'nativeOverlay';
  remote: boolean;
  remoteLabel?: string;
}

interface KernelHostBootstrap {
  schemaVersion: 'achbit.host-ui-bootstrap';
  host: string;
  port: string;
  uiToken: string;
  windowChrome: 'custom' | 'nativeOverlay';
  remote?: boolean;
  remoteLabel?: string;
}

declare global {
  interface Window {
    __ACHBIT_HOST_BOOT__?: KernelHostBootstrap;
  }
}

function consumeTrustedBootstrap(): KernelHostTarget | null {
  if (typeof window === 'undefined') return null;
  const boot = window.__ACHBIT_HOST_BOOT__;
  Reflect.deleteProperty(window, '__ACHBIT_HOST_BOOT__');
  const trustedDesktopOrigin = (
    (
      window.location.protocol === 'achbit-gui:'
      && window.location.hostname === 'localhost'
    )
    || (
      window.location.protocol === 'http:'
      && [
        'achbit-gui.localhost',
      ].includes(window.location.hostname)
    )
  );
  if (
    !boot ||
    boot.schemaVersion !== 'achbit.host-ui-bootstrap' ||
    !trustedDesktopOrigin
  ) {
    return null;
  }
  const host = boot.host.trim();
  const port = boot.port.trim();
  const uiToken = boot.uiToken.trim();
  const windowChrome = boot.windowChrome;
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    !/^[0-9]{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    !/^dcui_[0-9a-f]{64}$/.test(uiToken) ||
    !['custom', 'nativeOverlay'].includes(windowChrome)
  ) {
    return null;
  }
  return { host, port, uiToken, windowChrome, remote: boot.remote === true, remoteLabel: boot.remoteLabel };
}

const trustedTarget = consumeTrustedBootstrap();
if (typeof document !== 'undefined') {
  document.documentElement.dataset.achbitWindowChrome = trustedTarget?.windowChrome ?? 'custom';
}
const UNAVAILABLE_LOOPBACK_ORIGIN = 'http://127.0.0.1:0';

function developmentBrowserOrigin(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  if (window.location.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname)) {
    return null;
  }
  return window.location.origin;
}

const browserDevelopmentOrigin = developmentBrowserOrigin();

export function getKernelHttpOrigin(): string {
  return trustedTarget
    ? `http://${trustedTarget.host}:${trustedTarget.port}`
    : browserDevelopmentOrigin ?? UNAVAILABLE_LOOPBACK_ORIGIN;
}

export function getKernelApiBase(): string {
  return `${getKernelHttpOrigin()}/api`;
}

export function getHostConnectionHeaders(): Record<string, string> {
  return trustedTarget
    ? { 'x-achbit-host-ui-token': trustedTarget.uiToken }
    : {};
}

export function usesNativeWindowChrome(): boolean {
  return trustedTarget?.windowChrome === 'nativeOverlay';
}

export const isRemoteHost = (): boolean => trustedTarget?.remote === true;
export const remoteHostLabel = (): string | undefined => trustedTarget?.remoteLabel;
