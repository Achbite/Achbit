/**
 * 前端 UI 相关类型
 */
export type ConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface AppStatusState {
  apiStatus: ConnectionStatus;
  serverVersion?: string;
  errorMessage?: string;
}
