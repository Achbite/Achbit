import { permissionSettings, decodeAgentCapabilities, decodeAgentSettings, decodeAgentModelParameters, isLlmReasoningEffort } from '@deepcode/protocol';
import { isManagedProcessSnapshot, type ManagedProcessSnapshot, type ProcessReadRequest } from '@deepcode/protocol';
import { isLocalAgentErrorValue } from '@deepcode/protocol';
import type {
  JsonObject,
  AgentHostPort,
  AgentModel,
  AgentSettings,
  AgentContext,
  SessionProjection,
  CommandJournalPort,
  RunLifecycleRead,
  CommandReply,
  ConversationCommand,
  KernelPort,
  PlanAuthority,
  PrepareRunRuntimeRequest,
  PreparedRunRuntime,
  PreparedToolDescriptor,
  PreparedToolPromptContribution,
  ProviderRuntimeSnapshot,
  NewSessionEvent,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ReleaseRunRuntimeRequest,
  ReleaseRunRuntimeResult,
  RetireToolViewsRequest,
  RunPreparationPort,
  RunRuntimeSnapshot,
  SelectedPluginSnapshot,
  SessionCreationInput,
  SessionEvent,
  StoredCommand,
  ToolCancelReply,
  FileCallPreparationRequest,
  FileCallPreparationReply,
  ToolExecutionRecord,
  ToolExecutionReply,
  ToolExecutionRequest,
  ToolExecutionProgress,
} from '@deepcode/protocol';
import {
  KERNEL_REPLY_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT,
} from '@deepcode/protocol';
import { createProviderToolAliases } from './providerToolCodec.js';
import { LoopFailure, errorFact } from './loopFailure.js';
import { postLocalStream } from './localHttpStream.js';
import { sessionControlToolDefinitions } from './sessionControls.js';
import { environmentInstruction } from './sessionEnvironment.js';
import {
  decodeRunPluginConfig,
  runtimeInstructions,
  type InstructionContribution,
} from './skillPlugins.js';
import {
  decodeToolPromptProviderSnapshots,
  prepareToolPromptContributions,
} from './toolPromptContributions.js';

interface HttpPortOptions {
  apiBase: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}

class LocalAgentHttpPort {
  readonly apiBase: string;
  readonly serviceToken: string;
  readonly fetchImpl: typeof fetch;
  readonly #streamFetch?: typeof fetch;

  constructor(options: HttpPortOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/u, '');
    this.serviceToken = options.serviceToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.#streamFetch = options.fetchImpl;
  }

  protected postStream(path: string, value: unknown, signal: AbortSignal): Promise<Response> {
    const url = `${this.apiBase}${path}`;
    const headers = { 'x-deepcode-session-service-token': this.serviceToken, 'content-type': 'application/json' };
    const body = JSON.stringify(value);
    return this.#streamFetch
      ? this.#streamFetch(url, { method: 'POST', headers, body, signal })
      : postLocalStream(url, headers, body, signal);
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          'x-deepcode-session-service-token': this.serviceToken,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new LoopFailure('local_agent_transport_failed',
        `${init.method ?? 'GET'} ${path} headers: ${transportErrorMessage(error)}`);
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new LoopFailure('local_agent_http_json_invalid',
        `${init.method ?? 'GET'} ${path} body (HTTP ${response.status}): ${transportErrorMessage(error)}`);
    }
    if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
      throw new Error('local_agent_http_envelope_invalid');
    }
    if (!response.ok || !envelope.ok) {
      const code = typeof envelope.error === 'string' ? envelope.error : 'local_agent_http_failed';
      const message = typeof envelope.message === 'string' ? envelope.message : code;
      throw new Error(`${code}:${message}`);
    }
    return envelope.data as T;
  }
}

function transportErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  while (error !== undefined && !seen.has(error)) {
    seen.add(error);
    if (!(error instanceof Error)) { messages.push(String(error)); break; }
    messages.push(`${'code' in error ? `${String(error.code)}: ` : ''}${error.message}`);
    error = error.cause;
  }
  return messages.join('; cause ');
}

export class HttpCommandJournal extends LocalAgentHttpPort implements CommandJournalPort {
  readonly #permissions = new Map<string, { revision: number; settings: RunRuntimeSnapshot['permissions'] }>();
  readonly #permissionListeners = new Map<string, Set<(settings: RunRuntimeSnapshot['permissions']) => void>>();

