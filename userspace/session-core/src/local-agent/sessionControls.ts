import type {
  AgentCapabilities,
  AgentOperation,
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
  LLM_REASONING_EFFORTS,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT,
  SESSION_CONTROL_AGENT,
} from '@deepcode/protocol';

export interface SessionControlWireNames {
  interactionRequest: string;
  planPublish: string;
  todoUpdate: string;
  pluginActivate: string;
  artifactPresent: string;
}

export function confirmedPlanExecutionInstruction(): string {
  return 'The Plan is confirmed. Execute it now. Its approved scope remains valid for this run.';
}

export function sessionControlInstructions(
  names: SessionControlWireNames,
  hasWorkspaceBindings = true,
  hasPluginDiscovery = false,
): string {
  const decisions = ` Ask for missing information or decisions with ${names.interactionRequest}. Use mode=continue for clarification when independent work can proceed; use mode=wait (default) otherwise. Confirmations always wait. Continue only work that does not depend on an unanswered question; silence is not agreement. Ask early and avoid repeating unresolved questions. Put choices in options with stable IDs and concise labels, keeping context in prompt instead of duplicating a numbered list. Correct rejected inputs. Tool execution approval is separate.`;
  const plugins = hasPluginDiscovery ? ` For external-program tasks, use CLI or MCP tools for program operations and GUI tools for interface-specific actions or visual confirmation; combine interfaces as needed. Programmatic calls do not require screenshots. Discover needed capabilities with plugin search using a short capability or product name and the tool's declared matching rules. Call ${names.pluginActivate} alone for relevant results, then use their declared tools. Activation does not grant execution permissions.` : '';
  const delivery = ` Tool artifacts are archived runtime resources, not automatically user deliverables. Use ${names.artifactPresent} to explicitly select completed results or review materials the user should see. Temporary scripts, logs and observation screenshots stay intermediate unless requested as results. For a file or URL without an artifact reference, first use artifact.prepare for a file or artifact.preview for a live URL. Present updated versions under the same deliveryId; cite the returned resource URI in final prose, using Markdown images for visual review. Presentation does not resend pixels to the model.`;
  const progress = ` For multi-step work, use ${names.todoUpdate} when useful. Keep phases few and meaningful, merging similar work; choose the count to fit the task. Skip trivial work and unchanged updates; no update is required per tool call or before answering. Send the complete current list in one update, optionally alongside ordinary calls. Todo grants no permissions and does not gate completion; keep unfinished work honest.`;
  if (!hasWorkspaceBindings) {
    return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${names.interactionRequest} must be the only call in its turn.${decisions}${plugins}${delivery}`;
  }
  return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${names.interactionRequest} and ${names.planPublish} must each be the only call in their turn. Use a logical workspace handle from the Session binding list and workspace-relative paths; never invent or expose a workspaceId.${progress}${decisions}${plugins}${delivery}`;
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

/** Detailed contracts are returned by discovery, leaving the provider tool prefix stable. */
export function agentOperationDefinitions({ messaging, delegation }: AgentCapabilities): JsonObject[] {
  const operation = (action: string, description: string, properties: JsonObject = {}, required: string[] = []): JsonObject => ({
    action, description, inputSchema: { type: 'object', additionalProperties: false,
      required: ['action', ...required], properties: { action: { type: 'string', const: action }, ...properties } },
  });
  const id = { type: 'string', minLength: 1 };
  return [
    operation('models', 'Discover available operations and model profiles.'),
    ...(delegation ? [operation('spawn', 'Create a child agent for a task. Async results arrive automatically; wait returns the result in this call.', {
      task: id, name: id, delivery: { type: 'string', enum: ['wait', 'async'] },
      preset: { type: 'string', enum: ['analysis', 'collaboration'], description: 'Optional capability preset: analysis for one task (default); collaboration for messaging and continued tasks.' },
      capabilities: { type: 'object', additionalProperties: false, properties: {
        messaging: { type: 'boolean', description: 'Exchange messages.' },
        continuation: { type: 'boolean', description: 'Accept follow-up tasks in the same Session.' },
        delegation: { type: 'boolean', description: 'Create child agents.' },
      } },
      profileId: { ...id, description: 'Optional model profile; omitted uses the configured default.' },
      reasoningEffort: { type: 'string', enum: [...LLM_REASONING_EFFORTS], description: 'Optional override of the selected model default.' },
    }, ['task', 'name', 'delivery'])] : []),
    ...(messaging ? [operation('send', 'Send a message or continue a child task in its existing Session.', { agentId: id, text: id }, ['agentId', 'text'])] : []),
    ...(delegation ? [
      operation('wait', 'Wait for child tasks. Returns completed task IDs; async results are delivered separately without repetition.', {
        taskIds: { type: 'array', minItems: 1, uniqueItems: true, items: id, description: 'Omit to wait for current tasks.' },
      }),
      operation('cancel', 'Cancel a child task.', { taskId: id }, ['taskId']),
      operation('close', 'Close a child agent.', { agentId: id }, ['agentId']),
    ] : []),
  ];
}

export function sessionControlToolDefinitions(): readonly ProviderToolDefinition[] {
  return [
    {
      name: SESSION_CONTROL_AGENT,
      description: 'Work with child agents. Call action=models to discover available operations, exact arguments and model profiles, then call this tool with the discovered arguments. Submit this control alone.',
      inputSchema: { type: 'object', additionalProperties: true, required: ['action'], properties: {
        action: { type: 'string', minLength: 1, description: 'models discovers the operation contracts; other actions use their returned arguments.' },
      } },
    },
    {
      name: SESSION_CONTROL_ARTIFACT_PRESENT,
      description: 'Select archived resources to deliver for user review or as requested results. Observations, temporary scripts and runtime logs are not outputs by default. Supply exact artifactIds returned by tools; use artifact.prepare for a file or artifact.preview for a URL first. Updating a delivered resource reuses its deliveryId. Returns references to cite or embed in final prose. Does not resend images to the model. Submit this control alone; items may contain all needed deliveries.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['items'], properties: {
        items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
          required: ['artifactId', 'label'], properties: {
            artifactId: {type:'string',minLength:1}, label: {type:'string',minLength:1}, deliveryId: {type:'string',minLength:1},
          } } },
      } },
    },
    {
      name: SESSION_CONTROL_PLUGIN_ACTIVATE,
      description: 'Load installed, enabled plugins needed for the current task. Discover exact URIs with plugin search first. User mentions are optional and remain separate user guidance. This adds plugin tools/instructions to the next request in this run; it does not install, enable disabled plugins, change settings or authorize their effects. Must be the only call in its turn.',
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
      description: 'Publish or revise a Plan; confirmation follows the current Plan setting. Keep steps to meaningful outcome phases, merging similar work. Use extendScope for additions; for a full revision, retain existing stepIds and submit the complete Plan and manifest. Routine fixes within confirmed scope need no new Plan. Bash command is an optional example, not an exact script lock; writablePaths defines its write scope. Todo remains independent.',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_TODO_UPDATE,
      description: 'Replace the complete ordered task list when progress meaningfully changes. Keep phases few and meaningful, merging similar work; choose the count to fit the task and revise the list as needed. Report pending, inProgress, completed or blocked work; an empty list clears it. No Plan, record IDs or approval needed; unfinished items do not prevent answering. At most one update per turn; ordinary calls may accompany it.',
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
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_AGENT) {
    return { kind: 'agent', callId: canonicalCallId, operation: decodeAgentOperation(input) };
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
      assertExactKeys(input, ['action', 'task', 'name', 'delivery', 'profileId', 'reasoningEffort', 'preset', 'capabilities'],
        ['profileId', 'reasoningEffort', 'preset', 'capabilities']);
      if (input.preset !== undefined && input.preset !== 'analysis' && input.preset !== 'collaboration') {
        throw new SessionControlError('agent_preset_invalid', 'preset 必须是 analysis 或 collaboration。');
      }
      if (input.capabilities !== undefined && ((!input.capabilities || typeof input.capabilities !== 'object' || Array.isArray(input.capabilities))
        || Object.entries(input.capabilities).some(([key, value]) => !['messaging', 'continuation', 'delegation'].includes(key) || typeof value !== 'boolean'))) {
        throw new SessionControlError('agent_capabilities_invalid', 'capabilities 只接受 messaging、continuation、delegation 布尔值。');
      }
      if (input.delivery !== 'wait' && input.delivery !== 'async') {
        throw new SessionControlError('agent_delivery_invalid', 'delivery 必须是 wait 或 async。');
      }
      if (input.reasoningEffort !== undefined && !isLlmReasoningEffort(input.reasoningEffort)) {
        throw new SessionControlError('agent_reasoning_effort_invalid', 'reasoningEffort 必须是有效推理强度。');
      }
      return { action: input.action, task: requiredText(input.task, 'task'), name: requiredText(input.name, 'name'), delivery: input.delivery,
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        ...(input.capabilities !== undefined ? { capabilities: { ...input.capabilities } as Partial<AgentCapabilities> } : {}),
        ...(input.profileId !== undefined ? { profileId: requiredText(input.profileId, 'profileId') } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) };
    }
    case 'send':
      assertExactKeys(input, ['action', 'agentId', 'text']);
      return { action: 'send', agentId: requiredIdentifier(input.agentId, 'agentId'), text: requiredText(input.text, 'text') };
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
