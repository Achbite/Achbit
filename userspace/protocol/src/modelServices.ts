import type { LlmProviderKind, LlmProviderProfile } from './llm.js';

export type BillingMode = 'metered' | 'subscription';
export type AuthMethod = 'apiKey' | 'browser' | 'deviceCode' | 'none';
export interface ModelConnection {
  id: string;
  name: string;
  adapterId: string;
  billingMode: BillingMode;
  baseUrl: string;
  credentialKind: 'apiKey' | 'oauth' | 'none';
  credentialRef?: string;
}
export interface ConnectionSummary extends ModelConnection {
  authStatus: 'unconfigured' | 'ready' | 'needsLogin';
  account?: { label: string; plan?: string | null };
}
export interface ProviderAdapterDescriptor {
  id: string;
  name: string;
  billingModes: BillingMode[];
  authMethods: AuthMethod[];
  protocols: LlmProviderKind[];
  defaultBaseUrl: string;
  models: Array<Omit<LlmProviderProfile, 'id' | 'connectionId'>>;
  pricing: boolean;
  quota: boolean;
  source: 'builtin' | 'external';
}
export interface ConnectionsResult {
  connections: ConnectionSummary[];
  adapters: ProviderAdapterDescriptor[];
}
export type ConnectionEdit =
  | { connection: ModelConnection; apiKey?: string | null; profile?: LlmProviderProfile }
  | { removeConnectionId: string }
  | { order: string[] };
export interface AuthFlow {
  id: string;
  connectionId: string;
  status: 'pending' | 'complete' | 'cancelled' | 'failed';
  method: 'browser' | 'deviceCode';
  verificationUrl?: string | null;
  userCode?: string | null;
  expiresAt: number;
  error?: string | null;
}
export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowDurationSeconds: number;
  resetsAt?: number;
}
export interface QuotaSnapshot {
  connectionId: string;
  capturedAt: number;
  windows: QuotaWindow[];
  credits?: { unlimited: boolean; balance?: string };
}
export interface UsageQuery {
  from: number;
  to: number;
  timeZone: string;
  granularity: 'hour' | 'day';
  connectionId?: string;
  modelId?: string;
  sessionId?: string;
}
export interface UsageTotals {
  calls: number;
  reportedCalls: number;
  pricedCalls: number;
  cacheReportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Input tokens from calls that also reported a cache-read count, including zero hits. */
  cacheReportedInputTokens: number;
  estimatedCost: number | null;
}
export interface UsageBucket extends UsageTotals {
  start: number;
  end: number;
  label: string;
}
export interface UsageReport {
  query: UsageQuery;
  currency: 'USD';
  coverageFrom: number;
  totals: UsageTotals;
  buckets: UsageBucket[];
  connections: Array<UsageTotals & { connectionId: string }>;
  sessions: Array<UsageTotals & { sessionId: string }>;
}
export interface ModelPrice {
  model: string;
  adapterId: string;
  input: number;
  cacheRead: number;
  cacheWrite?: number | null;
  output: number;
  source: string;
  effectiveFrom: string;
  longContext?: { threshold: number; inputMultiplier: number; outputMultiplier: number };
}
