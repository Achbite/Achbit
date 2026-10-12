import { preventBlankTextSelection } from '../components/shared/textSelection';
import '../components/shared/focus.css';
import { ConversationDisplayProvider } from '../components/local-agent/ConversationDisplayProvider';
import { HostStartupDiagnostic } from '../components/shared/HostStartupDiagnostic';
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useSettingsStore } from '../state/settingsStore';
import { initializeHostWorkspace } from '../services/workspaceInitialization';
import { useLocalAgentStore } from '../state/localAgentStore';
import { normalizeUiLanguage, setActiveUiLanguage, t, type UiLanguage } from '../i18n';
import {
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  resolveGuiTheme,
} from '../theme/deepcodeGuiTheme';
import {
  APP_CLOSE_REQUEST_EVENT,
  closeAppWindow,
  getHealth,
  getHostStartupStatus,
  healthVersion,
  isRuntimeReady,
  startKernelAfterPermission,
  type HostStartupStatusV1,
} from '../services/runtimeAdapter';
import './deepcodeGui.css';
import './styles/deepcodeDesignTokens.css';

const DeepCodeWorkbenchLayout = lazy(() => import('./layout/DeepCodeWorkbenchLayout'));

const HOST_STARTUP_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  host_startup_idle: 'deepcodeGui.hostStartup.idle',
  host_startup_status_unavailable: 'deepcodeGui.hostStartup.statusUnavailable',
  host_startup_permission_blocked: 'deepcodeGui.hostStartup.permissionBlocked',
  host_startup_external: 'deepcodeGui.hostStartup.external',
  host_startup_starting: 'deepcodeGui.hostStartup.starting',
  host_startup_ready: 'deepcodeGui.hostStartup.ready',
  host_startup_port_in_use: 'deepcodeGui.hostStartup.portInUse',
  host_startup_lock_unavailable: 'deepcodeGui.hostStartup.lockUnavailable',
  host_startup_lock_failed: 'deepcodeGui.hostStartup.lockFailed',
  host_startup_resolving_binaries: 'deepcodeGui.hostStartup.resolvingBinaries',
  host_startup_executable_directory_unavailable:
    'deepcodeGui.hostStartup.executableDirectoryUnavailable',
  host_startup_daemon_binary_missing: 'deepcodeGui.hostStartup.daemonBinaryMissing',
  host_startup_proxy_binary_missing: 'deepcodeGui.hostStartup.proxyBinaryMissing',
  host_startup_spawning_daemon: 'deepcodeGui.hostStartup.spawningDaemon',
  host_startup_daemon_spawn_failed: 'deepcodeGui.hostStartup.daemonSpawnFailed',
  host_startup_daemon_log_capture_failed: 'deepcodeGui.hostStartup.daemonLogCaptureFailed',
  host_startup_waiting_daemon_identity: 'deepcodeGui.hostStartup.waitingDaemonIdentity',
  host_startup_daemon_identity_failed: 'deepcodeGui.hostStartup.daemonIdentityFailed',
  host_startup_waiting_daemon_recovery: 'deepcodeGui.hostStartup.waitingDaemonRecovery',
  host_startup_daemon_recovery_failed: 'deepcodeGui.hostStartup.daemonRecoveryFailed',
  host_startup_spawning_proxy: 'deepcodeGui.hostStartup.spawningProxy',
  host_startup_proxy_spawn_failed: 'deepcodeGui.hostStartup.proxySpawnFailed',
  host_startup_proxy_log_capture_failed: 'deepcodeGui.hostStartup.proxyLogCaptureFailed',
  host_startup_waiting_proxy_identity: 'deepcodeGui.hostStartup.waitingProxyIdentity',
  host_startup_proxy_identity_failed: 'deepcodeGui.hostStartup.proxyIdentityFailed',
  host_startup_waiting_proxy_health: 'deepcodeGui.hostStartup.waitingProxyHealth',
  host_startup_process_exited: 'deepcodeGui.hostStartup.processExited',
  host_startup_process_status_failed: 'deepcodeGui.hostStartup.processStatusFailed',
  host_startup_health_timeout: 'deepcodeGui.hostStartup.healthTimeout',
};

function startupStatusMessage(
  language: UiLanguage,
  status: {
    code: string;
    reasonCode?: string;
    diagnosticRef?: string;
  },
): string {
  const messageKey = HOST_STARTUP_MESSAGE_KEYS[status.code];
  const message = messageKey
    ? t(language, messageKey)
    : t(language, 'deepcodeGui.hostStartup.unknown', { code: status.code });
  const details = [status.code, status.reasonCode, status.diagnosticRef].filter(Boolean);
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
  <div className="deepcode-gui-boot-shell">
    <div className="deepcode-gui-boot-shell__title">DeepCode-GUI</div>
    <div className="deepcode-gui-boot-shell__body">{t(language, 'deepcodeGui.boot.starting')}</div>
  </div>
);

