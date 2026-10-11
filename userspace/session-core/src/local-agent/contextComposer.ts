import { advanceTodoList } from './todoState.js';
import { appendInputFileBindings } from './workspaceBindings.js';
import type {
  ContextCompositionMessage,
  ContextCompositionMetadata,
  ContextCompositionReceipt,
  ContextCompositionTool,
  ModelMessage,
  ProviderRequest,
  ProviderToolDefinition,
  RunRuntimeSnapshot,
  SessionEvent,
  ToolExecutionRecord,
  TodoListProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT,
} from '@deepcode/protocol';
import { LoopFailure } from './loopFailure.js';
import { journalModelViews } from './modelView.js';
import type {
  ContextMessageContribution,
} from './plugins.js';
import {
  createProviderToolCodec,
  encodeProviderMessage,
  providerMessageCodecsByCallId,
  providerWorkspaceBindings,
  providerWireName,
  type ProviderToolCodec,
} from './providerToolCodec.js';
import {
  confirmedPlanExecutionInstruction,
  sessionControlInstructions,
  sessionControlToolDefinitions,
} from './sessionControls.js';
import { renderActiveToolGuidance } from './toolPromptContributions.js';
import { visualContextInstruction, visualContextMessages } from './visualContext.js';

export interface PreparedProviderRequest {
  request: ProviderRequest;
  receipt: Extract<ContextCompositionReceipt, { purpose: 'agent' | 'contextCompaction' }>;
  toolCodec: ProviderToolCodec;
}

type ProviderTurnSettledEvent = Extract<SessionEvent, { type: 'provider.turn.settled' }>;
type CompletedProviderTurnEvent = ProviderTurnSettledEvent & {
  payload: Extract<ProviderTurnSettledEvent['payload'], { outcome: 'completed' }>;
};

type ConversationRequestInput = {
  sessionId: string;
  runId: string;
  runtime: RunRuntimeSnapshot;
  events: readonly SessionEvent[];
  /** Compaction selects a prefix but reuses views already recorded by later receipts. */
  modelViewEvents?: readonly SessionEvent[];
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  providerRequestId: string;
};

export async function buildAgentProviderRequest(input: ConversationRequestInput & {
  responseConstraint: 'normal';
}, signal?: AbortSignal): Promise<PreparedProviderRequest> {
  signal?.throwIfAborted();
  const prepared = buildConversationProviderRequest({ ...input, purpose: 'agent' });
  signal?.throwIfAborted();
  return prepared;
}

