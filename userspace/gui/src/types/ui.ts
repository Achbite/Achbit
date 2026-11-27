/**
 * Frontend UI types.
 */
export type ConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface AppStatusState {
  apiStatus: ConnectionStatus;
  serverVersion?: string;
  errorMessage?: string;
}
