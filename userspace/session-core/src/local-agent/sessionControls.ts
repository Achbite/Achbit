import type {
  AgentCapabilities,
  AgentOperation,
  SessionOperation,
  ExecutionPlanStep,
  InteractionOption,
  JsonObject,
  ModelInteractionRequest,
  PlanOperation,
  ProviderToolDefinition,
  TodoItem,
} from '@deepcode/protocol';
import {
  isLlmReasoningEffort,
  decodeAgentContribution,
  decodeAgentRecipe,
  validatePermissionPatches,
  LLM_REASONING_EFFORTS,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT,
  SESSION_CONTROL_AGENT,
  SESSION_CONTROL_SESSION,
} from '@deepcode/protocol';

export interface SessionControlWireNames {
  interactionRequest: string;
  planPublish: string;
  todoUpdate: string;
  pluginActivate: string;
  artifactPresent: string;
}

export function confirmedPlanExecutionInstruction(): string {
  return 'The Plan is confirmed. Proceed within its approved scope, which remains valid for this run.';
}

export function sessionControlInstructions(
  names: SessionControlWireNames,
  hasWorkspaceBindings = true,
  hasPluginDiscovery = false,
  optionalTools?: readonly string[],
  planEnabled = true,
): string {
  const decisions = ` Ask early for missing facts or required decisions with ${names.interactionRequest}. Use mode=continue while independent work can proceed; use mode=wait otherwise. Confirmations always wait. An unanswered question stays pending: proceed only on independent work, and ask it once. Put alternatives in options with stable IDs and concise labels; explain context in prompt. Tool execution approval is separate.`;
  const plugins = hasPluginDiscovery ? ` Use CLI or MCP for program operations and GUI tools for interface actions or visual confirmation; combine them as needed. Capture screenshots when visual evidence is needed. Discover capabilities with a short product or capability query, activate relevant results with ${names.pluginActivate} alone, then use their declared tools. Activation and execution permission are separate.` : '';
  const delivery = ` Use ${names.artifactPresent} to deliver requested results or review materials. Prepare a file with artifact.prepare or register a live URL with artifact.preview first. Keep temporary scripts, logs and observation images intermediate unless requested. Update a delivered resource using its deliveryId and cite the returned URI; use Markdown images for visual review. Archiving alone does not deliver a resource, and presentation does not resend pixels to the model.`;
  const progress = ` Use ${names.todoUpdate} for meaningful progress on multi-step work. Keep a few outcome-oriented phases and update the complete list when status changes, optionally alongside ordinary calls. Simple tasks and unchanged status need no update. Todo tracks progress, not permission or completion gates; leave unfinished work open.`;
  const selectedDelivery = optionalTools && !optionalTools.includes(SESSION_CONTROL_ARTIFACT_PRESENT) ? '' : delivery;
  const selectedProgress = optionalTools && !optionalTools.includes(SESSION_CONTROL_TODO_UPDATE) ? '' : progress;
  if (!hasWorkspaceBindings) {
    return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${names.interactionRequest} must be the only call in its turn.${decisions}${plugins}${selectedDelivery}`;
  }
  const isolatedControls = planEnabled ? `${names.interactionRequest} and ${names.planPublish} must each be the only call in their turn.` : `${names.interactionRequest} must be the only call in its turn.`;
  return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${isolatedControls} Use a logical workspace handle from the Session binding list and workspace-relative paths; never invent or expose a workspaceId.${selectedProgress}${decisions}${plugins}${selectedDelivery}`;
}

const INTERACTION_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'prompt', 'allowFreeform'],
  properties: {
    mode: { type: 'string', enum: ['wait', 'continue'], description: 'continue asks a question without pausing independent work. Unanswered questions still prevent final run completion. Confirmations must wait. Omit for wait.' },
    kind: { type: 'string', enum: ['question', 'confirmation'] },
    prompt: { type: 'string', minLength: 1, description: 'Markdown prose. Use actual paragraph breaks, not literal backslash-n text.' },
    options: {
      type: 'array',
      maxItems: 8,
      description: 'Clickable choices. Supply these whenever offering alternatives; do not encode choices only as numbered prose in prompt. Omit for a freeform-only question.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
    allowFreeform: { type: 'boolean' },
  },
};

const PLAN_OPERATION_SCHEMA: JsonObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'target'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: {
          type: 'string',
          enum: ['fs.write', 'fs.edit', 'document.render', 'browser.capture'],
        },
        target: { type: 'string', minLength: 1 },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'], description: 'Omit or use file for one file. directoryTree explicitly permits creating and editing descendant files; it does not permit deletion.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'target', 'targetKind'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['fs.delete'] },
        target: { type: 'string', minLength: 1 },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'writablePaths'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['bash', 'powershell'] },
        command: { type: 'string', minLength: 1, maxLength: 16_384 },
        writablePaths: {
          type: 'array', minItems: 1,
          description: 'Approved test/output directories, including their contents. Project files stay read-only outside these directories. Command is an example, not an authorization lock.',
          items: { type: 'object', additionalProperties: false, required: ['path', 'kind'], properties: {
            path: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['directory'] },
          } },
        },
        terminal: {
          type: 'object',
          additionalProperties: false,
          required: ['stdin'],
          properties: {
            stdin: { type: 'string', maxLength: 65_536 },
          },
        },
      },
    },
  ],
};

