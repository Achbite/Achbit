import { installTextSelectionBoundary } from '../components/shared/textSelection';
import '../components/shared/focus.css';
import { ConversationDisplayProvider } from '../components/local-agent/ConversationDisplayProvider';
import { HostStartupDiagnostic } from '../components/shared/HostStartupDiagnostic';
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useSettingsStore } from '../state/settingsStore';
import { initializeHostWorkspace } from '../services/workspaceInitialization';
import { isRemoteHost } from '../services/hostTarget';
import { createHostCatalogStartup } from '../services/hostCatalogStartup';
import { requestInterfaceReload } from '../services/interfaceReload';
import { useLocalAgentStore } from '../state/localAgentStore';
import { normalizeUiLanguage, setActiveUiLanguage, t, type UiLanguage } from '../i18n';
import {
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  resolveGuiTheme,
} from '../theme/achbitGuiTheme';
import {
  APP_CLOSE_REQUEST_EVENT,
  closeAppWindow,
  getHealth,
  getHostReadiness,
  getHostStartupStatus,
  onHostStartupComplete,
  healthVersion,
  isRuntimeReady,
  startKernelAfterPermission,
  type HostStartupStatusV1,
} from '../services/runtimeAdapter';
import './achbitGui.css';
import './styles/achbitDesignTokens.css';

const AchbitWorkbenchLayout = lazy(() => import('./layout/AchbitWorkbenchLayout'));

const HOST_STARTUP_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  host_startup_idle: 'achbitGui.hostStartup.idle',
  host_startup_status_unavailable: 'achbitGui.hostStartup.statusUnavailable',
  host_startup_permission_blocked: 'achbitGui.hostStartup.permissionBlocked',
  host_startup_external: 'achbitGui.hostStartup.external',
  host_startup_starting: 'achbitGui.hostStartup.starting',
  host_startup_ready: 'achbitGui.hostStartup.ready',
  host_startup_port_in_use: 'achbitGui.hostStartup.portInUse',
  host_startup_lock_unavailable: 'achbitGui.hostStartup.lockUnavailable',
  host_startup_lock_failed: 'achbitGui.hostStartup.lockFailed',
  host_startup_resolving_binaries: 'achbitGui.hostStartup.resolvingBinaries',
  host_startup_executable_directory_unavailable:
    'achbitGui.hostStartup.executableDirectoryUnavailable',
  host_startup_daemon_binary_missing: 'achbitGui.hostStartup.daemonBinaryMissing',
  host_startup_proxy_binary_missing: 'achbitGui.hostStartup.proxyBinaryMissing',
  host_startup_spawning_daemon: 'achbitGui.hostStartup.spawningDaemon',
  host_startup_daemon_spawn_failed: 'achbitGui.hostStartup.daemonSpawnFailed',
  host_startup_daemon_log_capture_failed: 'achbitGui.hostStartup.daemonLogCaptureFailed',
  host_startup_waiting_daemon_identity: 'achbitGui.hostStartup.waitingDaemonIdentity',
  host_startup_daemon_identity_failed: 'achbitGui.hostStartup.daemonIdentityFailed',
  host_startup_waiting_daemon_recovery: 'achbitGui.hostStartup.waitingDaemonRecovery',
  host_startup_daemon_recovery_failed: 'achbitGui.hostStartup.daemonRecoveryFailed',
  host_startup_spawning_proxy: 'achbitGui.hostStartup.spawningProxy',
  host_startup_proxy_spawn_failed: 'achbitGui.hostStartup.proxySpawnFailed',
  host_startup_proxy_log_capture_failed: 'achbitGui.hostStartup.proxyLogCaptureFailed',
  host_startup_waiting_proxy_identity: 'achbitGui.hostStartup.waitingProxyIdentity',
  host_startup_proxy_identity_failed: 'achbitGui.hostStartup.proxyIdentityFailed',
  host_startup_waiting_proxy_health: 'achbitGui.hostStartup.waitingProxyHealth',
  host_startup_process_exited: 'achbitGui.hostStartup.processExited',
  host_startup_process_status_failed: 'achbitGui.hostStartup.processStatusFailed',
  host_startup_health_timeout: 'achbitGui.hostStartup.healthTimeout',
  host_ssh_connecting: 'achbitGui.ssh.connecting',
  host_ssh_connect_failed: 'achbitGui.ssh.failed',
  host_ssh_disconnected: 'achbitGui.ssh.disconnected',
};

function startupStatusMessage(
  language: UiLanguage,
  status: {
    code: string;
    message?: string;
    reasonCode?: string;
    diagnosticRef?: string;
  },
): string {
  const messageKey = HOST_STARTUP_MESSAGE_KEYS[status.code];
  const message = messageKey
    ? t(language, messageKey)
    : t(language, 'achbitGui.hostStartup.unknown', { code: status.code });
  const details = [status.code, status.reasonCode, status.code.startsWith('host_ssh_') ? status.message : undefined, status.diagnosticRef].filter(Boolean);
  return details.length > 0
    ? `${message} (${details.join(' · ')})`
    : message;
}

