/**
 * Common API response envelope.
 * Fields are ok, data, message and error.
 */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  message?: string;
  error?: string;
}

import type { WorkspaceSummary } from './workspace.js';

/**
 * Health status
 * returned by GET /api/health.
 *
 * The service literal identifies the Rust Kernel Web Host,
 * which serves the default API.
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
  /** Active workspace summary. An absent workspace has available=false. */
  workspace: WorkspaceSummary;
}
