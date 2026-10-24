/**
 * API 响应通用包装
 * 遵循统一响应格式：{ ok, data?, message?, error? }
 */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  message?: string;
  error?: string;
}

import type { WorkspaceSummary } from './workspace.js';

/**
 * 健康检查状态
 * GET /api/health 的响应数据类型
 *
 * 注意：service 字面量固定为 Rust Kernel Web Host 的服务名；
 * 旧 Node server 不再作为默认 API 事实源。
 */
export interface HealthStatus {
  service: 'achbit-host-web' | 'achbit-kernel-daemon' | string;
  ok: boolean;
  status: 'ok' | 'degraded';
  version?: string;
  timestamp?: string;
  buildCommit?: string;
  kernelAbiVersion?: string;
  protocolVersion?: string;
  kernel: 'ready';
  session: 'ready' | 'unavailable';
  /** 当前活动工作区摘要；无工作区时 available=false */
  workspace: WorkspaceSummary;
}