  subscribePermissions(sessionId: string, publish: (settings: RunRuntimeSnapshot['permissions']) => void): () => void {
    const listeners = this.#permissionListeners.get(sessionId) ?? new Set();
    this.#permissionListeners.set(sessionId, listeners);
    listeners.add(publish);
    const current = this.#permissions.get(sessionId);
    if (current) publish(current.settings);
    return () => { listeners.delete(publish); if (!listeners.size) this.#permissionListeners.delete(sessionId); };
  }

  private async publication<T>(path: string, init: RequestInit = {}): Promise<T> {
    const result = await this.json<{ value: T; permissions: Record<string, { revision: number; settings: RunRuntimeSnapshot['permissions'] }> }>(path, init);
    for (const [id, view] of Object.entries(result.permissions)) {
      if ((this.#permissions.get(id)?.revision ?? -1) >= view.revision) continue;
      const settings = permissionSettings(view.settings);
      this.#permissions.set(id, { revision: view.revision, settings });
      for (const publish of this.#permissionListeners.get(id) ?? []) publish(settings);
    }
    return result.value;
  }

  async createSession(input: SessionCreationInput): Promise<SessionEvent> {
    return await this.json('/api/local-agent/journal/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.publication(`/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    this.#permissions.delete(sessionId);
  }

  async append(event: NewSessionEvent): Promise<SessionEvent> {
    return await this.publication('/api/local-agent/journal/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  async appendBatch(events: readonly NewSessionEvent[]): Promise<SessionEvent[]> {
    return await this.publication('/api/local-agent/journal/events/batch', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  async *read(sessionId: string, afterSequence = 0): AsyncIterable<SessionEvent> {
    const events = await this.publication<SessionEvent[]>(
      `/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSequence}`,
    );
    for (const event of events) yield event;
  }

  async readRunLifecycle(sessionId: string, afterSequence = 0): Promise<RunLifecycleRead> {
    return await this.json(
      `/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/run-lifecycle?after=${afterSequence}`,
    );
  }

  async readAgentLifecycle(sessionId: string): Promise<import('@deepcode/protocol').AgentLifecycleRead> {
    return this.json(`/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/agent-lifecycle`);
  }

  async readProviderUsage(sessionId: string): Promise<import('@deepcode/protocol').ProviderUsageRead> {
    return this.json(`/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/provider-usage`);
  }

  async readCommand(sessionId: string, commandId: string): Promise<StoredCommand | null> {
    return await this.json(
      `/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    );
  }

  async commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<{ reply: CommandReply; events: SessionEvent[] }> {
    return await this.publication('/api/local-agent/journal/commands', {
      method: 'POST',
      body: JSON.stringify({ command, events, reply }),
    });
  }
}

export class HttpAgentHostPort extends LocalAgentHttpPort implements AgentHostPort {
  async models(): Promise<readonly AgentModel[]> {
    const value: unknown = await this.json('/api/local-agent/agents/models');
    if (!Array.isArray(value)) throw new Error('agent_models_invalid');
    return value.map(model => {
      if (!isExactRecord(model, ['profileId', 'name', 'model', 'reasoningEfforts', 'parameters'], ['reasoningEffort', 'thinking'])
        || ![model.profileId, model.name, model.model].every(isNonEmptyText)
        || !Array.isArray(model.reasoningEfforts) || !model.reasoningEfforts.every(isLlmReasoningEffort)
        || model.reasoningEffort !== undefined && !isLlmReasoningEffort(model.reasoningEffort)
        || model.thinking !== undefined && model.thinking !== 'enabled' && model.thinking !== 'disabled') {
        throw new Error('agent_models_invalid');
      }
      return { profileId: model.profileId as string, name: model.name as string, model: model.model as string,
        parameters: decodeAgentModelParameters(model.parameters),
        reasoningEfforts: [...model.reasoningEfforts],
        ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
        ...(model.thinking !== undefined ? { thinking: model.thinking } : {}) };
    });
  }

  async settings(): Promise<AgentSettings> {
    return decodeAgentSettings(await this.json('/api/local-agent/agents/settings'));
  }

  async saveDefaults(settings: AgentSettings): Promise<void> {
    await this.json('/api/local-agent/agents/settings', { method: 'POST', body: JSON.stringify(settings) });
  }

  async createSession(input: SessionCreationInput & { profileId: string; agentContext: AgentContext }): Promise<SessionProjection> {
    const value = await this.json<SessionProjection>('/api/local-agent/agents/sessions', { method: 'POST', body: JSON.stringify(input) });
    if (value.sessionId !== input.sessionId || value.agentContext?.parentCallId !== input.agentContext.parentCallId) throw new Error('agent_session_identity_mismatch');
    return value;
  }
}

export class HttpKernelPort extends LocalAgentHttpPort implements KernelPort {
  async prepareFileCalls(request: FileCallPreparationRequest): Promise<FileCallPreparationReply> {
    const value = await this.json<FileCallPreparationReply>('/api/local-agent/kernel/prepare', {
      method: 'POST', body: JSON.stringify(request),
    });
    if (!Array.isArray(value.calls) || value.calls.length !== request.requests.length
      || value.calls.some((call, index) => call.callId !== request.requests[index]?.callId
        || !Array.isArray(call.conflictsWith) || call.conflictsWith.some(id => typeof id !== 'string'))) {
      throw new Error('kernel_file_preparation_reply_invalid');
    }
    return value;
  }

  async planAdmission(request: Parameters<KernelPort['planAdmission']>[0]): ReturnType<KernelPort['planAdmission']> {
    const result = await this.json<Awaited<ReturnType<KernelPort['planAdmission']>>>('/api/local-agent/plans/admission', {
      method: 'POST', body: JSON.stringify(request),
    });
    if (!['agent', 'parent', 'user', 'sessionWorkdir'].includes(result.source) || !Array.isArray(result.authorities)
      || result.source === 'parent' && !result.authorities.length
      || result.source === 'sessionWorkdir' && result.authorities.length) throw new Error('plan_admission_invalid');
    return result;
  }
  async readProcesses(request: ProcessReadRequest, signal?: AbortSignal): Promise<ManagedProcessSnapshot[]> {
    const value: unknown = await this.json('/api/local-agent/kernel/processes', {
      method: 'POST', body: JSON.stringify(request), signal,
    });
    if (!isRecord(value) || !Array.isArray(value.jobs) || !value.jobs.every(isManagedProcessSnapshot)
      || value.jobs.some(job => job.sessionId !== request.sessionId || job.runId !== request.runId)) {
      throw new Error('managed_process_snapshot_invalid');
    }
    return value.jobs;
  }

  async execute(request: ToolExecutionRequest, onProgress?: (progress: ToolExecutionProgress) => Promise<void>): Promise<ToolExecutionReply> {
    const controller = new AbortController();
    const response = await this.postStream('/api/local-agent/kernel/execute', request, controller.signal);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const envelope = await response.json() as { error?: string; message?: string };
      throw new Error(`${envelope.error ?? 'kernel_execution_http_failed'}:${envelope.message ?? response.status}`);
    }
    if (!response.body) throw new Error('kernel_execution_stream_missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const frame: unknown = JSON.parse(line);
          if (!isRecord(frame)) throw new Error('kernel_execution_frame_invalid');
          if (frame.type === 'error') throw new Error(`${frame.code}:${frame.message}`);
          if (frame.type === 'reply') {
            const reply = frame.reply as ToolExecutionReply;
            if (!reply || reply.callId !== request.callId || reply.requestId !== request.requestId) throw new Error('kernel_execution_reply_identity_invalid');
            return reply;
          }
          if (frame.type !== 'progress' || frame.callId !== request.callId || frame.attemptId !== request.attemptId || !isRecord(frame.progress)) {
            throw new Error('kernel_execution_progress_identity_invalid');
          }
          const progress = frame.progress;
          if (progress.type === 'started') {
            if (typeof progress.startedAt !== 'string' || !/^\d+$/u.test(progress.startedAt)) throw new Error('kernel_execution_started_invalid');
          } else if (progress.type !== 'output' || !['stdout', 'stderr'].includes(String(progress.stream))
            || !Number.isSafeInteger(progress.offset) || Number(progress.offset) < 0 || !Array.isArray(progress.bytes)
            || !progress.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            throw new Error('kernel_execution_output_invalid');
          }
          await onProgress?.(progress as unknown as ToolExecutionProgress);
        }
        if (done) throw new Error('kernel_execution_reply_missing');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      controller.abort();
    }
  }

  async cancel(callId: string, attemptId: string): Promise<ToolCancelReply> {
    return await this.json('/api/local-agent/kernel/cancel', {
      method: 'POST',
      body: JSON.stringify({ callId, attemptId }),
    });
  }

  async readRecord(callId: string): Promise<ToolExecutionRecord | null> {
    return await this.json(
      `/api/local-agent/kernel/records/${encodeURIComponent(callId)}`,
    );
  }
}

function decodePreparedToolDescriptors(value: unknown): readonly PreparedToolDescriptor[] {
  if (!Array.isArray(value)) throw new Error('kernel_tool_catalog_invalid');
  const seenNames = new Set<string>();
  const seenBindings = new Set<string>();
  return Object.freeze(value.map((candidate): PreparedToolDescriptor => {
    const fields = [
      'toolBindingRef',
      'name',
      'description',
      'inputSchema',
      'possibleEffects',
      'availability',
      'origin',
    ];
    if (isRecord(candidate) && Object.hasOwn(candidate, 'pluginUri')) fields.push('pluginUri');
    if (isRecord(candidate) && Object.hasOwn(candidate, 'availabilityReason')) fields.push('availabilityReason');
    if (isRecord(candidate) && Object.hasOwn(candidate, 'runtimeStatus')) fields.push('runtimeStatus');
    if (
      !isExactRecord(candidate, fields)
      || !isNonEmptyText(candidate.toolBindingRef)
      || !isNonEmptyText(candidate.name)
      || !/^[A-Za-z0-9_.-]+$/u.test(candidate.name)
      || !isNonEmptyText(candidate.description)
      || !isRecord(candidate.inputSchema)
      || !Array.isArray(candidate.possibleEffects)
      || candidate.possibleEffects.some((effect) => ![
        'localRead',
        'workspaceRead',
        'workspaceMutation',
        'process',
        'network',
        'external',
      ].includes(String(effect)))
      || new Set(candidate.possibleEffects.map(String)).size !== candidate.possibleEffects.length
      || candidate.availability !== 'callable' && candidate.availability !== 'blocked'
      || candidate.availabilityReason !== undefined && (candidate.availability !== 'blocked'
        || !isExactRecord(candidate.availabilityReason, ['code', 'message'])
        || !isNonEmptyText(candidate.availabilityReason.code) || !isNonEmptyText(candidate.availabilityReason.message))
      || candidate.runtimeStatus !== undefined && !isRecord(candidate.runtimeStatus)
      || candidate.origin !== 'coreBuiltin' && candidate.origin !== 'extension'
      || (candidate.origin === 'coreBuiltin' && candidate.pluginUri !== undefined)
      || (candidate.origin === 'extension'
        && (!isNonEmptyText(candidate.pluginUri)
          || !/^plugin:\/\/[^@\s]+@[^@\s]+$/u.test(candidate.pluginUri)))
      || seenNames.has(candidate.name)
      || seenBindings.has(candidate.toolBindingRef)
    ) throw new Error('kernel_tool_catalog_invalid');
    seenNames.add(candidate.name);
    seenBindings.add(candidate.toolBindingRef);
    return Object.freeze({
      toolBindingRef: candidate.toolBindingRef,
      name: candidate.name,
      description: candidate.description,
      inputSchema: structuredClone(candidate.inputSchema),
      possibleEffects: [...candidate.possibleEffects] as PreparedToolDescriptor['possibleEffects'],
      availability: candidate.availability,
      ...(candidate.availabilityReason ? { availabilityReason: structuredClone(candidate.availabilityReason) as PreparedToolDescriptor['availabilityReason'] } : {}),
      ...(candidate.runtimeStatus ? { runtimeStatus: structuredClone(candidate.runtimeStatus) } : {}),
      origin: candidate.origin,
      ...(candidate.origin === 'extension'
        ? { pluginUri: candidate.pluginUri as PreparedToolDescriptor['pluginUri'] }
        : {}),
    });
  }).sort((left, right) => left.name.localeCompare(right.name, 'en')));
}

export class HttpProviderPort extends LocalAgentHttpPort implements ProviderPort {
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    try {
      const response = await this.postStream('/api/local-agent/provider/stream', request, signal);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`provider_http_failed:${response.status}`);
      }
      if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        await response.body.cancel();
        throw new LoopFailure('provider_content_type_invalid', 'Provider 本地流响应 Content-Type 无效。');
      }
      yield* decodeProviderEvents(response.body, request.requestId, signal, request.providerAttemptId);
    } catch (error) {
      if (signal.aborted && (error === signal.reason
        || error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason)) throw signal.reason;
      if (error instanceof LoopFailure) throw error;
      const fact = errorFact(error);
      if (error instanceof AggregateError && error.errors[0] instanceof LoopFailure) throw new LoopFailure(fact.code, fact.message, fact.diagnostics);
      throw new LoopFailure('provider_stream_failed', transportErrorMessage(error), {
        source: 'sessionTransport', phase: 'localStream', category: 'transport', retryable: false,
        causes: fact.diagnostics?.causes ?? [{ message: fact.message }],
        ...(fact.diagnostics?.secondary ? { secondary: fact.diagnostics.secondary } : {}),
      });
    }
  }
}

interface HttpRunPreparationPortOptions extends HttpPortOptions {
  stableCoreInstructions: readonly InstructionContribution[];
}

export class HttpRunPreparationPort extends LocalAgentHttpPort implements RunPreparationPort {
  readonly #stableCoreInstructions: readonly InstructionContribution[];

  constructor(options: HttpRunPreparationPortOptions) {
    super(options);
    this.#stableCoreInstructions = Object.freeze(options.stableCoreInstructions
      .map((instruction) => Object.freeze({ ...instruction })));
  }

  async prepare(request: PrepareRunRuntimeRequest): Promise<PreparedRunRuntime> {
    const value = await this.json('/api/local-agent/runtime/prepare-run', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!isExactRecord(value, [
      'schemaVersion',
      'type',
      'sessionId',
      'runId',
      'provider',
      'webSearch',
      'extensionGenerationRef',
      'kernelCatalogSnapshotRef',
      'tools',
      'toolPromptProviders',
      'pluginConfig',
      'selectedPlugins',
      'environment',
      'agentCapabilities',
    ], ['approvalReviewer', 'approvalReviewerError', 'agentToolsEnabled'])) throw new Error('run_runtime_prepared_invalid');
    if (
      value.schemaVersion !== LOCAL_AGENT_PROTOCOL_VERSION
      || value.type !== 'run.runtime.prepared'
      || value.sessionId !== request.sessionId
      || value.runId !== request.runId
      || !isNonEmptyText(value.extensionGenerationRef)
      || !isNonEmptyText(value.kernelCatalogSnapshotRef)
    ) throw new Error('run_runtime_prepared_invalid');
    const releaseRequest = {
      sessionId: request.sessionId,
      runId: request.runId,
      kernelCatalogSnapshotRef: value.kernelCatalogSnapshotRef,
    };
    try {
      const agentCapabilities = decodeAgentCapabilities(value.agentCapabilities);
      if (value.agentToolsEnabled !== undefined && typeof value.agentToolsEnabled !== 'boolean') throw new Error('agent_runtime_capabilities_invalid');
      const provider = decodeProviderRuntime(value.provider);
      const approvalReviewer = value.approvalReviewer === undefined
        ? undefined : decodeProviderRuntime(value.approvalReviewer);
      const approvalReviewerError = value.approvalReviewerError;
      if (approvalReviewerError !== undefined
        && (approvalReviewer !== undefined || !isLocalAgentErrorValue(approvalReviewerError))) {
        throw new Error('run_runtime_approval_reviewer_error_invalid');
      }
      if (provider.reasoningEffortOverride !== request.reasoningEffortOverride) {
        throw new Error('run_runtime_reasoning_override_mismatch');
      }
      const pluginConfig = decodeRunPluginConfig(value.pluginConfig);
      if (pluginConfig.extensionGenerationRef !== value.extensionGenerationRef) {
        throw new Error('run_runtime_extension_identity_mismatch');
      }
      if (request.profileId !== undefined && provider.profileId !== request.profileId) {
        throw new Error('run_runtime_profile_identity_mismatch');
      }
      const tools = [...decodePreparedToolDescriptors(value.tools)];
      const webSearch = decodeWebSearchBinding(value.webSearch, provider, tools);
      const selectedPlugins = decodeSelectedPluginSnapshot(
        value.selectedPlugins,
        value.extensionGenerationRef,
        request,
      );
      const toolPromptProviders = decodeToolPromptProviderSnapshots(value.toolPromptProviders);
      const toolPromptContributions = prepareToolPromptContributions(
        toolPromptProviders,
        tools,
        selectedPlugins,
      );
      const providerToolAliases = createProviderToolAliases([
        ...tools
          .filter((tool) => tool.availability === 'callable')
          .map((tool) => tool.name),
        ...sessionControlToolDefinitions().map((tool) => tool.name),
      ]);
      const wireName = (canonicalName: string): string => {
        const alias = providerToolAliases.find((candidate) => (
          candidate.canonicalName === canonicalName
        ));
        if (!alias) throw new Error(`run_runtime_provider_tool_alias_missing:${canonicalName}`);
        return alias.wireName;
      };
      return {
        runtimeSnapshot: Object.freeze({
          agentCapabilities,
          ...(value.agentToolsEnabled === true ? { agentToolsEnabled: true } : {}),
          runRuntimeSnapshotRef: `run-runtime:${request.sessionId}:${request.runId}`,
          extensionGenerationRef: value.extensionGenerationRef,
          kernelCatalogSnapshotRef: value.kernelCatalogSnapshotRef,
          provider,
          ...(approvalReviewer ? { approvalReviewer } : {}),
          ...(approvalReviewerError ? { approvalReviewerError: structuredClone(approvalReviewerError) } : {}),
          webSearch,
          environment: value.environment as JsonObject,
          permissions: pluginConfig.permissions,
          instructions: [...runtimeInstructions([
            ...this.#stableCoreInstructions,
            environmentInstruction(value.environment),
          ], pluginConfig, {
            interactionRequest: wireName(SESSION_CONTROL_INTERACTION_REQUEST),
            planPublish: wireName(SESSION_CONTROL_PLAN_PUBLISH),
            todoUpdate: wireName(SESSION_CONTROL_TODO_UPDATE),
            pluginActivate: wireName(SESSION_CONTROL_PLUGIN_ACTIVATE),
            artifactPresent: wireName(SESSION_CONTROL_ARTIFACT_PRESENT),
          })],
          tools,
          toolPromptContributions: toolPromptContributions as PreparedToolPromptContribution[],
          providerToolAliases,
          selectedPlugins,
        }),
      };
    } catch (error) {
      try {
        await this.release(releaseRequest);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'run_runtime_prepare_rollback_failed');
      }
      throw error;
    }
  }

  async retireToolViews(request: RetireToolViewsRequest): Promise<void> {
    const value = await this.json('/api/local-agent/runtime/retire-tool-views', {
      method: 'POST', body: JSON.stringify(request),
    });
    if (!isExactRecord(value, ['sessionId', 'runId', 'keepKernelCatalogSnapshotRef'])
      || value.sessionId !== request.sessionId || value.runId !== request.runId
      || value.keepKernelCatalogSnapshotRef !== request.keepKernelCatalogSnapshotRef) {
      throw new Error('tool_views_retired_invalid');
    }
  }

  async release(request: ReleaseRunRuntimeRequest): Promise<ReleaseRunRuntimeResult> {
    const released = decodeRunRuntimeReleased(await this.json('/api/local-agent/runtime/release-run', {
      method: 'POST',
      body: JSON.stringify(request),
    }), request);
    return Object.freeze({
      kernelCatalogSnapshotRef: released.kernelCatalogSnapshotRef,
      alreadyReleased: released.alreadyReleased,
    });
  }
}

function decodeProviderRuntime(value: unknown): ProviderRuntimeSnapshot {
  if (
    !isExactRecord(value, [
      'providerRuntimeRef',
      'profileId',
      'contextWindowTokens',
      'maxOutputTokens',
      'apiSurface',
      'hostedWebSearch',
    ], ['reasoningEffort', 'reasoningEffortOverride', 'thinking'])
    || !isNonEmptyText(value.providerRuntimeRef)
    || !isNonEmptyText(value.profileId)
    || !isPositiveSafeInteger(value.contextWindowTokens)
    || !isPositiveSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens >= value.contextWindowTokens
    || !['chatCompletions', 'responses', 'anthropicMessages', 'ollamaChat']
      .includes(String(value.apiSurface))
    || value.hostedWebSearch !== 'none' && value.hostedWebSearch !== 'web_search'
    || value.hostedWebSearch === 'web_search' && value.apiSurface !== 'responses'
    || [value.reasoningEffort, value.reasoningEffortOverride].some((effort) => effort !== undefined && !isLlmReasoningEffort(effort))
    || value.thinking !== undefined && !['enabled', 'disabled'].includes(String(value.thinking))
    || value.reasoningEffortOverride !== undefined && (value.reasoningEffort !== value.reasoningEffortOverride || value.thinking === 'disabled')
  ) throw new Error('provider_runtime_snapshot_invalid');
  return Object.freeze({
    providerRuntimeRef: value.providerRuntimeRef,
    profileId: value.profileId,
    contextWindowTokens: value.contextWindowTokens,
    maxOutputTokens: value.maxOutputTokens,
    apiSurface: value.apiSurface as ProviderRuntimeSnapshot['apiSurface'],
    hostedWebSearch: value.hostedWebSearch as ProviderRuntimeSnapshot['hostedWebSearch'],
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort as ProviderRuntimeSnapshot['reasoningEffort'] } : {}),
    ...(value.reasoningEffortOverride ? { reasoningEffortOverride: value.reasoningEffortOverride as ProviderRuntimeSnapshot['reasoningEffortOverride'] } : {}),
    ...(value.thinking ? { thinking: value.thinking as ProviderRuntimeSnapshot['thinking'] } : {}),
  });
}

function decodeWebSearchBinding(
  value: unknown,
  provider: ProviderRuntimeSnapshot,
  tools: readonly PreparedToolDescriptor[],
): RunRuntimeSnapshot['webSearch'] {
  const kernelSearchCallable = tools.some((tool) => (
    tool.name === 'web.search' && tool.availability === 'callable'
  ));
  if (
    isExactRecord(value, ['owner', 'providerToolType'])
    && value.owner === 'providerHosted'
    && value.providerToolType === 'web_search'
    && provider.apiSurface === 'responses'
    && provider.hostedWebSearch === 'web_search'
    && !kernelSearchCallable
  ) return Object.freeze({ owner: 'providerHosted', providerToolType: 'web_search' });
  if (
    isExactRecord(value, ['owner', 'toolName'])
    && value.owner === 'kernelAdapter'
    && value.toolName === 'web.search'
    && kernelSearchCallable
  ) return Object.freeze({ owner: 'kernelAdapter', toolName: 'web.search' });
  if (
    isExactRecord(value, ['owner'])
    && value.owner === 'unavailable'
    && !kernelSearchCallable
  ) return Object.freeze({ owner: 'unavailable' });
  throw new Error('run_runtime_web_search_binding_invalid');
}

function decodeSelectedPluginSnapshot(
  value: unknown,
  extensionGenerationRef: string,
  request: PrepareRunRuntimeRequest,
): SelectedPluginSnapshot {
  if (
    !isExactRecord(value, ['catalogRevision', 'plugins'])
    || !isNonEmptyText(value.catalogRevision)
    || !Array.isArray(value.plugins)
  ) throw new Error('selected_plugin_snapshot_invalid');
  const seen = new Set<string>();
  const plugins = value.plugins.map((plugin) => {
    if (
      !isExactRecord(plugin, [
        'uri',
        'pluginArtifactRef',
        'pluginInstanceRef',
        'extensionGenerationRef',
        'capabilityRefs',
      ])
      || typeof plugin.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plugin.uri)
      || seen.has(plugin.uri)
      || !isNonEmptyText(plugin.pluginArtifactRef)
      || !isNonEmptyText(plugin.pluginInstanceRef)
      || plugin.extensionGenerationRef !== extensionGenerationRef
      || !Array.isArray(plugin.capabilityRefs)
      || plugin.capabilityRefs.some((capability) => !isNonEmptyText(capability))
    ) throw new Error('selected_plugin_snapshot_invalid');
    seen.add(plugin.uri);
    return {
      uri: plugin.uri as SelectedPluginSnapshot['plugins'][number]['uri'],
      pluginArtifactRef: plugin.pluginArtifactRef,
      pluginInstanceRef: plugin.pluginInstanceRef,
      extensionGenerationRef,
      capabilityRefs: [...plugin.capabilityRefs] as string[],
    };
  });
  const requested = request.pluginSelections ?? [];
  if (
    requested.length > 0
    && (
      (!request.refreshPlugins && (requested.length !== plugins.length || requested.some((selection) => !seen.has(selection.uri))))
      || plugins.some((plugin) => !requested.some(selection=>selection.uri===plugin.uri))
    )
  ) throw new Error('selected_plugin_snapshot_identity_mismatch');
  return {
    catalogRevision: value.catalogRevision,
    plugins,
  };
}

function decodeRunRuntimeReleased(
  value: unknown,
  request: ReleaseRunRuntimeRequest,
): ReleaseRunRuntimeResult {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'type',
      'sessionId',
      'runId',
      'kernelCatalogSnapshotRef',
      'released',
      'alreadyReleased',
    ])
    || value.schemaVersion !== KERNEL_REPLY_VERSION
    || value.type !== 'tool.catalog.released'
    || value.sessionId !== request.sessionId
    || value.runId !== request.runId
    || value.kernelCatalogSnapshotRef !== request.kernelCatalogSnapshotRef
    || value.released !== true
    || typeof value.alreadyReleased !== 'boolean'
  ) throw new Error('kernel_tool_catalog_released_invalid');
  return Object.freeze({
    kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
    alreadyReleased: value.alreadyReleased,
  });
}

async function* decodeProviderEvents(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  signal: AbortSignal,
  attemptId?: string,
): AsyncIterable<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let exhausted = false;
  let primaryFailure: unknown;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('provider_cancelled');
      const chunk = await reader.read();
      if (chunk.done) {
        exhausted = true;
        buffer += decoder.decode();
        if (buffer.trim()) throw new LoopFailure('provider_sse_truncated', 'Provider SSE 帧未完整结束。');
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/u);
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/u);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        if (!frame.trim()) continue;
        const event = decodeProviderFrame(frame);
        if (event.requestId !== requestId) throw new LoopFailure('provider_request_identity_mismatch', 'Provider 请求身份不一致。');
        if (attemptId && event.providerAttemptId !== attemptId && !(event.type === 'failed' && event.providerAttemptId === undefined)) throw new LoopFailure('provider_attempt_identity_mismatch', 'Provider 尝试身份不一致。');
        yield event;
      }
    }
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { if (!exhausted) await reader.cancel(); }
    catch (cleanupError) {
      if (cleanupError === primaryFailure) throw primaryFailure;
      if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, cleanupError], errorFact(primaryFailure).message);
      throw cleanupError;
    } finally { reader.releaseLock(); }
  }
}

function decodeProviderFrame(frame: string): ProviderEvent {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) throw new LoopFailure('provider_sse_data_missing', 'Provider SSE 帧缺少 data。');
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new LoopFailure('provider_event_json_invalid', 'Provider SSE data 不是有效的 JSON。'); }
  if (!isExactRecord(value, ['schemaVersion', 'requestId', 'type', 'data'], ['providerAttemptId'])) {
    throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
  }
  if (
    value.schemaVersion !== 'deepcode.provider-event'
    || !isNonEmptyText(value.requestId)
    || !isRecord(value.data)
  ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
  switch (value.type) {
    case 'tool.call.delta': {
      const fields = ['callIndex', 'callId', 'name', 'argumentsDelta'];
      if (Object.hasOwn(value.data, 'outputIndex')) fields.push('outputIndex');
      if (!isExactRecord(value.data, fields)
        || !Number.isSafeInteger(value.data.callIndex) || Number(value.data.callIndex) < 0
        || !isNonEmptyText(value.data.callId) || !isNonEmptyText(value.data.name)
        || typeof value.data.argumentsDelta !== 'string'
        || value.data.outputIndex !== undefined && (!Number.isSafeInteger(value.data.outputIndex) || Number(value.data.outputIndex) < 0)) {
        throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      }
      break;
    }
    case 'text.delta':
    case 'reasoning.delta':
      {
        const fields = ['text'];
        if (Object.hasOwn(value.data, 'outputIndex')) fields.push('outputIndex');
        if (value.type === 'reasoning.delta' && Object.hasOwn(value.data, 'kind')) {
          if (!['text', 'summary'].includes(String(value.data.kind))) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
          fields.push('kind');
        }
        if (
          !isExactRecord(value.data, fields)
          || typeof value.data.text !== 'string'
          || value.data.outputIndex !== undefined
            && (!Number.isSafeInteger(value.data.outputIndex) || Number(value.data.outputIndex) < 0)
        ) {
          throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
        }
      }
      break;
    case 'output.item.completed':
      if (
        !isExactRecord(value.data, ['outputIndex', 'item'])
        || !Number.isSafeInteger(value.data.outputIndex)
        || Number(value.data.outputIndex) < 0
        || !isRecord(value.data.item)
        || !['message', 'reasoning', 'function_call', 'web_search_call']
          .includes(String(value.data.item.type))
      ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      break;
    case 'assistant.message':
      {
        const fields = ['messageId', 'content'];
        if (Object.hasOwn(value.data, 'reasoningContent')) fields.push('reasoningContent');
        if (Object.hasOwn(value.data, 'reasoningSignature')) fields.push('reasoningSignature');
      if (
        !isExactRecord(value.data, fields)
        || !isNonEmptyText(value.data.messageId)
        || typeof value.data.content !== 'string'
        || value.data.reasoningContent !== undefined
          && !isNonEmptyText(value.data.reasoningContent)
        || value.data.reasoningSignature !== undefined
          && !isNonEmptyText(value.data.reasoningSignature)
        || value.data.reasoningSignature !== undefined
          && value.data.reasoningContent === undefined
      ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      break;
      }
    case 'tool.call':
      if (
        !(isExactRecord(value.data, ['callId', 'name', 'input']) && isRecord(value.data.input)
          || isExactRecord(value.data, ['callId', 'name', 'arguments']) && typeof value.data.arguments === 'string')
        || !isNonEmptyText(value.data.callId)
        || !isNonEmptyText(value.data.name)
      ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      break;
    case 'hosted.web-search.completed':
      if (
        !isExactRecord(value.data, ['item'])
        || !isRecord(value.data.item)
        || value.data.item.type !== 'web_search_call'
        || !isNonEmptyText(value.data.item.id)
        || value.data.item.status !== 'completed'
          && value.data.item.status !== 'failed'
        || value.data.item.action !== undefined && !isRecord(value.data.item.action)
      ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      break;
    case 'completed':
      break;
    case 'failed':
      if (
        !isLocalAgentErrorValue(value.data)
        || !isNonEmptyText(value.data.code)
        || !isNonEmptyText(value.data.message)
      ) throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
      break;
    default:
      throw new LoopFailure('provider_event_invalid', 'Provider 事件字段不符合协议。');
  }
  return value as unknown as ProviderEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isRecord(value)
    && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