const PLAN_TITLE_SCHEMA: JsonObject = {
  type: 'string', minLength: 1, maxLength: 240,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?$(?![\\s\\S])',
  description: 'Single-line inline Markdown title, at most 240 characters. No leading/trailing whitespace, line breaks or control characters. Put paragraphs in summary/details.',
};

const PLAN_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'mutationManifest'],
  anyOf: [{ required: ['title', 'steps'] }, { required: ['mode'] }],
  properties: {
    mode: { type: 'string', enum: ['extendScope'], description: 'Add scope to the current confirmed Plan using summary (reason) and mutationManifest (additions); omit title and steps. Existing phases and verification are preserved.' },
    title: PLAN_TITLE_SCHEMA,
    summary: { type: 'string', minLength: 1, description: 'Markdown prose. Use actual paragraph breaks, not literal backslash-n text.' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stepId', 'title', 'details'],
        properties: {
          stepId: { type: 'string', minLength: 1, maxLength: 128 },
          title: PLAN_TITLE_SCHEMA,
          details: { type: 'string', minLength: 1 },
          verification: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    mutationManifest: {
      type: 'array',
      items: PLAN_OPERATION_SCHEMA,
    },
  },
};

export type SessionControlCall =
  | { kind: 'agent'; callId: string; operation: AgentOperation }
  | { kind: 'session'; callId: string; operation: SessionOperation }
  | { kind: 'artifactPresent'; callId: string; items: ArtifactPresentationInput[] }
  | { kind: 'pluginActivate'; callId: string; pluginUris: string[] }
  | {
      kind: 'todoUpdate';
      callId: string;
      items: TodoItem[];
    }
  | {
      kind: 'interaction';
      callId: string;
      request: ModelInteractionRequest;
    }
  | {
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft | PlanScopeExtension;
    };

export interface ArtifactPresentationInput { artifactId: string; label: string; deliveryId?: string }

export interface PlanPublicationDraft {
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  mutationManifest: PlanOperation[];
}

export interface PlanScopeExtension {
  mode: 'extendScope';
  summary: string;
  mutationManifest: PlanOperation[];
}

const agentTurnPolicies = {
  models: 'tools',
  spawn: 'agents',
  assign: 'agents',
  send: 'agents',
  compact: 'exclusive',
  wait: 'exclusive',
  cancel: 'exclusive',
  close: 'exclusive',
} as const satisfies Record<AgentOperation['action'], 'tools' | 'agents' | 'exclusive'>;

export function agentTurnPolicy(input: Record<string, unknown>): 'tools' | 'agents' | 'exclusive' {
  if (typeof input.action !== 'string' || !Object.hasOwn(agentTurnPolicies, input.action)) return 'exclusive';
  if (input.action === 'spawn' && input.delivery !== 'async') return 'exclusive';
  return agentTurnPolicies[input.action as AgentOperation['action']];
}

const agentTurnGuidance = Object.entries(agentTurnPolicies).reduce<Record<string, string[]>>((groups, [action, policy]) => {
  (groups[policy] ??= []).push(action === 'spawn' ? 'spawn(delivery=async)' : action);
  return groups;
}, {});
const agentTurnInstruction = ` ${agentTurnGuidance.tools!.join(', ')} may share a turn with independent ordinary tools and at most one todo.update. Available ${agentTurnGuidance.agents!.join(', ')} operations may share a turn only with other agent calls and at most one todo.update. Submit ${agentTurnGuidance.exclusive!.join(', ')} and spawn(delivery=wait) alone.`;

/** Detailed contracts are returned by discovery, leaving the provider tool prefix stable. */
export function agentOperationDefinitions({ messaging, delegation, continuation }: AgentCapabilities,
  options: { fullConfiguration?: boolean; presetIds?: string[]; profileIds?: string[]; canSpawn?: boolean; allowChildDelegation?: boolean; coordinator?: boolean } = {}): JsonObject[] {
  const operation = (action: string, description: string, properties: JsonObject = {}, required: string[] = []): JsonObject => ({
    action, description, inputSchema: { type: 'object', additionalProperties: false,
      required: ['action', ...required], properties: { action: { type: 'string', const: action }, ...properties } },
  });
  const id = { type: 'string', minLength: 1 };
  return [
    operation('models', 'Discover available operations and model profiles.'),
    ...(delegation && options.canSpawn !== false ? [operation('spawn', 'Create a child agent. Async overlaps work; wait pauses for a result or message. A final answer ends the child task and releases execution; continuation retains history, not an active wait. Context budget and compaction rules inherit from the parent; override only when useful. doc.read model-services.md has examples.', {
      task: { ...id, description: 'Give the child necessary context, a bounded goal, scope and expected evidence. It receives this task, not the parent conversation.' }, name: id, delivery: { type: 'string', enum: ['wait', 'async'], description: 'Use async to overlap independent work; wait when the next step depends on the result.' },
      preset: { type: 'string', enum: options.presetIds ?? ['analysis', 'collaboration'], description: 'analysis contacts its task owner; collaboration also contacts teammates. Neither delegates further by default. Both retain the instance. Combine capabilities and Loop choices; a preset does not define a fixed agent type.' },
      capabilities: { type: 'object', additionalProperties: false, properties: {
        messaging: { enum: messaging === true ? [false, 'parent', true] : messaging === 'parent' ? [false, 'parent'] : [false], description: 'false: no messages; parent: only the parent; true: the related team.' },
        continuation: { type: 'boolean', ...(!continuation ? { const: false } : {}), description: 'Accept follow-up tasks in the same Session.' },
        delegation: { type: 'boolean', ...(options.allowChildDelegation === false ? { const: false } : {}), description: 'Create child agents.' },
      } },
      profileId: { ...id, ...(options.profileIds ? { enum: options.profileIds } : {}), description: 'Use a model allowed by the returned preset rules; omit to follow the selected preset.' },
      ...(options.fullConfiguration ? { reasoningEffort: { type: 'string', enum: [...LLM_REASONING_EFFORTS], description: 'Override using an effort supported by the selected model.' },
        context: { type: 'object', description: 'Optional context override. journal.parameters.maxTokens caps context including output reserve; omit to inherit.' } } : {}),
      loop: { type: 'object', additionalProperties: false, properties: {
        controls: { type: 'object', description: 'A returned controls contribution id and its supported parameters.' },
        compaction: { type: 'object', description: 'Optional compaction override. summary.parameters supports enabled, thresholdTokens and pressureRatio; omitted values inherit.' },
      } },
      permissions: { type: 'object', description: 'Optional restrictions of inherited agent.permissions settings. Cannot grant new authority or approve a Plan.' },
      runner: { type: 'object', description: 'Select an installed Loop driver from runners by id and parameters. Presets are defaults, not fixed agent types.' },
      permissionPolicy: { type: 'object', description: 'Select a returned policy by id and parameters; only narrow parent authority.' },
      workspaceSandbox: { type: 'object', additionalProperties: false, required: ['backendId'], properties: {
        backendId: { type: 'string', description: 'platform-default or the observed available backend.' },
        requireIsolatedProcesses: { type: 'boolean', description: 'Require usable Shell isolation and prohibit Host/external execution routes.' },
      } },
    }, ['task', 'name', 'delivery'])] : []),
    ...(messaging || delegation ? [operation('send', 'Send a message to an active permitted contact. Delivery records the message, not agreement. Does not start tasks; ask the coordinator to assign an idle member.', { agentId: id, text: id }, ['agentId', 'text'])] : []),
    ...(delegation && options.coordinator !== false && options.canSpawn !== false ? [
      operation('assign', 'Coordinator only: asynchronously assign a new task to an idle retained agent, preserving its Session, model and configuration. Use send for an active task.',
        { agentId: id, task: { ...id, description: 'Necessary context, scope and expected evidence for the new task.' } }, ['agentId', 'task']),
    ] : []),
    ...(delegation ? [
      operation('compact', 'Request child context compaction at its next safe model boundary, or before its next task if idle. Does not start work or interrupt tools.',
        { agentId: id, focus: { ...id, description: 'Optional focus for preserving relevant existing facts.' } }, ['agentId']),
      operation('wait', 'Pause for child results or incoming messages. Returns completed task IDs; result content is delivered separately once.', {
        taskIds: { type: 'array', minItems: 1, uniqueItems: true, items: id, description: 'Omit to wait for current tasks.' },
      }),
      operation('cancel', 'Cancel a task owned by your current run or its active descendants; not a peer or ancestor task.', { taskId: id }, ['taskId']),
      ...(options.coordinator !== false ? [operation('close', 'Coordinator only: close an idle retained agent you will not reuse. Active work in it or its descendants is rejected without cancellation; wait for final task results or explicitly cancel first. Completed tasks already release execution.', { agentId: id }, ['agentId'])] : []),
    ] : []),
  ];
}

export function sessionControlToolDefinitions(capabilities?: AgentCapabilities): readonly ProviderToolDefinition[] {
  return [
    {
      name: SESSION_CONTROL_SESSION,
      description: 'Schedule a follow-up or wait for input in this task. Call action=describe for the exact operations. Submit alone.',
      inputSchema: { type: 'object', additionalProperties: true, required: ['action'], properties: {
        action: { type: 'string', minLength: 1 },
      } },
    },
    {
      name: SESSION_CONTROL_AGENT,
      description: (capabilities && !capabilities.delegation
        ? capabilities.messaging === 'parent' ? 'Contact your current task owner. Call action=models for contacts and operations. Send findings, questions or scope needs; messages do not grant permissions or start tasks. Use session wait for a needed reply; return a final answer when done. Retaining the Session needs no active wait.'
          : 'Coordinate directly with teammates. Agree on shared interfaces and one writer per shared file; send unresolved disagreements or scope needs to the coordinator. Messages are not agreement or permission. Use session wait for needed replies; finish with a final answer and evidence, not an indefinite wait. Call action=models for contacts and operations. Multiple messages may share a turn.'
        : 'When enabled, proactively delegate independent work asynchronously with necessary context, scope and expected evidence. No user reminder is needed. Use collaboration for communicating teammates; give shared files one writer, resolve disagreements and verify results. Await final task results; completed tasks release execution without close. Keep short or tightly coupled work direct and continue independent work. Call action=models for operations and configuration. Disabling blocks new tasks, not existing work.') + agentTurnInstruction,
      inputSchema: { type: 'object', additionalProperties: true, required: ['action'], properties: {
        action: { type: 'string', minLength: 1, description: 'models discovers the operation contracts; other actions use their returned arguments.' },
      } },
    },
    {
      name: SESSION_CONTROL_ARTIFACT_PRESENT,
      description: 'Deliver selected archived resources as requested results or review materials. Supply exact artifactIds from tools, artifact.prepare or artifact.preview; reuse deliveryId for updates. Returns references for final prose. Intermediate logs, scripts and observations stay internal unless selected for delivery. Submit alone; items can include all deliveries. Presentation does not resend image pixels to the model.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['items'], properties: {
        items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
          required: ['artifactId', 'label'], properties: {
            artifactId: {type:'string',minLength:1}, label: {type:'string',minLength:1}, deliveryId: {type:'string',minLength:1},
          } } },
      } },
    },
    {
      name: SESSION_CONTROL_PLUGIN_ACTIVATE,
      description: 'Load needed installed, enabled plugins using exact URIs from plugin search. Tools and instructions become available in the next request of this run. User mentions are optional and remain separate. Activation leaves installation, settings and execution permissions unchanged. Submit alone.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pluginUris'], properties: {
        pluginUris: { type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', pattern: '^plugin://[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$' } },
      } },
    },
    {
      name: SESSION_CONTROL_INTERACTION_REQUEST,
      description: 'Ask the user for missing information or a required decision. Use mode to wait for the answer or continue independent work.',
      inputSchema: structuredClone(INTERACTION_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_PUBLISH,
      description: 'Publish a Plan for changes needing new authorization; use extendScope before expanding confirmed scope. Reuse confirmed scope for related edits. Confirmation follows current settings; a Kernel scope rejection still requires the missing authorization. Keep outcome-oriented phases. A full revision replaces the Plan and includes the complete manifest. For Shell, writablePaths defines write scope; command is an optional example. Todo is independent.',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_TODO_UPDATE,
      description: 'Replace the complete ordered task list when progress changes. Use a few meaningful phases with pending, inProgress, completed or blocked status; an empty list clears it. Independent of Plan, approval and record IDs. Unfinished items stay open and do not prevent answering. At most one update per turn; ordinary calls may accompany it.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: { items: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['text', 'status'],
          properties: {
            text: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['pending', 'inProgress', 'completed', 'blocked'] },
          },
        } } },
      },
    },
  ];
}