/** Agent and summary requests share one conversation prefix and tool codec. */
export function buildConversationProviderRequest(input: ConversationRequestInput & (
  | { purpose: 'agent'; responseConstraint: 'normal' }
  | { purpose: 'contextCompaction'; responseConstraint: 'answerOnly'; summaryInstruction: string }
)): PreparedProviderRequest {
  const toolTerminals = new Set(input.events.flatMap((event) => (
    event.type === 'tool.completed' || event.type === 'tool.input-rejected' || event.type === 'tool.interrupted'
      ? [event.callId] : []
  )));
  const openCall = input.events.find((event) => event.type === 'tool.requested' && !toolTerminals.has(event.callId));
  if (openCall?.type === 'tool.requested') {
    throw new LoopFailure('tool_result_missing', `调用 ${openCall.callId} 尚无终态；不能发送不完整的 Provider 历史。`);
  }
  const hasWorkspaceBindings = input.workspaceBindings.length > 0;
  const hasPluginDiscovery = input.runtime.tools.some(tool => tool.name === 'plugin.search' && tool.availability === 'callable');
  const firstRun = input.events.find((event) => event.type === 'run.started');
  const prefixBindings = firstRun?.type === 'run.started' ? firstRun.payload.workspaceBindings : input.workspaceBindings;
  const controlNames = {
    interactionRequest: providerWireName(input.runtime, SESSION_CONTROL_INTERACTION_REQUEST),
    planPublish: providerWireName(input.runtime, SESSION_CONTROL_PLAN_PUBLISH),
    todoUpdate: providerWireName(input.runtime, SESSION_CONTROL_TODO_UPDATE),
    pluginActivate: providerWireName(input.runtime, SESSION_CONTROL_PLUGIN_ACTIVATE),
    artifactPresent: providerWireName(input.runtime, SESSION_CONTROL_ARTIFACT_PRESENT),
  };
  const runtimeTools = hasWorkspaceBindings
    ? input.runtime.tools
    : input.runtime.tools.filter((tool) => !tool.possibleEffects.some((effect) => (
      effect === 'workspaceRead'
      || effect === 'workspaceMutation'
      || effect === 'process'
    )));
  const hostedTools: ProviderRequest['hostedTools'] = input.runtime.webSearch.owner === 'providerHosted'
    ? [{ type: 'webSearch', providerToolType: input.runtime.webSearch.providerToolType }]
    : [];
  const controlTools = sessionControlToolDefinitions().filter(tool => tool.name === SESSION_CONTROL_PLUGIN_ACTIVATE
    ? hasPluginDiscovery : hasWorkspaceBindings || tool.name === SESSION_CONTROL_INTERACTION_REQUEST || tool.name === SESSION_CONTROL_ARTIFACT_PRESENT);
  const toolCodec = createProviderToolCodec(
    runtimeTools,
    controlTools,
    input.runtime.providerToolAliases,
    input.workspaceBindings,
  );
  const modelViewEvents = input.modelViewEvents ?? input.events;
  const fixedViews = journalModelViews(modelViewEvents).contributions;
  const journalMessages = messagesFromJournal(input.events, input.runId, input.workspaceBindings, modelViewEvents);
  const instructions = [...input.runtime.instructions]
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    .map<ContextMessageContribution>((instruction) => ({
      contributionId: `instruction:${instruction.id}`,
      contributionKind: 'instructions',
      label: instruction.id,
      message: { role: 'system', content: instruction.text },
    }));
  const toolGuidance = renderActiveToolGuidance(
    input.runtime.toolPromptContributions,
    toolCodec.receiptTools,
    runtimeTools,
    hostedTools,
  );
  if (toolGuidance) {
    const stableCoreIndex = instructions.findIndex((instruction) => (
      instruction.contributionId === 'instruction:deepcode.coding-agent'
    ));
    if (stableCoreIndex < 0) {
      throw new LoopFailure(
        'stable_core_instruction_missing',
        'Run runtime 缺少唯一稳定 Core System Prompt。',
      );
    }
    instructions.splice(stableCoreIndex + 1, 0, {
      contributionId: 'instruction:deepcode.tool-guidance',
      contributionKind: 'instructions',
      label: 'deepcode.tool-guidance',
      message: { role: 'system', content: toolGuidance },
    });
  }
  instructions.push({
    contributionId: 'session:controls',
    contributionKind: 'sessionControls',
    label: 'Session control contract',
    message: {
      role: 'system',
      content: sessionControlInstructions(controlNames, hasWorkspaceBindings, hasPluginDiscovery),
    },
  });
  instructions.push({
    contributionId: 'session:workspace-bindings',
    contributionKind: 'workspaceBindings',
    label: '当前运行的目录索引',
    message: {
      role: 'system',
      content: hasWorkspaceBindings
        ? `Current Session workspace bindings (logical handles only): ${JSON.stringify(
          providerWorkspaceBindings(prefixBindings),
        )}`
        : 'Current Session workspace bindings: []. Workspace-scoped filesystem and Bash tools are unavailable for this run.',
    },
  });
  const imageReader = toolCodec.wireByCanonical.get('session.read');
  if (imageReader) instructions.push({ contributionId: 'session:images', contributionKind: 'sessionControls',
    label: 'Image context', message: { role: 'system', content: visualContextInstruction(input.sessionId, imageReader) } });
  const selected = [...instructions, ...journalMessages,
    ...(input.purpose === 'agent' ? visualContextMessages(input.events, input.runId) : [])];
  if (input.purpose === 'contextCompaction') selected.push({
    contributionId: `context-compaction:${input.providerRequestId}:instructions`,
    contributionKind: 'sessionControls', label: '上下文压缩指令',
    message: { role: 'user', content: input.summaryInstruction },
  });
  assertContextContributions(selected);
  const journalCodecsByCallId = providerMessageCodecsByCallId(input.events);
  const providerSelected = selected.map<ContextMessageContribution>((contribution) => ({
    ...contribution,
    message: fixedViews.has(contribution.contributionId)
      ? cloneModelMessage(fixedViews.get(contribution.contributionId)!.message)
      : encodeProviderMessage(contribution.message, toolCodec, journalCodecsByCallId),
  }));
  const request: ProviderRequest = {
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    requestId: input.providerRequestId,
    sessionId: input.sessionId,
    runId: input.runId,
    providerRuntimeRef: input.runtime.provider.providerRuntimeRef,
    profileId: input.runtime.provider.profileId,
    purpose: input.purpose,
    responseConstraint: input.responseConstraint,
    maxOutputTokens: input.runtime.provider.maxOutputTokens,
    workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
    messages: providerSelected.map((item) => cloneModelMessage(item.message)),
    tools: toolCodec.definitions,
    hostedTools,
  };
  const hostedReceiptTools: ContextCompositionTool[] = request.hostedTools.map((tool) => ({
    itemId: 'web.search',
    label: tool.providerToolType,
    canonicalName: 'web.search',
    wireName: tool.providerToolType,
    origin: 'providerHosted',
    availability: 'callable',
  }));
  return {
    request,
    toolCodec,
    receipt: { ...buildContextCompositionReceipt(
      request.requestId,
      input.purpose,
      input.responseConstraint,
      providerSelected,
      toolCodec.kernelDefinitions,
      toolCodec.controlDefinitions,
      request.hostedTools,
      toolCodec.canonicalByWire,
      [...toolCodec.receiptTools, ...hostedReceiptTools],
      input.runtime,
      input.workspaceBindings,
      input.events,
    ), modelView: {
      throughSequence: input.events.at(-1)?.sequence ?? 0,
      additions: providerSelected.flatMap(contribution => contribution.sourceSequence !== undefined
        && !fixedViews.has(contribution.contributionId)
        ? [{ ...contribution, sourceSequence: contribution.sourceSequence, message: cloneModelMessage(contribution.message) }]
        : []),
    } },
  };
}

