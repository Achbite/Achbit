import thinkingPolicies from './modelThinkingPolicies.json' with { type: 'json' };

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
type ModelThinkingProfile = Pick<LlmProviderProfile, 'providerFlavor'> & Partial<Pick<LlmProviderProfile, 'model' | 'kind' | 'reasoningEffort'>>;
function anthropicThinkingPolicy(profile?: ModelThinkingProfile) {
  if (profile?.kind !== 'anthropic' || profile.providerFlavor === 'deepseek') return undefined;
  return thinkingPolicies.anthropicAdaptive.find(rule => profile.model?.startsWith(rule.prefix))
    ?? thinkingPolicies.anthropicManual.find(rule => profile.model?.startsWith(rule.prefix));
}
function geminiEfforts(profile?: ModelThinkingProfile, adapterId?: string): readonly string[] | undefined {
  if (adapterId !== 'gemini' || profile?.kind !== 'openaiCompatible' || !profile.model) return undefined;
  const efforts: Record<string, readonly string[]> = thinkingPolicies.geminiChatEfforts;
  return Object.hasOwn(efforts, profile.model) ? efforts[profile.model] : undefined;
}
export function connectedModelReasoningEfforts(
  profile: LlmProviderProfile | undefined, connections: readonly import('./modelServices.js').ModelConnection[],
): readonly LlmReasoningEffort[] {
  return modelReasoningEfforts(profile, connections.find(connection => connection.id === profile?.connectionId)?.adapterId);
}
export function modelReasoningEfforts(profile?: ModelThinkingProfile, adapterId?: string): readonly LlmReasoningEffort[] {
  const model = profile?.model ?? '';
  if (adapterId === 'dashscope' && profile?.kind === 'openaiCompatible' && model === 'qwen4-max') {
    return ['low', 'high', 'xhigh'];
  }
  const declared = profile?.kind === 'ollama'
    ? (thinkingPolicies.ollamaAlwaysThinking.includes(model.split(':')[0]!) ? thinkingPolicies.ollamaEfforts : [])
    : geminiEfforts(profile, adapterId) ?? anthropicThinkingPolicy(profile)?.efforts;
  if (declared) return declared.map(value => {
    if (!isLlmReasoningEffort(value)) throw new Error('model_thinking_policy_invalid');
    return value;
  });
  if (profile?.providerFlavor === 'deepseek'
    || profile?.providerFlavor === 'zhipu' && model === 'glm-5.3') return ['low', 'high', 'max'];
  if (profile?.providerFlavor === 'moonshot') {
    if (model.startsWith('kimi-k3') || ['k3', 'k3-256k', 'k3.1-pro', 'k3.1-pro-highspeed', 'kimi-for-coding'].includes(model)) return ['low', 'high', 'max'];
    if (model.startsWith('kimi-k2.7-code') || model === 'kimi-for-coding-highspeed') return [];
  }
  return LLM_REASONING_EFFORTS;
}
export type LlmThinkingMode = 'enabled' | 'disabled';
export function modelThinkingModes(profile?: ModelThinkingProfile, adapterId?: string): readonly LlmThinkingMode[] {
  const model = profile?.model ?? '';
  const adaptive = anthropicThinkingPolicy(profile);
  const declaredRequired = !!geminiEfforts(profile, adapterId) || adaptive?.disable === 'never'
    || adaptive?.disable === 'throughHigh' && ['xhigh', 'max'].includes(profile?.reasoningEffort ?? '')
    || profile?.kind === 'ollama' && thinkingPolicies.ollamaAlwaysThinking.includes(model.split(':')[0]);
  const required = declaredRequired || profile?.providerFlavor === 'zhipu' && model === 'glm-5.3'
    || profile?.providerFlavor === 'moonshot' && (model.startsWith('kimi-k3') || ['k3.1-pro', 'k3.1-pro-highspeed'].includes(model))
    || profile?.providerFlavor === 'openai' && ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'MiniMax-M3.1-Flash'].includes(model);
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