function hostAttemptId(status?: HostStartupStatusV1): string | null {
  if (!status || status.attemptId === 'not-started' || status.attemptId === 'unavailable') {
    return null;
  }
  return status.attemptId;
}

const BootFallback: React.FC<{ language: ReturnType<typeof normalizeUiLanguage> }> = ({ language }) => (
  <div className="achbit-gui-boot-shell">
    <div className="achbit-gui-boot-shell__title">Achbit</div>
    <div className="achbit-gui-boot-shell__body">{t(language, 'achbitGui.boot.starting')}</div>
  </div>
);

const AchbitGuiApp: React.FC = () => {
  useEffect(() => {
    return installTextSelectionBoundary(document);
  }, []);

  const {
    apiStatus,
    serverVersion,
    setApiStatus,
    setServerVersion,
    setErrorMessage,
  } = useAppStatusStore();
  const loadUserSettings = useSettingsStore((s) => s.loadUserSettings);
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const loadedIncarnationRef = useRef<string | null>(null);
  const healthWasReadyRef = useRef(false);
  const catalogStartup = useRef(createHostCatalogStartup(ready => useLocalAgentStore.getState().initialize(ready))).current;
  const loadedHostRef = useRef<string | null>(null);
  const healthConnectionSequenceRef = useRef(0);
  const [connectedIncarnation, setConnectedIncarnation] = useState<string | null>(null);
  const [kernelStartBusy, setKernelStartBusy] = useState(false);
  const [hostStartup, setHostStartup] = useState<HostStartupStatusV1 | null>(null);
  const [runtimeInitializationError, setRuntimeInitializationError] = useState<string | null>(null);
  const [workspaceInitializationError, setWorkspaceInitializationError] = useState<string | null>(null);
  const recordRuntimeReady = useCallback((attemptId: string | null) => {
    if (attemptId) {
      setConnectedIncarnation(`host:${attemptId}`);
    } else if (!healthWasReadyRef.current) {
      healthConnectionSequenceRef.current += 1;
      setConnectedIncarnation(`health:${healthConnectionSequenceRef.current}`);
    }
    healthWasReadyRef.current = true;
  }, []);

  const retryKernelStart = useCallback(async () => {
    setKernelStartBusy(true);
    setApiStatus('checking');
    const start = await startKernelAfterPermission();
    if (!start.ok) {
      setApiStatus('error');
      const message = start.message || t(language, 'achbitGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartBusy(false);
      return;
    }
    const startupStatus = start.data?.status;
    setHostStartup(startupStatus ?? null);
    if (start.data?.blocked || startupStatus?.phase === 'failed') {
      setApiStatus('error');
      const message = startupStatus
        ? startupStatusMessage(language, startupStatus)
        : start.data?.message || t(language, 'achbitGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartBusy(false);
      return;
    }

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const result = await getHealth();
      if (isRuntimeReady(result)) {
        const readiness = await getHostReadiness();
        if (readiness.data?.catalog === 'readable') await catalogStartup.observe(readiness.data);
        recordRuntimeReady(readiness.data
          ? `${catalogStartup.hostId()}:${hostAttemptId(startupStatus) ?? 'connection'}`
          : hostAttemptId(startupStatus));
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
        setKernelStartBusy(false);
        // A new SSH tunnel also replaces file watchers and pending preview reads.
        // The shared reload path preserves this window's view and composer drafts.
        if (isRemoteHost() && loadedIncarnationRef.current !== null) requestInterfaceReload();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    const message = startupStatus
      ? startupStatusMessage(language, startupStatus)
      : start.data?.message || t(language, 'achbitGui.kernelStart.waitingHealth');
    setApiStatus('error');
    setErrorMessage(message);
    setKernelStartBusy(false);
  }, [language, catalogStartup, recordRuntimeReady, setApiStatus, setErrorMessage, setServerVersion]);

  useEffect(() => {
    document.documentElement.dataset.product = 'deepcode-gui';
  }, []);

  useEffect(() => {
    if (
      apiStatus !== 'connected'
      || !connectedIncarnation
      || loadedIncarnationRef.current === connectedIncarnation
    ) return;
    const reconnectingRemote = isRemoteHost() && loadedIncarnationRef.current !== null
      && loadedHostRef.current === catalogStartup.hostId();
    loadedHostRef.current = catalogStartup.hostId();
    loadedIncarnationRef.current = connectedIncarnation;
    setWorkspaceInitializationError(null);
    void initializeHostWorkspace().catch((error: unknown) => {
      if (loadedIncarnationRef.current === connectedIncarnation) {
        setWorkspaceInitializationError(error instanceof Error ? error.message : String(error));
      }
    });
    void loadUserSettings();
    const store = useLocalAgentStore.getState();
    if (reconnectingRemote) {
      // This window still targets the same remote Host. Refresh its facts while
      // preserving the user's selected conversation and in-progress input.
      void store.refreshCatalog();
      void store.refreshPluginCatalog();
      void store.refreshProfiles();
      void store.refresh();
    } else if (!catalogStartup.hostId()) {
      void store.initialize();
    }
  }, [apiStatus, connectedIncarnation, loadUserSettings, catalogStartup]);


  useEffect(() => {
    if (apiStatus !== 'connected' || !connectedIncarnation) return;
    return useLocalAgentStore.getState().watchCatalog();
  }, [apiStatus, connectedIncarnation]);

  useEffect(() => {
    const preference = normalizeGuiThemePreference(effectiveSettings['gui.colorTheme']);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.dataset.theme = resolveGuiTheme(preference, media.matches);
    };
    applyTheme();
    if (preference !== 'system') return;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [effectiveSettings]);

  useEffect(() => {
    document.documentElement.dataset.accent = normalizeGuiAccentColor(
      effectiveSettings['gui.accentColor']
    );
  }, [effectiveSettings]);

  useEffect(() => {
    setActiveUiLanguage(language);
    document.documentElement.lang = language;
    window.localStorage.setItem('deepcode.ui.language', language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;
    let checking = false;
    let pending = false;
    let unlisten: (() => void) | undefined;
    const check = async () => {
      if (cancelled) return;
      if (checking) { pending = true; return; }
      if (timeout !== null) { window.clearTimeout(timeout); timeout = null; }
      checking = true;
      try {
        const [result, startup] = await Promise.all([
          getHostReadiness(),
          getHostStartupStatus(),
        ]);
        if (cancelled) return;
        setHostStartup(startup.ok ? startup.data ?? null : null);
        if (result.data?.catalog === 'readable') {
          const changed = await catalogStartup.observe(result.data);
          if (cancelled) return;
          if (changed) {
            // The existing full-health request wakes us at execution readiness;
            // directory discovery does not wait for it or a polling interval.
            void getHealth().then(() => { if (!cancelled) void check(); });
          }
          const error = result.data.runtimeError;
          if (error) setRuntimeInitializationError(`${error.code}: ${error.message}`);
        } else if (startup.ok && startup.data && ['failed', 'blocked'].includes(startup.data.phase)) {
          catalogStartup.fail(new Error(startup.data.message || startup.data.code));
        }
        if (isRuntimeReady(result)) {
          const attemptId = startup.ok ? hostAttemptId(startup.data) : null;
          recordRuntimeReady(`${catalogStartup.hostId()}:${attemptId ?? 'connection'}`);
          setApiStatus('connected');
          setRuntimeInitializationError(null);
          setServerVersion(healthVersion(result.data));
          timeout = window.setTimeout(() => void check(), isRemoteHost() ? 5000 : 30000);
        } else {
          healthWasReadyRef.current = false;
          if (result.ok && result.data?.catalog === 'readable' && !result.data.runtimeError) {
            setApiStatus('checking');
            timeout = window.setTimeout(() => void check(), 500);
          } else if (result.data?.runtimeError) {
            setApiStatus('error');
            setErrorMessage(result.data.runtimeError.message);
            timeout = window.setTimeout(() => void check(), 5000);
          } else if (startup.ok && startup.data) {
            const message = startupStatusMessage(language, startup.data);
            if (startup.data.phase === 'starting' || startup.data.phase === 'idle') {
              setApiStatus('checking');
              timeout = window.setTimeout(() => void check(), 500);
            } else {
              setApiStatus('error');
              setErrorMessage(message);
              timeout = window.setTimeout(() => void check(), 5000);
            }
          } else {
            setApiStatus('error');
            setErrorMessage(result.message || t(language, 'app.apiUnavailable'));
            timeout = window.setTimeout(() => void check(), 5000);
          }
        }
      } finally {
        checking = false;
        if (pending && !cancelled) { pending = false; void check(); }
      }
    };
    void onHostStartupComplete(() => void check()).then(stop => {
      if (cancelled) { stop(); return; }
      unlisten = stop;
      // Read after subscribing so readiness during listener setup is not lost.
      void check();
    }).catch(error => console.error('Host startup event subscription failed', error));
    void check();
    return () => {
      cancelled = true;
      unlisten?.();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [
    language,
    catalogStartup,
    recordRuntimeReady,
    setApiStatus,
    setErrorMessage,
    setServerVersion,
  ]);

  useEffect(() => {
    const close = () => {
      void closeAppWindow();
    };
    window.addEventListener(APP_CLOSE_REQUEST_EVENT, close);
    return () => window.removeEventListener(APP_CLOSE_REQUEST_EVENT, close);
  }, []);

  return (<>
    <HostStartupDiagnostic status={apiStatus === 'connected' ? null : hostStartup} workspaceError={workspaceInitializationError} runtimeError={runtimeInitializationError} language={language} busy={kernelStartBusy} onRetry={() => void retryKernelStart()} />
    <ConversationDisplayProvider><Suspense fallback={<BootFallback language={language} />}>
      <AchbitWorkbenchLayout
        apiStatus={apiStatus}
        serverVersion={serverVersion}
      />
    </Suspense></ConversationDisplayProvider>
  </>);
};

export default AchbitGuiApp;
