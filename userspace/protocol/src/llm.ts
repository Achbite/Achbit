export type LlmProviderKind =
  | 'openaiCompatible'
  | 'responses'
  | 'anthropic'
  | 'ollama';

export type LlmProviderFlavor = 'openai' | 'deepseek' | 'zhipu' | 'moonshot';
export const LLM_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LlmReasoningEffort = typeof LLM_REASONING_EFFORTS[number];
export function isLlmReasoningEffort(value: unknown): value is LlmReasoningEffort {
  return typeof value === 'string' && LLM_REASONING_EFFORTS.some(effort => effort === value);
}
export function modelReasoningEfforts(profile?: Pick<LlmProviderProfile, 'providerFlavor'>): readonly LlmReasoningEffort[] {
  return profile?.providerFlavor === 'deepseek' ? ['low', 'high', 'max'] : LLM_REASONING_EFFORTS;
}
export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmHostedWebSearch = 'web_search';

export interface LlmProviderProfile {
  id: string;
  connectionId: string;
  name: string;
  kind: LlmProviderKind;
  providerFlavor: LlmProviderFlavor;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingMode;
  hostedWebSearch?: LlmHostedWebSearch;
  imageInput?: boolean;
  /** Native file formats accepted by this profile. Omitted means none. */
  fileInputMediaTypes?: string[];
  enabled: boolean;
}

export interface LlmProfilesResult {
  profiles: LlmProviderProfile[];
  connections: import('./modelServices.js').ModelConnection[];
  defaultProfileId?: string;
  storePath?: string;
}

export interface PatchLlmProfilesRequest {
  profiles?: LlmProviderProfile[];
  profile?: LlmProviderProfile;
  removeProfileId?: string;
  defaultProfileId?: string;
}

export interface LlmProbeRequest {
  profileId: string;
}

export interface LlmProbeResult {
  ok: boolean;
  provider: LlmProviderKind;
  model?: string;
  latencyMs?: number;
  reasoningPresent?: boolean;
  responsePresent?: boolean;
  nativeCompletion?: {
    providerKind: LlmProviderKind;
    terminalSignal: string;
    finishReason?: 'stop' | 'tool_calls';
  };
  errorCode?: string;
  httpStatus?: number;
  error?: string;
}