export function messagesFromJournal(
  events: readonly SessionEvent[],
  runId: string,
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  modelViewEvents: readonly SessionEvent[] = events,
): ContextMessageContribution[] {
  const messages: ContextMessageContribution[] = [];
  const fixed = journalModelViews(modelViewEvents);
  const throughSequence = events.at(-1)?.sequence ?? 0;
  const retained: ContextMessageContribution[] = [];
  const pendingHostRebinds: ContextMessageContribution[] = [];
  const pendingProcessUpdates = new Map<string, ContextMessageContribution>();
  const flushProcessUpdates = () => {
    messages.push(...pendingProcessUpdates.values());
    pendingProcessUpdates.clear();
  };
  const completionResults = new Map<string, ContextMessageContribution>();
  const approvalsByCallId = new Map(events.flatMap((event) => (
    event.type === 'approval.resolved' ? [[event.callId, event.payload] as const] : []
  )));
  const completedTurns = new Map(events.filter(isCompletedProviderTurn).map((event) => [event.payload.providerRequestId, event]));
  const orderedProviderTurns = new Map(events.flatMap((event) => (
    event.type === 'provider.turn.settled'
    && event.payload.outcome === 'completed'
    && event.payload.orderedOutputBlocks !== undefined
      ? [[event.payload.providerRequestId, event.payload.orderedOutputBlocks] as const]
      : []
  )));
  const aggregateProviderTurns = new Map(events.flatMap((event) => (
    event.type === 'provider.turn.settled' && event.payload.outcome === 'completed' && event.payload.toolCallInputs
      ? [[event.payload.providerRequestId, event.payload.toolCallInputs] as const] : []
  )));
  const orderedProviderCallIds = new Set([...orderedProviderTurns.values()].flatMap((blocks) => (
    blocks.flatMap((block) => block.kind === 'toolCall' ? [block.callId] : [])
  )));
  for (const calls of aggregateProviderTurns.values()) {
    for (const call of calls) orderedProviderCallIds.add(call.callId);
  }
  const providerCallIdByLogicalCallId = providerCallIdsFromEvents(events);
  const interactionCallIds = new Map(events.flatMap((event) => (
    event.type === 'interaction.requested'
      ? [[event.payload.interactionId, event.callId] as const]
      : []
  )));
  const interactions = new Map(events.flatMap(event => event.type === 'interaction.requested'
    ? [[event.payload.interactionId, event] as const] : []));
  const responses = new Map(events.flatMap(event => event.type === 'interaction.resolved'
    ? [[event.payload.commandId, event.payload] as const] : []));
  const repliesByMessage = new Map(events.flatMap(event => event.type === 'input.accepted' && responses.has(event.payload.commandId)
    ? [[event.payload.messageId, responses.get(event.payload.commandId)!] as const] : []));
  const retainedRunInputId = runInputMessageEvent(events, runId)?.payload.messageId;
  const runs = events.filter((event): event is Extract<SessionEvent, { type: 'run.started' }> => event.type === 'run.started');
  const runForInput = new Map(runs.map((event) => [event.payload.inputMessageId, event]));
  const bindingsByRun = new Map(runs.map(event => [event.runId, event.payload.workspaceBindings]));
  const checkpoint = [...events]
    .reverse()
    .find((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => (
      event.type === 'context.compacted'
    ));
  if (checkpoint) {
    const contributionId = `context-checkpoint:${checkpoint.payload.compactionId}`;
    retained.push(fixed.contributions.get(contributionId) ?? {
      contributionId,
      contributionKind: 'journalMessages',
      label: '上下文压缩摘要',
      sourceSequence: checkpoint.sequence,
      message: { role: 'system', content: checkpoint.payload.summary },
    });
  }
  for (const contribution of fixed.contributions.values()) {
    if (contribution.contributionId.startsWith('context-checkpoint:')
      || contribution.sourceSequence > throughSequence) continue;
    if (checkpoint && contribution.sourceSequence <= checkpoint.payload.coveredThroughSequence
      && contribution.contributionId !== `message:${retainedRunInputId}`
      && contribution.contributionId !== `workspace-snapshot:${retainedRunInputId}`) continue;
    retained.push({ ...contribution, message: cloneModelMessage(contribution.message) });
  }
  let todoList: TodoListProjection | null = null;
  for (const event of events) {
    todoList = advanceTodoList(todoList, event);
    let messageBindings = workspaceBindings;
    let changedBindings = false;
    if (event.type === 'message.committed') {
      const inputRun = runForInput.get(event.payload.messageId);
      const ownerRunId = inputRun?.runId ?? event.runId;
      const before = inputRun?.payload.workspaceBindings
        ?? (ownerRunId ? bindingsByRun.get(ownerRunId) : undefined) ?? workspaceBindings;
      messageBindings = event.payload.role === 'user'
        ? appendInputFileBindings(before, event.payload.filesystemReferences) : before;
      const previousRun = inputRun ? runs[runs.indexOf(inputRun) - 1] : undefined;
      const previous = inputRun
        ? (previousRun ? bindingsByRun.get(previousRun.runId) : undefined) : before;
      changedBindings = previous !== undefined && JSON.stringify(previous) !== JSON.stringify(messageBindings);
      if (ownerRunId) bindingsByRun.set(ownerRunId, [...messageBindings]);
    }
    if (
      checkpoint
      && event.sequence <= checkpoint.payload.coveredThroughSequence
      && !(event.type === 'message.committed' && event.payload.messageId === retainedRunInputId)
    ) continue;
    if (event.sequence <= fixed.throughSequence
      && !(event.type === 'message.committed' && event.payload.messageId === retainedRunInputId
        && !fixed.contributions.has(`message:${retainedRunInputId}`))) continue;
    const firstNewMessage = messages.length;
    if (event.type === 'message.committed') {
      if (
        event.payload.role === 'assistant'
        && orderedProviderTurns.has(event.payload.providerRequestId)
      ) continue;
      const reasoning = event.payload.role === 'assistant'
        ? providerReasoning(completedTurns.get(event.payload.providerRequestId), event.payload.providerRequestId)
        : {};
      if (changedBindings) {
        messages.push({
          contributionId: `workspace-snapshot:${event.payload.messageId}`, contributionKind: 'workspaceBindings',
          label: '本轮目录与资源引用', message: { role: 'system',
            content: `Current Session workspace bindings (logical handles only; supersedes earlier binding snapshots): ${JSON.stringify(providerWorkspaceBindings(messageBindings))}` },
        });
      }
      messages.push({
        contributionId: `message:${event.payload.messageId}`,
        contributionKind: 'journalMessages',
        label: event.payload.role === 'user' ? '用户消息' : 'Assistant 消息',
        message: {
          role: event.payload.role,
          content: (() => {
            const reply = repliesByMessage.get(event.payload.messageId);
            const question = reply && interactions.get(reply.interactionId);
            const content = messageContentForModel(event.payload, messageBindings);
            return question?.payload.mode === 'continue'
              ? `User response to question ${reply!.interactionId}: ${question.payload.prompt}\n\n${content}` : content;
          })(),
          ...reasoning,
        },
      });
    } else if (event.type === 'narrative.committed') {
      if (orderedProviderTurns.has(event.payload.providerRequestId)) continue;
      if (!mergeNarrativeIntoProviderCall(messages, completedTurns.get(event.payload.providerRequestId), event)) {
        messages.push({
          contributionId: `narrative:${event.payload.narrativeId}`,
          contributionKind: 'journalMessages',
          label: '运行叙述',
          message: {
            role: 'assistant',
            content: event.payload.content,
            ...providerReasoning(completedTurns.get(event.payload.providerRequestId), event.payload.providerRequestId),
          },
        });
      }
    } else if (event.type === 'interaction.requested') {
      if (!orderedProviderCallIds.has(event.callId)) attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: SESSION_CONTROL_INTERACTION_REQUEST,
        input: {
          kind: event.payload.kind,
          prompt: event.payload.prompt,
          options: event.payload.options,
          allowFreeform: event.payload.allowFreeform,
          ...(event.payload.mode ? { mode: event.payload.mode } : {}),
        },
      });
      if (event.payload.mode === 'continue') completionResults.set(event.callId, {
        contributionId: `interaction-pending:${event.payload.interactionId}`, contributionKind: 'journalMessages',
        sourceSequence: event.sequence,
        label: 'Question awaiting user', message: { role: 'tool', toolCallId: event.callId, providerCallId: event.payload.providerCallId,
          content: JSON.stringify({ interactionId: event.payload.interactionId, status: 'pending',
            nextAction: 'Continue independent work without assuming an answer or repeating the question. When that work is complete, explain what awaits the user.' }) },
      });
    } else if (event.type === 'interaction.resolved') {
      if (interactions.get(event.payload.interactionId)?.payload.mode === 'continue') continue;
      const callId = interactionCallIds.get(event.payload.interactionId);
      if (!callId) {
        throw new LoopFailure('interaction_call_identity_missing', '交互请求缺少 LogicalCallId。');
      }
      messages.push({
        contributionId: `interaction-result:${event.payload.interactionId}`,
        contributionKind: 'journalMessages',
        label: '用户交互答复',
        message: {
          role: 'tool',
          toolCallId: callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, callId),
          content: JSON.stringify({ response: event.payload.response }),
        },
      });
    } else if (event.type === 'plan.published') {
      if (orderedProviderCallIds.has(event.callId)) continue;
      attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: SESSION_CONTROL_PLAN_PUBLISH,
        input: {
          title: event.payload.title,
          summary: event.payload.summary,
          steps: event.payload.steps,
          mutationManifest: event.payload.mutationManifest,
        },
      });
    } else if (event.type === 'plan.confirmed') {
      messages.push({
        contributionId: `plan-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户确认 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'confirm' },
            planId: event.payload.planId,
            revision: event.payload.revision,
            todoSeeded: true,
            nextAction: confirmedPlanExecutionInstruction(),
          }),
        },
      });
    } else if (event.type === 'plan.revision.requested') {
      messages.push({
        contributionId: `plan-revision-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户请求修改 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'requestRevision', text: event.payload.text },
            planId: event.payload.planId,
            revision: event.payload.revision,
          }),
        },
      });
    } else if (event.type === 'plan.cancelled') {
      messages.push({
        contributionId: `plan-cancel-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户取消 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'cancel' },
            planId: event.payload.planId,
            revision: event.payload.revision,
          }),
        },
      });
    } else if (event.type === 'plan.invalidated') {
      messages.push({
        contributionId: `plan-invalidated:${event.payload.planId}:${event.payload.revision}:${event.eventId}`,
        contributionKind: 'journalMessages',
        label: 'Plan 已失效',
        message: {
          role: 'system',
          content: JSON.stringify({
            type: 'plan.invalidated',
            planId: event.payload.planId,
            revision: event.payload.revision,
            reason: event.payload.reason,
            sourceFactRef: event.payload.sourceFactRef,
          }),
        },
      });
    } else if (
      event.type === 'todo.updated'
    ) {
      if (event.type === 'todo.updated' && event.callId && event.payload.providerCallId) {
        if (!orderedProviderCallIds.has(event.callId)) attachToolCall(messages, {
          callId: event.callId, providerCallId: event.payload.providerCallId,
          name: SESSION_CONTROL_TODO_UPDATE,
          input: { items: event.payload.items },
        });
        completionResults.set(event.callId, {
          contributionId: `todo-update:${event.callId}`,
          sourceSequence: event.sequence,
          contributionKind: 'journalMessages', label: 'Todo update result',
          message: {
            role: 'tool', toolCallId: event.callId, providerCallId: event.payload.providerCallId,
            content: JSON.stringify({ accepted: true }),
          },
        });
        for (let index = firstNewMessage; index < messages.length; index += 1) {
          messages[index]!.sourceSequence ??= event.sequence;
        }
        continue;
      }
      if (todoList) messages.push({
        contributionId: `todo-state:${event.eventId}`,
        contributionKind: 'journalMessages',
        label: 'Session Todo state',
        message: {
          role: 'user',
          content: JSON.stringify({
            type: 'todo.current',
            items: todoList.items,
          }),
        },
      });
    } else if (event.type === 'artifacts.presented') {
      if (!orderedProviderCallIds.has(event.callId)) attachToolCall(messages, {
        callId: event.callId, providerCallId: event.payload.providerCallId,
        name: SESSION_CONTROL_ARTIFACT_PRESENT, input: { items: event.payload.items },
      });
      completionResults.set(event.callId, {
        contributionId: `artifact-presentation:${event.callId}`, contributionKind: 'journalMessages', label: 'Artifacts presented',
        sourceSequence: event.sequence,
        message: { role: 'tool', toolCallId: event.callId, providerCallId: event.payload.providerCallId,
          content: JSON.stringify({ accepted: true, items: event.payload.items.map(item => ({ ...item, uri: `artifact://${item.artifactId}` })) }) },
      });
    } else if (event.type === 'session.plugins.activated') {
      if (!orderedProviderCallIds.has(event.callId)) {
        attachToolCall(messages, { callId: event.callId, providerCallId: event.payload.providerCallId,
          name: SESSION_CONTROL_PLUGIN_ACTIVATE, input: { pluginUris: event.payload.pluginUris } });
      }
      completionResults.set(event.callId, {
        contributionId: `plugin-activation:${event.callId}`, contributionKind: 'journalMessages', label: '插件已加载',
        sourceSequence: event.sequence,
        message: { role: 'tool', toolCallId: event.callId, providerCallId: event.payload.providerCallId,
          content: JSON.stringify({ activated: event.payload.pluginUris }) },
      });
    } else if (event.type === 'session.control.rejected') {
      if (!orderedProviderCallIds.has(event.callId)) {
        attachToolCall(messages, {
          callId: event.callId,
          providerCallId: event.payload.providerCallId,
          name: event.payload.toolName,
          input: event.payload.input,
        });
      }
      completionResults.set(event.callId, {
        contributionId: `session-control-rejection:${event.callId}`,
        sourceSequence: event.sequence,
        contributionKind: 'journalMessages',
        label: 'Session control 拒绝结果',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: event.payload.providerCallId,
          content: JSON.stringify({ accepted: false, executed: false, error: event.payload.error }),
        },
      });
    } else if (event.type === 'tool.requested') {
      if (orderedProviderCallIds.has(event.callId)) continue;
      attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: event.payload.toolName,
        input: event.payload.input,
      });
    } else if (event.type === 'tool.input-rejected') {
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: `${event.payload.rejection.toolName} input rejected`,
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({ status: 'inputRejected', executed: false, error: event.payload.rejection.error }),
        },
      });
    } else if (event.type === 'tool.interrupted') {
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: 'Tool result unknown',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({ status: 'indeterminate', error: event.payload.error }),
        },
      });
    } else if (event.type === 'tool.completed') {
      const approval = approvalsByCallId.get(event.callId);
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: `${event.payload.record.preparedEffect.operation} 结果`,
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            ...toolResultForModel(event.payload.record),
            ...(approval ? { approval: { decision: approval.decision, scope: approval.authorizationScope ?? 'call',
              ...(approval.reason ? { reason: approval.reason } : {}) } } : {}),
          }),
        },
      });
    } else if (event.type === 'process.updated') {
      // Coalesce the feed only until the next request. Once observed, its
      // snapshot stays in history; a later status must not rewrite a tool result.
      pendingProcessUpdates.set(event.payload.job.jobId, {
        contributionId: `process-update:${event.eventId}`, contributionKind: 'journalMessages',
        sourceSequence: event.sequence,
        label: 'Managed process update', message: { role: 'user',
          content: JSON.stringify({ type: 'process.updated', process: processContext(event.payload.job) }) },
      });
    } else if (event.type === 'run.host.rebound') {
      // Rebinding happens while a tool is waiting. Its notice belongs to the next
      // Agent request, after the pending result, not inside the call/result pair.
      pendingHostRebinds.push({ contributionId: `host-rebind:${event.sequence}`, contributionKind: 'journalMessages', label: 'GUI target changed',
        sourceSequence: event.sequence,
        message: { role: 'user', content: 'The user selected a new GUI target. Earlier observationId and previewId handles are invalid. Observe again or open a new preview before interacting; do not replay previous actions.' } });
    } else if (event.type === 'context.composed' && event.payload.purpose === 'agent') {
      flushProcessUpdates();
      messages.push(...pendingHostRebinds.splice(0));
    } else if (event.type === 'provider.turn.settled' && event.payload.outcome === 'completed') {
      if (event.payload.toolCallInputs) {
        messages.push({
          contributionId: `provider-inputs:${event.payload.providerRequestId}`,
          contributionKind: 'journalMessages',
          label: 'Provider calls',
          message: {
            role: 'assistant',
            content: '',
            ...providerReasoning(completedTurns.get(event.payload.providerRequestId), event.payload.providerRequestId),
            toolCalls: event.payload.toolCallInputs.map((call) => ({
              callId: call.callId,
              providerCallId: call.providerCallId,
              name: call.toolName,
              input: call.arguments,
            })),
          },
        });
        for (const call of event.payload.toolCallInputs) {
          if (!call.error) continue;
          messages.push({
            contributionId: `provider-input-rejection:${call.callId}`,
            contributionKind: 'journalMessages',
            label: `${call.toolName} input rejected`,
            message: {
              role: 'tool',
              toolCallId: call.callId,
              providerCallId: call.providerCallId,
              content: JSON.stringify({ status: 'inputRejected', executed: false, error: call.error }),
            },
          });
        }
      }

      if (event.payload.orderedOutputBlocks !== undefined) {
        messages.push({
          contributionId: `provider-output:${event.payload.providerRequestId}`,
          contributionKind: 'journalMessages',
          label: 'Provider output',
          message: {
            role: 'assistant',
            content: '',
            providerOutputBlocks: event.payload.orderedOutputBlocks.map((block) => ({
              ...block,
              item: structuredClone(block.item),
            })),
          },
        });
        for (const block of event.payload.orderedOutputBlocks) {
          if (block.kind !== 'toolCallRejected') continue;
          messages.push({
            contributionId: `provider-input-rejection:${block.callId}`,
            contributionKind: 'journalMessages',
            label: `${block.toolName} input rejected`,
            message: {
              role: 'tool',
              toolCallId: block.callId,
              providerCallId: block.providerCallId,
              content: JSON.stringify({ status: 'inputRejected', executed: false, error: block.error }),
            },
          });
        }
      }
      for (const callId of event.payload.orderedCallIds) {
        const result = completionResults.get(callId);
        if (!result) continue;
        messages.push(result);
        completionResults.delete(callId);
      }
    }
    for (let index = firstNewMessage; index < messages.length; index += 1) {
      messages[index]!.sourceSequence ??= event.sequence;
    }
  }
  flushProcessUpdates();
  messages.push(...pendingHostRebinds);
  if (completionResults.size > 0) {
    throw new LoopFailure(
      'provider_call_result_completion_missing',
      'Session control 结果缺少对应的 Provider turn 完成事实。',
    );
  }
  applyProviderTurnCompletions(messages, events);
  return [...retained, ...messages];
}