export function decodeSessionControlCall(
  callId: string,
  name: string,
  input: JsonObject,
): SessionControlCall | null {
  if (
    name !== SESSION_CONTROL_INTERACTION_REQUEST
    && name !== SESSION_CONTROL_PLAN_PUBLISH
    && name !== SESSION_CONTROL_TODO_UPDATE
    && name !== SESSION_CONTROL_PLUGIN_ACTIVATE
    && name !== SESSION_CONTROL_ARTIFACT_PRESENT
    && name !== SESSION_CONTROL_AGENT
    && name !== SESSION_CONTROL_SESSION
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_SESSION) {
    let operation: SessionOperation;
    if (input.action === 'describe') { assertExactKeys(input, ['action']); operation = { action: 'describe' }; }
    else if (input.action === 'schedule' || input.action === 'wait') {
      const schedule = input.action === 'schedule';
      assertExactKeys(input, schedule ? ['action', 'afterSeconds', 'text'] : ['action', 'timeoutSeconds'], schedule ? [] : ['timeoutSeconds']);
      const seconds = schedule ? input.afterSeconds : input.timeoutSeconds;
      if ((schedule || seconds !== undefined) && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 2147483)) {
        throw new SessionControlError('session_delay_invalid', 'Seconds must be positive and fit a native timer (at most 2147483).');
      }
      operation = schedule ? { action: 'schedule', afterSeconds: seconds as number, text: requiredText(input.text, 'text') }
        : { action: 'wait', ...(seconds === undefined ? {} : { timeoutSeconds: seconds as number }) };
    } else if (input.action === 'cancelSchedule') {
      assertExactKeys(input, ['action', 'scheduleId']); operation = { action: 'cancelSchedule', scheduleId: requiredIdentifier(input.scheduleId, 'scheduleId') };
    } else throw new SessionControlError('session_action_invalid', 'Call action=describe for the operation contracts.');
    return { kind: 'session', callId: canonicalCallId, operation };
  }
  if (name === SESSION_CONTROL_AGENT) {
    try {
      return { kind: 'agent', callId: canonicalCallId, operation: decodeAgentOperation(input) };
    } catch (error) {
      if (error instanceof SessionControlError) throw error;
      // Shared recipe/permission decoders validate model input here, before any Agent execution.
      throw new SessionControlError('agent_configuration_invalid', error instanceof Error ? error.message : String(error));
    }
  }
  if (name === SESSION_CONTROL_ARTIFACT_PRESENT) {
    assertExactKeys(input, ['items']);
    if (!Array.isArray(input.items) || !input.items.length) throw new SessionControlError('artifact_presentation_invalid', 'items must select at least one resource.');
    const items = input.items.map((item): ArtifactPresentationInput => {
      if (!isRecord(item)) throw new SessionControlError('artifact_presentation_invalid', 'Each delivery must be an object.');
      assertExactKeys(item, ['artifactId', 'label', 'deliveryId'], ['deliveryId']);
      return { artifactId: requiredIdentifier(item.artifactId, 'artifactId'), label: requiredText(item.label, 'label'),
        ...(item.deliveryId === undefined ? {} : {deliveryId: requiredIdentifier(item.deliveryId, 'deliveryId')}) };
    });
    return {kind:'artifactPresent', callId:canonicalCallId, items};
  }
  if (name === SESSION_CONTROL_PLUGIN_ACTIVATE) {
    assertExactKeys(input, ['pluginUris']);
    if (!Array.isArray(input.pluginUris) || input.pluginUris.length < 1
      || input.pluginUris.some(uri => typeof uri !== 'string' || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(uri))
      || new Set(input.pluginUris).size !== input.pluginUris.length) {
      throw new SessionControlError('plugin_selection_invalid', 'pluginUris 必须包含 至少一个不重复的已发现插件 URI。');
    }
    return { kind: 'pluginActivate', callId: canonicalCallId, pluginUris: input.pluginUris as string[] };
  }
  if (name === SESSION_CONTROL_TODO_UPDATE) {
    assertExactKeys(input, ['items']);
    if (!Array.isArray(input.items)) {
      throw new SessionControlError('todo_update_invalid', 'items must be the complete ordered task list.');
    }
    const items = input.items.map((item): TodoItem => {
      if (!isRecord(item)) throw new SessionControlError('todo_update_invalid', 'Each task must be an object.');
      assertExactKeys(item, ['text', 'status']);
      if (typeof item.status !== 'string' || !['pending', 'inProgress', 'completed', 'blocked'].includes(item.status)) {
        throw new SessionControlError('todo_update_invalid', 'Task status must be pending, inProgress, completed or blocked.');
      }
      return { text: requiredText(item.text, 'text'), status: item.status as TodoItem['status'] };
    });
    return { kind: 'todoUpdate', callId: canonicalCallId, items };
  }
  if (name === SESSION_CONTROL_INTERACTION_REQUEST) {
    return {
      kind: 'interaction',
      callId: canonicalCallId,
      request: decodeInteraction(input),
    };
  }
  return {
    kind: 'plan',
    callId: canonicalCallId,
    draft: decodePlan(input),
  };
}

