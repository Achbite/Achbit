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
type ModelThinkingProfile = Pick<LlmProviderProfile, 'providerFlavor'> & Partial<Pick<LlmProviderProfile, 'model'>>;
export function modelReasoningEfforts(profile?: ModelThinkingProfile): readonly LlmReasoningEffort[] {
  const model = profile?.model ?? '';
  if (profile?.providerFlavor === 'deepseek'
    || profile?.providerFlavor === 'zhipu' && model === 'glm-5.3') return ['low', 'high', 'max'];
  if (profile?.providerFlavor === 'moonshot') {
    if (model.startsWith('kimi-k3') || ['k3', 'k3-256k', 'k3.1-pro', 'k3.1-pro-highspeed', 'kimi-for-coding'].includes(model)) return ['low', 'high', 'max'];
    if (model.startsWith('kimi-k2.7-code') || model === 'kimi-for-coding-highspeed') return [];
  }
  return LLM_REASONING_EFFORTS;
}
export type LlmThinkingMode = 'enabled' | 'disabled';
export function modelThinkingModes(profile?: ModelThinkingProfile): readonly LlmThinkingMode[] {
  const model = profile?.model ?? '';
  const required = profile?.providerFlavor === 'zhipu' && model === 'glm-5.3'
    || profile?.providerFlavor === 'moonshot' && (model.startsWith('kimi-k3') || ['k3.1-pro', 'k3.1-pro-highspeed'].includes(model))
    || profile?.providerFlavor === 'openai' && ['gpt-6-astra', 'gpt-6.1-sol', 'MiniMax-M3.1-Flash'].includes(model);
  return required ? ['enabled'] : ['enabled', 'disabled'];
}
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