export function buildContextCompositionReceipt<Purpose extends ContextCompositionReceipt['purpose']>(
  providerRequestId: string,
  purpose: Purpose,
  responseConstraint: ContextCompositionReceipt['responseConstraint'],
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  hostedTools: readonly ProviderRequest['hostedTools'][number][],
  canonicalByWire: ReadonlyMap<string, string>,
  receiptTools: readonly ContextCompositionTool[],
  runtime: RunRuntimeSnapshot,
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  events: readonly SessionEvent[],
): Omit<ContextCompositionMetadata, 'purpose'> & { purpose: Purpose } {
  const filesystemReferenceFactsByContributionId = new Map<string, Array<{
    referenceId: string;
    displayName: string;
  }>>();
  for (const event of events) {
    if (event.type !== 'message.committed') continue;
    const references = (event.payload.filesystemReferences ?? []).map((reference) => ({
      referenceId: reference.referenceId,
      displayName: reference.displayName,
    }));
    if (references.length > 0) {
      filesystemReferenceFactsByContributionId.set(
        `message:${event.payload.messageId}`,
        references,
      );
    }
  }
  const workspaceBindingItems = workspaceBindings.map((binding) => ({
    itemId: binding.workspaceId,
    label: binding.displayName,
  }));
  const toolItems = receiptTools.map((tool) => ({ ...tool }));
  if (toolItems.length !== kernelTools.length + controlTools.length + hostedTools.length) {
    throw new LoopFailure('provider_tool_receipt_incomplete', 'Context receipt 工具数量不完整。');
  }
  for (const tool of toolItems) {
    if (tool.origin === 'providerHosted') {
      if (tool.canonicalName !== 'web.search' || tool.wireName !== 'web_search') {
        throw new LoopFailure(
          'provider_hosted_tool_receipt_invalid',
          'Context receipt 的 Provider hosted search 工具无效。',
        );
      }
      continue;
    }
    if (canonicalByWire.get(tool.wireName) !== tool.canonicalName) {
      throw new LoopFailure(
        'provider_tool_alias_receipt_missing',
        `Context receipt 缺少 Provider tool alias：${tool.canonicalName}`,
      );
    }
  }
  const messages = selected.map((item, messageIndex) => ({
    messageIndex,
    contributionId: item.contributionId,
    contributionKind: item.contributionKind,
    label: item.label,
    role: item.message.role,
    blocks: contextCompositionBlocks(item.message),
    filesystemReferences: (
      filesystemReferenceFactsByContributionId.get(item.contributionId) ?? []
    ).map((reference) => ({
      itemId: reference.referenceId,
      label: reference.displayName,
    })),
  }));
  return {
    providerRequestId,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    purpose,
    responseConstraint,
    dynamicInstructionBytes: selected.reduce((total, contribution) => (
      contribution.message.role === 'system'
      && contribution.contributionId !== 'instruction:deepcode.coding-agent'
        ? total + new TextEncoder().encode(contribution.message.content).byteLength
        : total
    ), 0),
    messages,
    workspaceBindings: workspaceBindingItems,
    tools: toolItems,
    partitions: buildContextCompositionPartitions(
      selected,
      kernelTools,
      controlTools,
      hostedTools,
      workspaceBindings,
      filesystemReferenceFactsByContributionId,
    ),
  };
}