function decodeAgentOperation(input: JsonObject): AgentOperation {
  switch (input.action) {
    case 'models':
      assertExactKeys(input, ['action']);
      return { action: 'models' };
    case 'spawn': {
      assertExactKeys(input, ['action', 'task', 'name', 'delivery', 'profileId', 'reasoningEffort', 'preset', 'capabilities', 'loop', 'context', 'permissions', 'runner', 'permissionPolicy', 'workspaceSandbox'],
        ['profileId', 'reasoningEffort', 'preset', 'capabilities', 'loop', 'context', 'permissions', 'runner', 'permissionPolicy', 'workspaceSandbox']);
      if (input.preset !== undefined) requiredText(input.preset, 'preset');
      if (input.capabilities !== undefined && ((!input.capabilities || typeof input.capabilities !== 'object' || Array.isArray(input.capabilities))
        || Object.entries(input.capabilities).some(([key, value]) => !['messaging', 'continuation', 'delegation'].includes(key)
          || typeof value !== 'boolean' && !(key === 'messaging' && value === 'parent')))) {
        throw new SessionControlError('agent_capabilities_invalid', 'continuation/delegation accept booleans; messaging accepts false, parent or true.');
      }
      if (input.delivery !== 'wait' && input.delivery !== 'async') {
        throw new SessionControlError('agent_delivery_invalid', 'delivery 必须是 wait 或 async。');
      }
      if (input.reasoningEffort !== undefined && !isLlmReasoningEffort(input.reasoningEffort)) {
        throw new SessionControlError('agent_reasoning_effort_invalid', 'reasoningEffort 必须是有效推理强度。');
      }
      let loop: Extract<AgentOperation, { action: 'spawn' }>['loop'];
      if (input.loop !== undefined) {
        if (!isRecord(input.loop) || Object.keys(input.loop).some(key => key !== 'controls' && key !== 'compaction')) {
          throw new SessionControlError('agent_loop_invalid', 'Use the returned Loop contribution choices.');
        }
        loop = Object.fromEntries(Object.entries(input.loop).map(([key, value]) => [key, decodeAgentContribution(value)]));
      }
      if (input.permissions !== undefined) validatePermissionPatches(input.permissions);
      const components = decodeAgentRecipe(Object.fromEntries(['runner', 'permissionPolicy', 'workspaceSandbox']
        .filter(key => input[key] !== undefined).map(key => [key, input[key]])));
      return { action: input.action, task: requiredText(input.task, 'task'), name: requiredText(input.name, 'name'), delivery: input.delivery,
        ...components,
        ...(input.preset !== undefined ? { preset: input.preset as string } : {}),
        ...(input.capabilities !== undefined ? { capabilities: { ...input.capabilities } as Partial<AgentCapabilities> } : {}),
        ...(input.profileId !== undefined ? { profileId: requiredText(input.profileId, 'profileId') } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(loop ? { loop } : {}),
        ...(input.context !== undefined ? { context: decodeAgentContribution(input.context) } : {}),
        ...(input.permissions !== undefined ? { permissions: structuredClone(input.permissions) } : {}) };
    }
    case 'send':
      assertExactKeys(input, ['action', 'agentId', 'text']);
      return { action: 'send', agentId: requiredIdentifier(input.agentId, 'agentId'), text: requiredText(input.text, 'text') };
    case 'compact':
      assertExactKeys(input, ['action', 'agentId', 'focus'], ['focus']);
      return { action: 'compact', agentId: requiredIdentifier(input.agentId, 'agentId'),
        ...(input.focus !== undefined ? { focus: requiredText(input.focus, 'focus') } : {}) };
    case 'assign':
      assertExactKeys(input, ['action', 'agentId', 'task']);
      return { action: 'assign', agentId: requiredIdentifier(input.agentId, 'agentId'), task: requiredText(input.task, 'task') };
    case 'wait': {
      assertExactKeys(input, ['action', 'taskIds'], ['taskIds']);
      if (input.taskIds === undefined) return { action: 'wait' };
      if (!Array.isArray(input.taskIds) || !input.taskIds.length) {
        throw new SessionControlError('agent_tasks_invalid', 'taskIds 必须是非空任务标识数组，或省略以等待当前任务。');
      }
      const taskIds = input.taskIds.map(value => requiredIdentifier(value, 'taskIds'));
      if (new Set(taskIds).size !== taskIds.length) throw new SessionControlError('agent_tasks_invalid', 'taskIds 不得重复。');
      return { action: 'wait', taskIds };
    }
    case 'cancel':
      assertExactKeys(input, ['action', 'taskId']);
      return { action: 'cancel', taskId: requiredIdentifier(input.taskId, 'taskId') };
    case 'close':
      assertExactKeys(input, ['action', 'agentId']);
      return { action: 'close', agentId: requiredIdentifier(input.agentId, 'agentId') };
    default: throw new SessionControlError('agent_action_invalid', '不支持的 agent action。');
  }
}

function decodeInteraction(value: Record<string, unknown>): ModelInteractionRequest {
  assertExactKeys(value, ['kind', 'prompt', 'options', 'allowFreeform', 'mode'], ['options', 'mode']);
  if (value.mode !== undefined && value.mode !== 'wait' && value.mode !== 'continue'
    || value.mode === 'continue' && value.kind !== 'question') {
    throw new SessionControlError('session_control_interaction_mode_invalid', '只有澄清问题可以选择继续独立工作；确认必须等待。');
  }
  if (value.kind !== 'question' && value.kind !== 'confirmation') {
    throw new SessionControlError(
      'session_control_interaction_kind_invalid',
      'interaction.request kind 必须是 question 或 confirmation。',
    );
  }
  if (typeof value.allowFreeform !== 'boolean') {
    throw new SessionControlError(
      'session_control_interaction_freeform_invalid',
      'interaction.request 必须明确 allowFreeform。',
    );
  }
  const request: ModelInteractionRequest = {
    ...(value.mode ? { mode: value.mode } : {}),
    kind: value.kind,
    prompt: requiredText(value.prompt, 'prompt'),
    allowFreeform: value.allowFreeform,
    ...(value.options === undefined ? {} : { options: decodeInteractionOptions(value.options) }),
  };
  if (!request.allowFreeform && (request.options?.length ?? 0) === 0) {
    throw new SessionControlError(
      'session_control_interaction_unanswerable',
      '不允许自由输入的 interaction.request 必须提供选项。',
    );
  }
  return request;
}

function decodePlan(value: Record<string, unknown>): PlanPublicationDraft | PlanScopeExtension {
  if (value.mode === 'extendScope') {
    assertExactKeys(value, ['mode', 'summary', 'mutationManifest'], [], 'plan scope extension');
    return { mode: 'extendScope', summary: requiredText(value.summary, 'summary'), mutationManifest: decodeManifest(value.mutationManifest) };
  }
  assertExactKeys(value, ['title', 'summary', 'steps', 'mutationManifest'], [], 'plan');
  if (!Array.isArray(value.steps) || value.steps.length < 1) {
    throw new SessionControlError(
      'session_control_plan_steps_invalid',
      'plan.publish steps 必须包含至少一个阶段。',
    );
  }
  const stepIds = new Set<string>();
  const title = requiredDisplayText(value.title, 'title', 240);
  const summary = requiredText(value.summary, 'summary');
  const steps = value.steps.map((candidate, index) => decodePlanStep(candidate, stepIds, index));
  return { title, summary, steps, mutationManifest: decodeManifest(value.mutationManifest) };
}

function decodeManifest(value: unknown): PlanOperation[] {
  if (!Array.isArray(value)) {
    throw new SessionControlError('session_control_plan_manifest_invalid', 'plan.publish mutationManifest 必须是数组。');
  }
  const mutationManifest: PlanOperation[] = [];
  const shapeErrors: string[] = [];
  for (const [index, candidate] of value.entries()) {
    try { mutationManifest.push(decodePlanOperation(candidate, index)); }
    catch (error) {
      if (!(error instanceof SessionControlError) || error.code !== 'session_control_shape_invalid') throw error;
      shapeErrors.push(error.message);
    }
  }
  // Return every invalid manifest shape in the same correction result.
  // No partially decoded plan is published.
  if (shapeErrors.length) throw new SessionControlError('session_control_shape_invalid', shapeErrors.join('\n'));
  return mutationManifest;
}

function decodePlanStep(value: unknown, seen: Set<string>, index: number): ExecutionPlanStep {
  if (!isRecord(value)) {
    throw new SessionControlError('session_control_plan_step_invalid', 'Plan step 必须是对象。');
  }
  assertExactKeys(value, ['stepId', 'title', 'details', 'verification'], ['verification'], `steps[${index}]`);
  const stepId = requiredIdentifier(value.stepId, 'stepId');
  if (seen.has(stepId)) {
    throw new SessionControlError(
      'session_control_plan_step_duplicate',
      'Plan stepId 不能重复。',
    );
  }
  seen.add(stepId);
  if (
    value.verification !== undefined
    && !Array.isArray(value.verification)
  ) {
    throw new SessionControlError(
      'session_control_plan_verification_invalid',
      'Plan step verification 必须是字符串数组。',
    );
  }
  return {
    stepId,
    title: requiredDisplayText(value.title, 'title', 240),
    details: requiredText(value.details, 'details'),
    ...(value.verification === undefined
      ? {}
      : {
          verification: value.verification.map((entry, index) => (
            requiredText(entry, `verification[${index}]`)
          )),
        }),
  };
}

function decodePlanOperation(value: unknown, index: number): PlanOperation {
  if (!isRecord(value)) {
    throw new SessionControlError(
      'session_control_plan_operation_invalid',
      'Plan operation 必须是对象。',
    );
  }
  const operation = value.operation;
  const workspaceId = requiredIdentifier(value.workspaceId, 'workspaceId');
  if (operation === 'bash' || operation === 'powershell') {
    assertExactKeys(
      value,
      ['workspaceId', 'operation', 'command', 'terminal', 'writablePaths'],
      ['command', 'terminal'],
      `mutationManifest[${index}]`,
    );
    const command = value.command === undefined ? undefined : requiredText(value.command, 'command');
    if (command !== undefined && command.length > 16_384) {
      throw new SessionControlError('session_control_plan_shell_invalid', 'Shell Plan command 不得超过 16384 个字符。');
    }
    const terminal = value.terminal === undefined ? undefined : decodeTerminalInput(value.terminal);
    if (!Array.isArray(value.writablePaths) || !value.writablePaths.length) {
      throw new SessionControlError('session_control_plan_shell_invalid', 'writablePaths 必须包含至少一个测试或输出目录。');
    }
    const writablePaths = value.writablePaths.map((entry) => {
      if (!isRecord(entry) || entry.kind !== 'directory') {
        throw new SessionControlError('session_control_plan_shell_invalid', 'writablePaths 项必须包含 path 和 kind=directory；项目文件编辑使用文件工具。');
      }
      assertExactKeys(entry, ['path', 'kind'], [], 'writablePaths');
      const path = normalizedTarget(entry.path);
      return { path, kind: 'directory' as const };
    });
    return {
      workspaceId, operation, writablePaths,
      ...(command === undefined ? {} : { command }),
      ...(terminal ? { terminal } : {}),
    };
  }

  const target = normalizedTarget(value.target);
  if (operation === 'fs.delete') {
    assertExactKeys(value, ['workspaceId', 'operation', 'target', 'targetKind'], [], `mutationManifest[${index}]`);
    if (value.targetKind !== 'file' && value.targetKind !== 'directoryTree') {
      throw new SessionControlError(
        'session_control_plan_target_kind_invalid',
        'fs.delete 必须明确 targetKind=file 或 directoryTree。',
      );
    }
    return { workspaceId, operation, target, targetKind: value.targetKind };
  }
  assertExactKeys(value, ['workspaceId', 'operation', 'target', 'targetKind'], ['targetKind'], `mutationManifest[${index}]`);
  if (value.targetKind !== undefined && value.targetKind !== 'file' && value.targetKind !== 'directoryTree') {
    throw new SessionControlError('session_control_plan_target_kind_invalid', '写入范围的 targetKind 必须是 file 或 directoryTree。');
  }
  if (!['fs.write', 'fs.edit', 'document.render', 'browser.capture'].includes(String(operation))) {
    throw new SessionControlError(
      'session_control_plan_operation_unknown',
      'Plan operation 不属于 v2 闭合集合。',
    );
  }
  return {
    workspaceId,
    operation: operation as Exclude<PlanOperation['operation'], 'fs.delete' | 'bash' | 'powershell'>,
    target,
    ...(value.targetKind === undefined ? {} : { targetKind: value.targetKind }),
  };
}

function decodeTerminalInput(value: unknown): { stdin: string } {
  if (!isRecord(value)) {
    throw new SessionControlError(
      'session_control_plan_shell_invalid',
      'bash terminal 必须是对象。',
    );
  }
  assertExactKeys(value, ['stdin']);
  if (
    typeof value.stdin !== 'string'
    || new TextEncoder().encode(value.stdin).byteLength > 65_536
  ) {
    throw new SessionControlError(
      'session_control_plan_shell_invalid',
      'bash terminal.stdin 必须是不超过 65536 bytes 的字符串。',
    );
  }
  return { stdin: value.stdin };
}

function decodeInteractionOptions(value: unknown): InteractionOption[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new SessionControlError(
      'session_control_interaction_options_invalid',
      'interaction.request options 必须是最多八项的数组。',
    );
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new SessionControlError(
        'session_control_interaction_option_invalid',
        '交互选项必须是对象。',
      );
    }
    assertExactKeys(candidate, ['id', 'label', 'description'], ['description']);
    const id = requiredIdentifier(candidate.id, 'id');
    if (seen.has(id)) {
      throw new SessionControlError(
        'session_control_interaction_option_duplicate',
        '交互选项 id 不能重复。',
      );
    }
    seen.add(id);
    return {
      id,
      label: requiredText(candidate.label, 'label'),
      ...(candidate.description === undefined
        ? {}
        : { description: requiredText(candidate.description, 'description') }),
    };
  });
}