const DeepCodeGuiApp: React.FC = () => {
  useEffect(() => {
    document.addEventListener('mousedown', preventBlankTextSelection, true);
    return () => document.removeEventListener('mousedown', preventBlankTextSelection, true);
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
  const healthConnectionSequenceRef = useRef(0);
  const [connectedIncarnation, setConnectedIncarnation] = useState<string | null>(null);
  const [kernelStartBusy, setKernelStartBusy] = useState(false);
  const [hostStartup, setHostStartup] = useState<HostStartupStatusV1 | null>(null);
  const [kernelStartMessage, setKernelStartMessage] = useState<string | null>(null);
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
    setKernelStartMessage(null);
    setApiStatus('checking');
    const start = await startKernelAfterPermission();
    if (!start.ok) {
      setApiStatus('error');
      const message = start.message || t(language, 'deepcodeGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartMessage(message);
      setKernelStartBusy(false);
      return;
    }
    const startupStatus = start.data?.status;
    setHostStartup(startupStatus ?? null);
    if (start.data?.blocked || startupStatus?.phase === 'failed') {
      setApiStatus('error');
      const message = startupStatus
        ? startupStatusMessage(language, startupStatus)
        : start.data?.message || t(language, 'deepcodeGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartMessage(message);
      setKernelStartBusy(false);
      return;
    }

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const result = await getHealth();
      if (isRuntimeReady(result)) {
        recordRuntimeReady(hostAttemptId(startupStatus));
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
        setKernelStartMessage(null);
        setKernelStartBusy(false);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    const message = startupStatus
      ? startupStatusMessage(language, startupStatus)
      : start.data?.message || t(language, 'deepcodeGui.kernelStart.waitingHealth');
    setApiStatus('error');
    setErrorMessage(message);
    setKernelStartMessage(message);
    setKernelStartBusy(false);
  }, [language, recordRuntimeReady, setApiStatus, setErrorMessage, setServerVersion]);

  useEffect(() => {
    document.documentElement.dataset.product = 'deepcode-gui';
  }, []);

  useEffect(() => {
    if (
      apiStatus !== 'connected'
      || !connectedIncarnation
      || loadedIncarnationRef.current === connectedIncarnation
    ) return;
    loadedIncarnationRef.current = connectedIncarnation;
    setWorkspaceInitializationError(null);
    void initializeHostWorkspace().catch((error: unknown) => {
      if (loadedIncarnationRef.current === connectedIncarnation) {
        setWorkspaceInitializationError(error instanceof Error ? error.message : String(error));
      }
    });
    void loadUserSettings();
    void useLocalAgentStore.getState().initialize();
  }, [apiStatus, connectedIncarnation, loadUserSettings]);


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
    const check = async () => {
      const [result, startup] = await Promise.all([
        getHealth(),
        getHostStartupStatus(),
      ]);
      if (cancelled) return;
      setHostStartup(startup.ok ? startup.data ?? null : null);
      if (isRuntimeReady(result)) {
        const attemptId = startup.ok ? hostAttemptId(startup.data) : null;
        recordRuntimeReady(attemptId);
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
        setKernelStartMessage(null);
        timeout = window.setTimeout(() => void check(), 30000);
      } else {
        healthWasReadyRef.current = false;
        if (startup.ok && startup.data) {
          const message = startupStatusMessage(language, startup.data);
          setKernelStartMessage(message);
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
    };
    void check();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [
    language,
    recordRuntimeReady,
    setApiStatus,
    setErrorMessage,
    setKernelStartMessage,
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
    <HostStartupDiagnostic status={apiStatus === 'connected' ? null : hostStartup} workspaceError={workspaceInitializationError} language={language} busy={kernelStartBusy} onRetry={() => void retryKernelStart()} />
    <ConversationDisplayProvider><Suspense fallback={<BootFallback language={language} />}>
      <DeepCodeWorkbenchLayout
        apiStatus={apiStatus}
        serverVersion={serverVersion}
        kernelStartBusy={kernelStartBusy}
        kernelStartMessage={kernelStartMessage}
        onRetryKernelStart={retryKernelStart}
      />
    </Suspense></ConversationDisplayProvider>
  </>);
};

export default DeepCodeGuiApp;