export function assertContextContributions(
  contributions: readonly ContextMessageContribution[],
): void {
  const seen = new Set<string>();
  for (const contribution of contributions) {
    if (!contribution.contributionId || seen.has(contribution.contributionId)) {
      throw new LoopFailure(
        'context_contribution_identity_invalid',
        'Memory provider 返回了空或重复的上下文贡献标识。',
      );
    }
    if (!CONTEXT_MESSAGE_KINDS.includes(contribution.contributionKind)) {
      throw new LoopFailure(
        'context_contribution_kind_invalid',
        `Memory provider 返回了未知的上下文贡献类型：${contribution.contributionKind}`,
      );
    }
    if (!contribution.label || !contribution.message) {
      throw new LoopFailure(
        'context_contribution_shape_invalid',
        'Memory provider 返回的上下文贡献缺少标签或消息。',
      );
    }
    seen.add(contribution.contributionId);
  }
}

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: structuredClone(call.input),
          })),
        }
      : {}),
    ...(message.providerItems
      ? { providerItems: message.providerItems.map((item) => structuredClone(item)) }
      : {}),
    ...(message.providerOutputBlocks
      ? {
          providerOutputBlocks: message.providerOutputBlocks.map((block) => ({
            ...block,
            item: structuredClone(block.item),
          })),
        }
      : {}),
  };
}