function normalizedTarget(value: unknown): string {
  const target = requiredText(value, 'target');
  const segments = target.split('/');
  if (
    target.trim() !== target
    || target.startsWith('/')
    || target.includes('\\')
    || target.includes('\0')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new SessionControlError(
      'session_control_plan_target_invalid',
      'Plan target 必须是无歧义的 workspace-relative normalized path。',
    );
  }
  return target;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000) {
    throw new SessionControlError(
      'session_control_field_invalid',
      `Session control 字段 ${field} 必须是非空字符串。`,
    );
  }
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  const id = requiredText(value, field);
  if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new SessionControlError(
      'session_control_identifier_invalid',
      `Session control 字段 ${field} 不是有效标识。`,
    );
  }
  return id;
}

function requiredDisplayText(value: unknown, field: string, maxLength: number): string {
  const text = requiredText(value, field);
  if (
    text.trim() !== text
    || [...text].length > maxLength
    || [...text].some((character) => /[\u0000-\u001f\u007f]/u.test(character))
  ) {
    throw new SessionControlError(
      'session_control_display_text_invalid',
      `Session control 字段 ${field} 必须是单行标题，最多 ${maxLength} 个字符，首尾不能有空白，不能包含换行或控制字符。段落请写入 summary/details。`,
    );
  }
  return text;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
  location = 'call',
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !optionalSet.has(key) && value[key] === undefined);
  if (unexpected.length || missing.length) {
    const wireField = (key: string) => key === 'workspaceId' ? 'workspace' : key;
    const details = [
      ...(unexpected.length ? [`不支持字段 ${unexpected.map(wireField).join(', ')}`] : []),
      ...(missing.length ? [`缺少字段 ${missing.map(wireField).join(', ')}`] : []),
    ].join('；');
    throw new SessionControlError(
      'session_control_shape_invalid',
      `Session control ${location} 字段与当前 schema 不一致：${details}。允许字段：${allowed.map(wireField).join(', ')}。`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SessionControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionControlError';
  }
}