function providerCallIdsFromEvents(events: readonly SessionEvent[]): Map<string, string> {
  const byLogicalCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'todo.updated' && event.callId && event.payload.providerCallId) {
      byLogicalCallId.set(event.callId, event.payload.providerCallId);
      continue;
    }
    if (
      event.type !== 'tool.requested'
      && event.type !== 'interaction.requested'
      && event.type !== 'plan.published'
      && event.type !== 'session.control.rejected'
      && event.type !== 'session.plugins.activated'
      && event.type !== 'artifacts.presented'
    ) continue;
    const providerCallId = event.payload.providerCallId;
    const existing = byLogicalCallId.get(event.callId);
    if (existing !== undefined && existing !== providerCallId) {
      throw new LoopFailure(
        'provider_call_identity_conflict',
        `LogicalCallId ${event.callId} 对应了多个 ProviderCallId。`,
      );
    }
    byLogicalCallId.set(event.callId, providerCallId);
  }
  return byLogicalCallId;
}

function requiredProviderCallId(
  providerCallIds: ReadonlyMap<string, string>,
  logicalCallId: string,
): string {
  const providerCallId = providerCallIds.get(logicalCallId);
  if (!providerCallId) {
    throw new LoopFailure(
      'provider_call_identity_missing',
      `LogicalCallId ${logicalCallId} 缺少 ProviderCallId。`,
    );
  }
  return providerCallId;
}

export function runInputMessageEvent(
  events: readonly SessionEvent[],
  runId: string,
): Extract<SessionEvent, { type: 'message.committed' }> | null {
  const started = events.find((event): event is Extract<SessionEvent, { type: 'run.started' }> => (
    event.type === 'run.started' && event.runId === runId
  ));
  if (!started) return null;
  return events.find((event): event is Extract<SessionEvent, { type: 'message.committed' }> => (
    event.type === 'message.committed'
    && event.payload.messageId === started.payload.inputMessageId
  )) ?? null;
}

function providerReasoning(
  completion: CompletedProviderTurnEvent | undefined,
  providerRequestId: string,
): Pick<ModelMessage, 'reasoningContent' | 'reasoningSignature' | 'providerItems'> {
  if (!completion) {
    throw new LoopFailure(
      'provider_message_completion_missing',
      `Provider 输出消息缺少完成事实：${providerRequestId}`,
    );
  }
  return {
    ...(completion.payload.reasoningContent !== undefined
      ? { reasoningContent: completion.payload.reasoningContent }
      : {}),
    ...(completion.payload.reasoningSignature !== undefined
      ? { reasoningSignature: completion.payload.reasoningSignature }
      : {}),
    ...(completion.payload.hostedWebSearchCalls !== undefined
      ? {
          providerItems: completion.payload.hostedWebSearchCalls
            .map((item) => structuredClone(item)),
        }
      : {}),
  };
}

function mergeNarrativeIntoProviderCall(
  messages: ContextMessageContribution[],
  completion: CompletedProviderTurnEvent | undefined,
  narrative: Extract<SessionEvent, { type: 'narrative.committed' }>,
): boolean {
  if (!completion) {
    throw new LoopFailure(
      'provider_message_completion_missing',
      `Provider narrative 缺少完成事实：${narrative.payload.providerRequestId}`,
    );
  }
  const callIds = new Set(completion.payload.toolCallInputs?.map((call) => call.callId) ?? completion.payload.orderedCallIds);
  if (callIds.size === 0) return false;
  const targets = messages.filter((contribution) => (
    contribution.message.toolCalls?.some((call) => callIds.has(call.callId))
  ));
  if (targets.length !== 1) {
    throw new LoopFailure(
      'provider_turn_call_projection_split',
      '同一 Provider turn 的 narrative 与工具调用没有投影到唯一 Assistant 消息。',
    );
  }
  targets[0]!.contributionId = `narrative:${narrative.payload.narrativeId}`;
  targets[0]!.label = '运行叙述';
  targets[0]!.message.content = narrative.payload.content;
  targets[0]!.sourceSequence = narrative.sequence;
  return true;
}

function isCompletedProviderTurn(event: SessionEvent): event is CompletedProviderTurnEvent {
  return event.type === 'provider.turn.settled' && event.payload.outcome === 'completed';
}

function applyProviderTurnCompletions(
  messages: ContextMessageContribution[],
  events: readonly SessionEvent[],
): void {
  const messageByCallId = new Map<string, ModelMessage>();
  for (const contribution of messages) {
    for (const call of contribution.message.toolCalls ?? []) {
      if (messageByCallId.has(call.callId)) {
        throw new LoopFailure('provider_call_projection_duplicate', '同一 LogicalCallId 被重复投影。');
      }
      messageByCallId.set(call.callId, contribution.message);
    }
  }
  for (const event of events) {
    if (
      event.type !== 'provider.turn.settled'
      || event.payload.outcome !== 'completed'
      || event.payload.purpose !== 'agent'
    ) continue;
    const turnMessages = new Set<ModelMessage>();
    let projectedCallCount = 0;
    for (const callId of event.payload.orderedCallIds) {
      const message = messageByCallId.get(callId);
      if (!message) continue;
      projectedCallCount += 1;
      turnMessages.add(message);
    }
    if (
      projectedCallCount > 0
      && projectedCallCount !== event.payload.orderedCallIds.length
    ) {
      throw new LoopFailure(
        'provider_turn_call_projection_partial',
        '上下文边界拆分了同一 Provider turn 的调用事实。',
      );
    }
    for (const message of turnMessages) {
      if (event.payload.reasoningContent !== undefined) {
        message.reasoningContent = event.payload.reasoningContent;
      }
      if (event.payload.reasoningSignature !== undefined) {
        message.reasoningSignature = event.payload.reasoningSignature;
      }
      if (event.payload.hostedWebSearchCalls !== undefined) {
        message.providerItems = event.payload.hostedWebSearchCalls
          .map((item) => structuredClone(item));
      }
    }
  }
}

function attachToolCall(
  messages: ContextMessageContribution[],
  call: NonNullable<ModelMessage['toolCalls']>[number],
): void {
  const last = messages.at(-1);
  if (
    last?.message.role === 'assistant'
    && !last.message.toolCalls?.some((candidate) => candidate.callId === call.callId)
  ) {
    last.message.toolCalls = [...(last.message.toolCalls ?? []), call];
    return;
  }
  messages.push({
    contributionId: `tool-call:${call.callId}`,
    contributionKind: 'journalMessages',
    label: call.name,
    message: { role: 'assistant', content: '', toolCalls: [call] },
  });
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'filesystemReferences',
] as const;

function buildContextCompositionPartitions(
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  hostedTools: readonly ProviderRequest['hostedTools'][number][],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  filesystemReferenceFactsByContributionId: ReadonlyMap<string, readonly unknown[]>,
): NonNullable<ContextCompositionReceipt['partitions']> {
  const metrics = new Map(CONTEXT_PARTITION_ORDER.map((kind) => [kind, {
    itemCount: 0,
    requestShapeUnits: 0,
  }]));
  const add = (
    kind: typeof CONTEXT_PARTITION_ORDER[number],
    itemCount: number,
    requestShapeUnits: number,
  ): void => {
    const metric = metrics.get(kind)!;
    metric.itemCount += itemCount;
    metric.requestShapeUnits += requestShapeUnits;
  };
  for (const contribution of selected) {
    const messageUnits = jsonShapeUnits(contribution.message);
    const references = filesystemReferenceFactsByContributionId.get(contribution.contributionId)
      ?? [];
    const referenceUnits = Math.min(
      messageUnits,
      references.length ? jsonShapeUnits(references) : 0,
    );
    if (references.length > 0) {
      add('filesystemReferences', references.length, referenceUnits);
    }
    if (contribution.contributionKind === 'workspaceBindings') {
      add('workspaceBindings', workspaceBindings.length, messageUnits - referenceUnits);
    } else {
      add(contribution.contributionKind, 1, messageUnits - referenceUnits);
    }
  }
  add('sessionControls', controlTools.length, sumShapeUnits(controlTools));
  add(
    'tools',
    kernelTools.length + hostedTools.length,
    sumShapeUnits(kernelTools) + sumShapeUnits(hostedTools),
  );
  return CONTEXT_PARTITION_ORDER.map((kind) => ({ kind, ...metrics.get(kind)! }));
}

function sumShapeUnits(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => total + jsonShapeUnits(value), 0);
}

function jsonShapeUnits(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded ? new TextEncoder().encode(encoded).byteLength : 0;
}

function contextCompositionBlocks(message: ModelMessage): ContextCompositionMessage['blocks'] {
  const blocks: ContextCompositionMessage['blocks'] = [];
  const append = (
    block:
      | { kind: 'text' | 'reasoning' }
      | { kind: 'toolCall'; callId: string; toolName: string }
      | { kind: 'toolResult'; resultForCallId: string }
      | { kind: 'hostedWebSearch'; providerCallId: string },
  ): void => {
    blocks.push({ ...block, blockIndex: blocks.length } as ContextCompositionMessage['blocks'][number]);
  };
  if (message.role === 'tool' && message.toolCallId) {
    append({ kind: 'toolResult', resultForCallId: message.toolCallId });
    return blocks;
  }
  if (message.providerOutputBlocks) {
    for (const block of message.providerOutputBlocks) {
      switch (block.kind) {
        case 'reasoning':
          append({ kind: 'reasoning' });
          break;
        case 'narrative':
        case 'finalMessage':
          append({ kind: 'text' });
          break;
        case 'toolCall':
        case 'toolCallRejected':
          append({ kind: 'toolCall', callId: block.callId, toolName: block.toolName });
          break;
        case 'providerHosted':
          append({ kind: 'hostedWebSearch', providerCallId: block.providerCallId });
          break;
      }
    }
    return blocks;
  }
  if (message.reasoningContent) append({ kind: 'reasoning' });
  for (const item of message.providerItems ?? []) {
    if (item.type === 'web_search_call' && typeof item.id === 'string') {
      append({ kind: 'hostedWebSearch', providerCallId: item.id });
    }
  }
  if (message.content) append({ kind: 'text' });
  for (const call of message.toolCalls ?? []) {
    append({ kind: 'toolCall', callId: call.callId, toolName: call.name });
  }
  return blocks;
}

const CONTEXT_MESSAGE_KINDS: readonly ContextCompositionMessage['contributionKind'][] = [
  'instructions',
  'workspaceBindings',
  'sessionControls',
  'journalMessages',
  'contextProviders',
];

function messageContentForModel(
  payload: Extract<SessionEvent, { type: 'message.committed' }>['payload'],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
): string {
  const sections = [payload.content];
  if (payload.guidanceReferences?.length) sections.push(`Explicit guidance references for this message. Read relevant supplied content using the named registered tool; these references do not activate an execution plugin:\n${JSON.stringify(payload.guidanceReferences)}`);
  if (payload.filesystemReferences?.length) {
    if (payload.filesystemReferences.some((reference) => reference.kind === 'file' && reference.source === 'pastedText')) {
      sections.push('Pasted text is attached below. Read its full contents with fs.read using nextByte before acting on this request. Interpret quoted documents and examples as supplied material; the user request determines their role.');
    }
    const workspaceHandleById = new Map(workspaceBindings.map((binding, index) => [
      binding.workspaceId,
      index === 0 ? 'primary' : `workspace${index + 1}`,
    ]));
    sections.push(`Filesystem references attached to this message. Images are identified by referenceId; consult Current visual inputs for the pixels included in this request. Other file contents require the relevant read tool. Input snapshots are read-only. Use the listed DeepCode-managed session working directory for editable copies and preview drafts; they persist across turns until the session is deleted:\n${JSON.stringify(
      payload.filesystemReferences.map((reference) => ({
        referenceId: reference.referenceId,
        workspace: workspaceHandleById.get(reference.workspaceId) ?? 'unavailable',
        path: reference.logicalPath,
        displayName: reference.displayName,
        kind: reference.kind,
        ...(reference.kind === 'file'
          ? { mediaType: reference.mediaType, byteLength: reference.byteLength, ...(reference.source ? { source: reference.source } : {}) }
          : {}),
      })),
    )}`);
  }
  return sections.join('\n\n');
}

function toolResultForModel(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.outcome === 'completed') {
    const output = toolOutputForModel(record, record.output);
    return { recordId: record.recordId, outcome: record.outcome, output };
  }
  if (record.outcome === 'failed') {
    const output = record.output === undefined ? undefined : toolOutputForModel(record, record.output);
    return {
      recordId: record.recordId,
      outcome: record.outcome,
      ...(output === undefined ? {} : { output }),
      error: record.error,
    };
  }
  if (record.outcome === 'indeterminate') {
    return { outcome: record.outcome, error: record.error };
  }
  return {
    outcome: record.outcome,
    ...('error' in record && record.error ? { error: record.error } : {}),
  };
}

/** Project only known first-party storage fields; extension business output is opaque. */
function toolOutputForModel(record: ToolExecutionRecord, value: unknown): unknown {
  const output = structuredClone(value);
  if (!isRecord(output)) return output;
  if (['fs.write', 'fs.edit', 'fs.delete', 'bash', 'powershell', 'container', 'document.render', 'browser.capture'].includes(record.toolName)) {
    delete output.fileChanges;
  }
  if (['artifact.prepare', 'artifact.preview', 'document.render', 'browser.capture', 'browser.observe', 'computer.control'].includes(record.toolName)
    && Array.isArray(output.artifacts)) {
    const archivedPaths = new Set<string>();
    for (const artifact of output.artifacts) {
      if (!isRecord(artifact) || typeof artifact.artifactId !== 'string'
        || artifact.uri !== `artifact://${artifact.artifactId}` || typeof artifact.contentRef !== 'string') continue;
      archivedPaths.add(artifact.contentRef);
      delete artifact.contentRef;
    }
    if (typeof output.contentRef === 'string' && archivedPaths.has(output.contentRef)) delete output.contentRef;
  }
  if ((record.toolName === 'web.search' || record.toolName === 'web.fetch') && isRecord(output.archive)) {
    delete output.archive.timelinePath;
    if (Object.keys(output.archive).length === 0) delete output.archive;
  }
  if (record.toolName === 'computer.control' && record.input.action !== 'status'
    && isRecord(output.diagnostics) && isRecord(output.diagnostics.native)) {
    delete output.diagnostics.native.executor;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function processContext(job: import('@deepcode/protocol').ManagedProcessSnapshot): unknown {
  // Bound each appended snapshot; the complete output remains in Kernel storage.
  const { result, output } = job;
  const details = isRecord(result) ? { ...result } : result;
  if (isRecord(details)) { delete details.stdout; delete details.stderr; }
  return { jobId: job.jobId, command: job.command, status: job.status,
    ...(job.error ? { error: job.error } : {}),
    output: { ...output, stdout: output.stdout.slice(-2000), stderr: output.stderr.slice(-2000),
    truncated: output.truncated || output.stdout.length > 2000 || output.stderr.length > 2000 },
    ...(details !== undefined ? { result: details } : {}) };
}
