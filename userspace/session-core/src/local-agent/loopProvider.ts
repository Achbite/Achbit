import {
  SESSION_CONTROL_PLAN_PUBLISH, SESSION_CONTROL_INTERACTION_REQUEST, SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT, SESSION_CONTROL_SESSION, SESSION_CONTROL_AGENT,
  SESSION_CONTROL_TODO_UPDATE,
} from '@achbit/protocol';
import type {
  ProviderRequest, ProviderEvent, ProviderTokenUsage, JsonObject, ProviderOutputBlock, ProviderToolCallInput,
  AssistantDraftProjection, ProviderActivityProjection, AssistantDraftBlockProjection,
} from '@achbit/protocol';
import type {
  AgentLoopDeps, ProviderTurnCompletion, ProviderTurn, DecodedProviderOutputBlock, ProviderDispatchCall,
  ProviderControlRejection,
} from './loopTypes.js';
import { withProviderAttempts } from './providerAttempts.js';
import { LoopFailure, ProviderReportedFailure } from './loopFailure.js';
import { throwIfAborted, isRecord, positiveOrZeroInteger, positiveInteger } from './loopFacts.js';
import { decodeProviderToolInput } from './providerToolCodec.js';
import type { ProviderToolCodec } from './providerToolCodec.js';
import type { SessionCapabilities } from './plugins.js';
import { PlanPreviewBuffer } from './planPreview.js';
import { agentTurnPolicy, SessionControlError } from './sessionControls.js';
import type { SessionControlCall } from './sessionControls.js';
import { installedControls } from './loopCapabilities.js';
import { APPROVAL_HISTORY_VIEWS } from './approvalReview.js';
import { sessionReadAllowed } from './sessionReading.js';
import { providerTextStreamId } from './streamIdentity.js';

export async function consumeTextProvider(request: ProviderRequest, deps: AgentLoopDeps, signal: AbortSignal) {
  return withProviderAttempts(request, deps, signal, (attempt, onCompleted, onEvent) => (
    consumeTextAttempt(attempt, deps, signal, onCompleted, onEvent)
  ));
}

async function consumeTextAttempt(
  request: ProviderRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  onCompleted: () => void,
  onEvent: (event: ProviderEvent) => void,
): Promise<{
  summary: string;
  completion: ProviderTurnCompletion;
  contextUsage?: ProviderTokenUsage & {
    providerRequestId: string;
    providerRuntimeRef: string;
  };
}> {
  const activity = trackProviderActivity(request, deps);
  let deltas = '';
  let completeMessage: Extract<ProviderEvent, { type: 'assistant.message' }>['data'] | undefined;
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送文本事件。',
      );
    }
    onEvent(event);
    activity.observe(event);
    switch (event.type) {
      case 'text.delta':
        deltas += event.data.text;
        break;
      case 'reasoning.delta':
        break;
      case 'output.item.completed':
        if (
          orderedOutputItems.at(-1)?.outputIndex !== undefined
          && event.data.outputIndex <= orderedOutputItems.at(-1)!.outputIndex
        ) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            '文本决策请求 output item 没有按原生 output_index 递增返回。',
          );
        }
        if (event.data.item.type === 'function_call') {
          throw new LoopFailure(
            'context_compaction_tool_call_invalid',
            '文本决策请求请求不能调用工具或 Session control。',
          );
        }
        if (event.data.item.type === 'web_search_call') {
          throw new LoopFailure(
            'context_compaction_hosted_tool_invalid',
            '文本决策请求请求不能调用 Provider hosted search。',
          );
        }
        orderedOutputItems.push({
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        });
        break;
      case 'assistant.message':
        if (completeMessage !== undefined) {
          throw new LoopFailure(
            'provider_message_duplicate',
            '文本决策请求返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        break;
      case 'tool.call':
        throw new LoopFailure(
          'context_compaction_tool_call_invalid',
          '文本决策请求请求不能调用工具或 Session control。',
        );
      case 'hosted.web-search.completed':
        throw new LoopFailure(
          'context_compaction_hosted_tool_invalid',
          '文本决策请求请求不能调用 Provider hosted search。',
        );
      case 'completed':
        completed = true;
        onCompleted();
        contextUsage = decodeContextUsage(event.data);
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message, event.data.diagnostics);
    }
  }
  throwIfAborted(signal);
  if (!completed) {
    throw new LoopFailure('provider_stream_incomplete', '文本决策请求 Provider 流未产生完成事件。');
  }
  if (orderedOutputItems.length > 0 && completeMessage !== undefined) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      '文本决策请求同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (completeMessage !== undefined && deltas && completeMessage.content !== deltas) {
    throw new LoopFailure('provider_message_mismatch', '文本决策请求最终消息与流式文本不一致。');
  }
  const orderedMessages = orderedOutputItems.flatMap((output) => (
    output.item.type === 'message'
      ? [providerOutputItemText(output.item, 'output_text', true)]
      : []
  ));
  if (orderedMessages.length > 1) {
    throw new LoopFailure(
      'context_compaction_message_count_invalid',
      '文本决策请求必须只产生一个最终消息。',
    );
  }
  const orderedSummary = orderedMessages[0];
  if (orderedSummary !== undefined && deltas && orderedSummary !== deltas) {
    throw new LoopFailure(
      'provider_output_text_mismatch',
      '文本决策请求有序 message item 与流式文本不一致。',
    );
  }
  const summary = (orderedSummary ?? completeMessage?.content ?? deltas).trim();
  if (!summary) {
    throw new LoopFailure('context_compaction_empty', '文本决策请求没有产生结果。');
  }
  return {
    summary,
    completion: {
      providerRequestId: request.requestId,
      purpose: request.purpose,
      providerRuntimeRef: request.providerRuntimeRef,
      orderedCallIds: [],
      ...(completeMessage?.reasoningContent !== undefined
        ? { reasoningContent: completeMessage.reasoningContent }
        : {}),
      ...(completeMessage?.reasoningSignature !== undefined
        ? { reasoningSignature: completeMessage.reasoningSignature }
        : {}),
    },
    ...(contextUsage
      ? {
          contextUsage: {
            ...contextUsage,
            providerRequestId: request.requestId,
            providerRuntimeRef: request.providerRuntimeRef,
          },
        }
      : {}),
  };
}

export async function consumeProvider(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  controls: Pick<NonNullable<SessionCapabilities['controls']>, 'decode'> | undefined,
): Promise<ProviderTurn> {
  return withProviderAttempts(request, deps, signal, (attempt, onCompleted, onEvent) => (
    consumeProviderOutput(attempt, toolCodec, runId, deps, signal, onCompleted, controls, onEvent)
  ));
}

async function consumeProviderOutput(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  onCompleted: () => void,
  controls: Pick<NonNullable<SessionCapabilities['controls']>, 'decode'> | undefined,
  onEvent: (event: ProviderEvent) => void,
): Promise<ProviderTurn> {
  const activity = trackProviderActivity(request, deps);
  deps = { ...deps, updateAssistantDraft: activity.updateDraft,
    recordVisibleResponse: request.purpose === 'agent' ? deps.recordVisibleResponse : undefined };
  let deltas = '';
  let reasoningDeltas = '';
  let completeMessage: {
    messageId: string;
    content: string;
    reasoningContent?: string;
    reasoningSignature?: string;
  } | undefined;
  const providerCalls: Array<{
    providerCallId: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const aggregateCalls: Array<Extract<ProviderEvent, { type: 'tool.call' }>['data']> = [];
  const hostedWebSearchCalls: JsonObject[] = [];
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  const streamedTextByOutputIndex = new Map<number, string>();
  const completedDraftBlocks: NativeAssistantDraftBlock[] = [];
  const planPreview = new PlanPreviewBuffer(toolCodec.wireByCanonical.get(SESSION_CONTROL_PLAN_PUBLISH));
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送事件。',
      );
    }
    onEvent(event);
    activity.observe(event);
    switch (event.type) {
      case 'tool.call.delta': {
        if (event.data.outputIndex !== undefined && orderedOutputItems.some((item) => item.outputIndex === event.data.outputIndex)) {
          throw new LoopFailure('provider_output_delta_after_completion', '工具参数在完成后继续返回。');
        }
        const preview = planPreview.append(event.data);
        if (preview) activity.updatePlanPreview(preview);
        break;
      }
      case 'reasoning.delta': {
        if (event.data.kind !== 'summary') reasoningDeltas += event.data.text;
        break;
      }
      case 'text.delta': {
        if (event.data.text.trim()) await deps.recordVisibleResponse?.(runId);
        deltas += event.data.text;
        if (event.data.outputIndex !== undefined) {
          if (orderedOutputItems.some((output) => output.outputIndex === event.data.outputIndex)) {
            throw new LoopFailure(
              'provider_output_delta_after_completion',
              'Provider 在 output item 完成后继续发送该 item 的正文增量。',
            );
          }
          streamedTextByOutputIndex.set(
            event.data.outputIndex,
            `${streamedTextByOutputIndex.get(event.data.outputIndex) ?? ''}${event.data.text}`,
          );
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            blocks: assistantDraftBlocks(
              request,
              completedDraftBlocks,
              streamedTextByOutputIndex,
            ),
          });
        } else if (orderedOutputItems.length === 0) {
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            blocks: aggregateDraftBlocks(request, deltas),
          });
        }
        break;
      }
      case 'output.item.completed': {
        const previous = orderedOutputItems.at(-1);
        if (previous && event.data.outputIndex <= previous.outputIndex) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            'Provider output item 没有按原生 output_index 递增返回。',
          );
        }
        const output = {
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        };
        orderedOutputItems.push(output);
        const completedDraftBlock = completedAssistantDraftBlock(request, output, toolCodec);
        if (completedDraftBlock) {
          completedDraftBlocks.push(completedDraftBlock);
          if (completedDraftBlock.kind !== 'providerHosted' && completedDraftBlock.content.trim()) await deps.recordVisibleResponse?.(runId);
        }
        streamedTextByOutputIndex.delete(event.data.outputIndex);
        const blocks = assistantDraftBlocks(
          request,
          completedDraftBlocks,
          streamedTextByOutputIndex,
        );
        deps.updateAssistantDraft({ runId, turnId: request.requestId, blocks });
        break;
      }
      case 'assistant.message':
        if (completeMessage) {
          throw new LoopFailure(
            'provider_message_duplicate',
            'Provider 同一 turn 返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        if (event.data.content.trim()) await deps.recordVisibleResponse?.(runId);
        break;
      case 'tool.call':
        aggregateCalls.push(event.data);
        break;
      case 'hosted.web-search.completed':
        hostedWebSearchCalls.push(structuredClone(event.data.item));
        break;
      case 'completed':
        completed = true;
        onCompleted();
        contextUsage = decodeContextUsage(event.data);
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message, event.data.diagnostics);
    }
  }
  throwIfAborted(signal);
  if (!completed) throw new LoopFailure('provider_stream_incomplete', 'Provider 流未产生完成事件。');
  if (
    orderedOutputItems.length > 0
    && (completeMessage !== undefined || aggregateCalls.length > 0 || hostedWebSearchCalls.length > 0)
  ) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      'Provider 同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (request.purpose === 'approvalReview' && hostedWebSearchCalls.length) throw new LoopFailure('approval_review_read_scope', '审批不能调用网络搜索。');
  if (completeMessage) {
    if (
      completeMessage.reasoningContent !== undefined
      && !completeMessage.reasoningContent.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_content_invalid',
        'Provider 返回了空的 reasoningContent。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && !completeMessage.reasoningSignature.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_invalid',
        'Provider 返回了空的 reasoningSignature。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && completeMessage.reasoningContent === undefined
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_without_content',
        'Provider reasoningSignature 缺少对应 reasoningContent。',
      );
    }
    if (deltas && completeMessage.content !== deltas) {
      throw new LoopFailure('provider_message_mismatch', 'Provider 最终消息与流式文本不一致。');
    }
    if (
      reasoningDeltas
      && completeMessage.reasoningContent !== reasoningDeltas
    ) {
      throw new LoopFailure(
        'provider_reasoning_message_mismatch',
        'Provider 最终 reasoningContent 与流式 reasoning 不一致。',
      );
    }
    if (!deltas) {
      deltas = completeMessage.content;
      if (deltas) {
        deps.updateAssistantDraft({
          runId,
          turnId: request.requestId,
          blocks: aggregateDraftBlocks(request, deltas),
        });
      }
    }
  }

  const decodedOutputBlocks = orderedOutputItems.map((output) => (
    reviewOutputBlock(decodeProviderOutputBlock(output, toolCodec), request)
  ));
  const aggregateBlocks = aggregateCalls.map((call, outputIndex) => (
    reviewOutputBlock(decodeProviderOutputBlock({
      outputIndex,
      item: {
        type: 'function_call',
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments ?? JSON.stringify(call.input),
        ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}),
      },
    }, toolCodec), request)
  ));
  // A conflicting control batch is rejected as a whole, before requesting any effect.
  const inputBlocks = [...decodedOutputBlocks, ...aggregateBlocks].filter((block) => (
    block.kind === 'toolCall' || block.kind === 'toolCallRejected'
  ));
  const exclusiveCalls = inputBlocks.filter((block) => (
    block.name === SESSION_CONTROL_INTERACTION_REQUEST || block.name === SESSION_CONTROL_PLAN_PUBLISH
      || block.name === SESSION_CONTROL_PLUGIN_ACTIVATE || block.name === SESSION_CONTROL_ARTIFACT_PRESENT
      || block.name === SESSION_CONTROL_SESSION
      || block.name === SESSION_CONTROL_AGENT && (block.kind !== 'toolCall'
        || agentTurnPolicy(block.input) === 'exclusive')
  ));
  const incompatibleAgentCalls = inputBlocks.filter(block => block.name === SESSION_CONTROL_AGENT
    && block.kind === 'toolCall' && agentTurnPolicy(block.input) === 'agents'
    && inputBlocks.some(other => other.name !== SESSION_CONTROL_AGENT && other.name !== SESSION_CONTROL_TODO_UPDATE));
  const conflictSources = exclusiveCalls.length > 0 ? exclusiveCalls : incompatibleAgentCalls;
  const todoCalls = inputBlocks.filter((block) => block.name === SESSION_CONTROL_TODO_UPDATE);
  const conflict = conflictSources.length > 0 && inputBlocks.length > 1
    ? { calls: conflictSources, reason: '控制调用违反独占或 agent 批次组合规则' }
    : todoCalls.length > 1
      ? { calls: todoCalls, reason: '每个 Provider turn 最多包含一个 todo.update，请合并步骤更新' }
      : undefined;
  if (conflict) {
    const sources = conflict.calls.map(block => `${block.name}${block.kind === 'toolCall' && typeof block.input.action === 'string' ? `(action=${block.input.action})` : ''} [${block.providerCallId}]`).join('、');
    for (const blocks of [decodedOutputBlocks, aggregateBlocks]) {
      for (const [index, block] of blocks.entries()) {
        if (block.kind !== 'toolCall') continue;
        const message = `${conflict.reason}；冲突来源：${sources}。${conflict.calls.includes(block) ? '该调用触发冲突' : '本调用随批次拒绝'}，本批次未执行。`;
        blocks[index] = {
          outputIndex: block.outputIndex,
          item: block.item,
          kind: 'toolCallRejected',
          providerCallId: block.providerCallId,
          name: block.name,
          error: {
            code: 'session_control_turn_conflict',
            message,
            issues: [{ path: '$', rule: 'control_turn', message }],
          },
        };
      }
    }
  }
  for (const block of aggregateBlocks) {
    if (block.kind === 'toolCall') {
      providerCalls.push({
        providerCallId: block.providerCallId,
        name: block.name,
        input: block.input,
      });
    }
  }
  if (decodedOutputBlocks.length > 0) {
    const outputText = decodedOutputBlocks
      .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
        block.kind === 'message'
      ))
      .map((block) => block.content)
      .join('');
    if (deltas && outputText !== deltas) {
      throw new LoopFailure(
        'provider_output_text_mismatch',
        'Provider 有序 message items 与流式文本不一致。',
      );
    }
    if (!deltas && outputText) {
      deltas = outputText;
    }
    for (const block of decodedOutputBlocks) {
      if (block.kind === 'toolCall') {
        providerCalls.push({
          providerCallId: block.providerCallId,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  const orderedReasoningContent = decodedOutputBlocks
    .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'reasoning' }> => (
      block.kind === 'reasoning'
    ))
    .map((block) => block.content)
    .join('');
  const reasoningContent = completeMessage?.reasoningContent
    ?? (orderedReasoningContent || reasoningDeltas || undefined);

  const usage = contextUsage
    ? {
        contextUsage: {
          ...contextUsage,
          providerRequestId: request.requestId,
          providerRuntimeRef: request.providerRuntimeRef,
        },
      }
    : {};
  const narrative = decodedOutputBlocks.length === 0 && deltas.trim() ? deltas : undefined;
  const rejectedCalls = [...decodedOutputBlocks, ...aggregateBlocks].filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'toolCallRejected' }> => (
      block.kind === 'toolCallRejected'
    ),
  );
  const seenCalls = new Set<string>();
  for (const call of [...providerCalls, ...rejectedCalls]) {
    if (!call.providerCallId || seenCalls.has(call.providerCallId)) {
      throw new LoopFailure(
        'provider_tool_call_duplicate',
        'Provider 工具调用标识为空或重复。',
      );
    }
    seenCalls.add(call.providerCallId);
  }
  const seenHostedSearchCalls = new Set(seenCalls);
  for (const item of hostedWebSearchCalls) {
    const callId = typeof item.id === 'string' ? item.id : '';
    if (!callId || seenHostedSearchCalls.has(callId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(callId);
  }
  for (const block of decodedOutputBlocks) {
    if (block.kind !== 'providerHosted') continue;
    if (seenHostedSearchCalls.has(block.providerCallId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(block.providerCallId);
  }
  const logicalCallIds = new Set<string>();
  const calls = providerCalls.map((call) => {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure(
        'logical_call_identity_invalid',
        'Session 必须为每个 Provider call 生成非空、唯一且不复用原生值的 LogicalCallId。',
      );
    }
    logicalCallIds.add(callId);
    return {
      callId,
      providerCallId: call.providerCallId,
      name: call.name,
      input: call.input,
    };
  });
  const logicalCallByProviderCallId = new Map(calls.map((call) => (
    [call.providerCallId, call.callId] as const
  )));
  for (const call of rejectedCalls) {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure('logical_call_identity_invalid', 'Session 拒绝调用缺少独立且唯一的 LogicalCallId。');
    }
    logicalCallIds.add(callId);
    logicalCallByProviderCallId.set(call.providerCallId, callId);
  }
  const orderedMessageBlocks = decodedOutputBlocks.filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
      block.kind === 'message'
    ),
  );
  const hasCalls = calls.length + rejectedCalls.length > 0;
  const lastMessage = orderedMessageBlocks.at(-1);
  const finalOrderedMessage = !hasCalls && lastMessage
    && providerMessagePhase(lastMessage.item) !== 'commentary' ? lastMessage : undefined;
  const declaredFinalMessages = orderedMessageBlocks.filter((block) => (
    providerMessagePhase(block.item) === 'final_answer'
  ));
  if (declaredFinalMessages.some((block) => block !== finalOrderedMessage)) {
    throw new LoopFailure(
      'provider_output_message_phase_conflict',
      'Provider 最终答复之后仍有消息或待处理调用。',
    );
  }
  const isContinuation = request.purpose === 'agent' && !hasCalls
    && orderedMessageBlocks.length > 0
    && orderedMessageBlocks.every((block) => providerMessagePhase(block.item) === 'commentary');
  if (decodedOutputBlocks.length > 0 && !hasCalls && !finalOrderedMessage && !isContinuation) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider 有序 output items 没有产生最终答复消息。',
    );
  }
  const orderedNarratives: Array<{ narrativeId: string; content: string }> = [];
  let orderedFinalMessage: { messageId: string; content: string } | undefined;
  const orderedOutputBlocks = decodedOutputBlocks.map((block): ProviderOutputBlock => {
    switch (block.kind) {
      case 'reasoning':
        return {
          outputIndex: block.outputIndex,
          kind: 'reasoning',
          item: structuredClone(block.item),
        };
      case 'message': {
        if (block.outputIndex === finalOrderedMessage?.outputIndex) {
          const messageId = deps.nextId('message');
          orderedFinalMessage = { messageId, content: block.content };
          return {
            outputIndex: block.outputIndex,
            kind: 'finalMessage',
            messageId,
            item: structuredClone(block.item),
          };
        }
        const narrativeId = deps.nextId('narrative');
        orderedNarratives.push({ narrativeId, content: block.content });
        return {
          outputIndex: block.outputIndex,
          kind: 'narrative',
          narrativeId,
          item: structuredClone(block.item),
        };
      }
      case 'toolCall':
      case 'toolCallRejected': {
        const callId = logicalCallByProviderCallId.get(block.providerCallId);
        if (!callId) {
          throw new LoopFailure(
            'provider_turn_call_fact_mismatch',
            'Provider output toolCall 缺少对应的 Session LogicalCallId。',
          );
        }
        const callBlock = {
          outputIndex: block.outputIndex,
          callId,
          providerCallId: block.providerCallId,
          toolName: block.name,
          item: structuredClone(block.item),
        };
        return block.kind === 'toolCallRejected'
          ? { ...callBlock, kind: 'toolCallRejected', error: structuredClone(block.error) }
          : { ...callBlock, kind: 'toolCall' };
      }
      case 'providerHosted':
        return {
          outputIndex: block.outputIndex,
          kind: 'providerHosted',
          activityId: deps.nextId('activity'),
          providerCallId: block.providerCallId,
          providerToolType: 'web_search',
          item: structuredClone(block.item),
        };
    }
  });
  const completion: ProviderTurnCompletion = {
    providerRequestId: request.requestId,
    purpose: request.purpose,
    providerRuntimeRef: request.providerRuntimeRef,
    orderedCallIds: calls.map((call) => call.callId),
    ...(aggregateBlocks.length > 0 ? {
      toolCallInputs: aggregateBlocks.map((block): ProviderToolCallInput => {
        if (block.kind !== 'toolCall' && block.kind !== 'toolCallRejected') {
          throw new LoopFailure('provider_tool_call_invalid', '聚合工具调用类型无效。');
        }
        return {
          callId: logicalCallByProviderCallId.get(block.providerCallId)!,
          providerCallId: block.providerCallId,
          toolName: block.name,
          arguments: block.item.arguments as string,
          ...(typeof block.item.thoughtSignature === 'string' ? { thoughtSignature: block.item.thoughtSignature } : {}),
          ...(block.kind === 'toolCallRejected' ? { error: structuredClone(block.error) } : {}),
        };
      }),
    } : {}),
    ...(reasoningContent !== undefined
      ? { reasoningContent }
      : {}),
    ...(completeMessage?.reasoningSignature !== undefined
      ? { reasoningSignature: completeMessage.reasoningSignature }
      : {}),
    ...(hostedWebSearchCalls.length > 0
      ? { hostedWebSearchCalls }
      : {}),
    ...(orderedOutputBlocks.length > 0
      ? { orderedOutputBlocks }
      : {}),
  };

  const controlCalls: Array<SessionControlCall & { providerCallId: string }> = [];
  const dispatchCalls: ProviderDispatchCall[] = [];
  const agentBatch = calls.length > 1 && calls.every(call => call.name === SESSION_CONTROL_AGENT || call.name === SESSION_CONTROL_TODO_UPDATE);
  let progress: Extract<ProviderTurn, { kind: 'tools' }>['progress'];
  for (const call of calls) {
    try {
      const isControl = toolCodec.controlDefinitions.some(tool => toolCodec.canonicalByWire.get(tool.name) === call.name);
      const control = isControl ? installedControls(controls).decode(call.callId, call.name, call.input) : null;
      if (control?.kind === 'todoUpdate') progress = { ...control, providerCallId: call.providerCallId };
      else if (control?.kind === 'agent' && (agentBatch || agentTurnPolicy(call.input) === 'tools')) dispatchCalls.push({ ...call, owner: 'agent', operation: control.operation });
      else if (control) controlCalls.push({ ...control, providerCallId: call.providerCallId });
      else dispatchCalls.push({ ...call, owner: 'kernel' });
    } catch (error) {
      if (!(error instanceof SessionControlError)) throw error;
      const rejection: ProviderControlRejection = {
        callId: call.callId,
        providerCallId: call.providerCallId,
        toolName: call.name,
        input: { ...call.input },
        error: { code: error.code, message: error.message },
      };
      if (call.name === SESSION_CONTROL_TODO_UPDATE) {
        progress = { kind: 'controlRejected', rejection };
        continue;
      }
      if (call.name === SESSION_CONTROL_AGENT && (agentBatch || agentTurnPolicy(call.input) === 'tools')) { dispatchCalls.push({ ...call, owner: 'rejected', error: rejection.error }); continue; }
      return {
        kind: 'controlRejected',
        rejection,
        ...(narrative ? { narrative } : {}),
        ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
        ...usage,
        completion,
      };
    }
  }
  const common = {
    ...usage,
    completion,
    ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
  };
  const control = controlCalls[0];
  if (control?.kind === 'pluginActivate' || control?.kind === 'artifactPresent' || control?.kind === 'agent' || control?.kind === 'session') {
    return { ...control, providerCallId: control.providerCallId, ...common };
  }
  if (control?.kind === 'interaction') {
    const interactionId = deps.nextId('interaction');
    if (interactionId === control.callId || interactionId === control.providerCallId) {
      throw new LoopFailure(
        'interaction_identity_invalid',
        'InteractionId、LogicalCallId 与 ProviderCallId 必须是互不复用的独立身份。',
      );
    }
    return {
      kind: 'interaction',
      interactionId,
      callId: control.callId,
      providerCallId: control.providerCallId,
      request: control.request,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (control?.kind === 'plan') {
    return {
      kind: 'plan',
      callId: control.callId,
      draft: control.draft,
      providerCallId: control.providerCallId,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (dispatchCalls.length > 0 || rejectedCalls.length > 0 || progress) {
    return {
      kind: 'tools',
      calls: dispatchCalls,
      ...(progress ? { progress } : {}),
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (isContinuation) return { kind: 'continuation', ...common };
  const answer = orderedFinalMessage ?? (narrative
    ? { content: narrative, messageId: completeMessage?.messageId }
    : undefined);
  if (!answer) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider turn 正常结束，但没有产生最终答复文本。',
    );
  }
  return {
    kind: 'answer',
    content: answer.content,
    ...(answer.messageId ? { messageId: answer.messageId } : {}),
    ...common,
  };
}

function trackProviderActivity(request: ProviderRequest, deps: AgentLoopDeps): {
  updateDraft(draft: AssistantDraftProjection | null): void;
  updatePlanPreview(preview: NonNullable<AssistantDraftProjection['planPreview']>): void;
  observe(event: ProviderEvent): void;
} {
  let draft: AssistantDraftProjection = { runId: request.runId, turnId: request.requestId, blocks: [] };
  const activity: ProviderActivityProjection = {
    purpose: request.purpose, phase: 'waitingResponse', startedAt: new Date().toISOString(),
  };
  const publish = () => deps.updateAssistantDraft({ ...draft, providerAttemptId: request.providerAttemptId, activity: { ...activity } });
  publish();
  return {
    updateDraft(next) {
      // Independent reviews and compaction report activity, never dialogue content.
      if (request.purpose !== 'agent') return;
      draft = next ? { ...next, ...(draft.planPreview ? { planPreview: draft.planPreview } : {}) }
        : { runId: request.runId, turnId: request.requestId, blocks: [] };
      publish();
    },
    updatePlanPreview(preview) {
      if (request.purpose !== 'agent') return;
      draft = { ...draft, planPreview: preview };
      publish();
    },
    observe(event) {
      if (event.type === 'reasoning.delta' && event.data.text) {
        activity.phase = 'reasoning';
        deps.updateReasoning?.(request.requestId, request.runId, event.data.text, event.data.kind ?? 'text');
      }
      else if (event.type === 'text.delta' && event.data.text || event.type === 'tool.call.delta') activity.phase = 'generatingOutput';
      else if (event.type === 'assistant.message') activity.phase = 'generatingOutput';
      else if (event.type === 'output.item.completed') {
        activity.phase = event.data.item.type === 'message' ? 'generatingOutput' : 'awaitingOutput';
      } else if (event.type === 'tool.call' || event.type === 'hosted.web-search.completed') {
        activity.phase = 'awaitingOutput';
      } else return;
      activity.lastContentAt = new Date().toISOString();
      publish();
    },
  };
}

/** Enforce the independent review's read scope before creating any executable call fact. */
function reviewOutputBlock(block: DecodedProviderOutputBlock, request: ProviderRequest): DecodedProviderOutputBlock {
  if (request.purpose !== 'approvalReview') return block;
  if (block.kind === 'providerHosted') throw new LoopFailure('approval_review_read_scope', '审批不能调用网络搜索。');
  if (block.kind !== 'toolCall') return block;
  const allowed = block.name === 'session.read'
    ? block.input.sessionId === request.sessionId && APPROVAL_HISTORY_VIEWS.includes(String(block.input.view ?? 'summary'))
    : block.name === 'fs.read' && request.workspaceBindings.some(binding => binding.workspaceId === block.input.workspaceId);
  if (allowed) return block;
  return { ...block, kind: 'toolCallRejected', error: { code: 'approval_review_read_scope',
    message: '审批只可读取当前会话的任务历史或绑定工作区的关联材料，不能访问其他会话、修改状态或扩大权限。',
    issues: [{ path: '$', rule: 'approval_read_scope', message: 'Use session.read for this session (summary/messages/tools/plans) or fs.read in a bound workspace.' }] } };
}

function decodeProviderOutputBlock(
  output: { outputIndex: number; item: JsonObject },
  toolCodec: ProviderToolCodec,
): DecodedProviderOutputBlock {
  const item = structuredClone(output.item);
  switch (item.type) {
    case 'reasoning':
      return {
        outputIndex: output.outputIndex,
        kind: 'reasoning',
        content: providerOutputItemText(item, 'reasoning_text', false),
        item,
      };
    case 'message': {
      if (item.role !== 'assistant') {
        throw new LoopFailure(
          'provider_output_message_invalid',
          'Provider output message 不是 assistant 消息。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'message',
        content: providerOutputItemText(item, 'output_text', true),
        item,
      };
    }
    case 'function_call': {
      const providerCallId = typeof item.call_id === 'string' ? item.call_id : '';
      const wireName = typeof item.name === 'string' ? item.name : '';
      const canonicalName = toolCodec.canonicalByWire.get(wireName);
      if (!providerCallId || !wireName || typeof item.arguments !== 'string') {
        throw new LoopFailure(
          'provider_tool_call_invalid',
          'Provider function_call 终态事实无效。',
        );
      }
      if (!canonicalName) {
        const message = `Tool ${wireName} is not available in this request. Use the tools declared for this request.`;
        return {
          outputIndex: output.outputIndex,
          kind: 'toolCallRejected',
          providerCallId,
          name: wireName,
          item,
          error: {
            code: 'provider_tool_alias_unknown',
            message,
            issues: [{ path: '$.name', rule: 'declared_tool', message }],
          },
        };
      }
      let input: unknown;
      const rejectInput = (message: string): DecodedProviderOutputBlock => ({
        outputIndex: output.outputIndex,
        kind: 'toolCallRejected',
        providerCallId,
        name: canonicalName,
        item,
        error: {
          code: 'provider_tool_call_arguments_invalid',
          message,
          issues: [{ path: '$', rule: 'json_object', message, expected: 'JSON object' }],
        },
      });
      try {
        input = JSON.parse(item.arguments);
      } catch {
        return rejectInput('Provider function_call arguments 不是有效 JSON。');
      }
      if (!isRecord(input)) {
        return rejectInput('Provider function_call arguments 必须是 JSON 对象。');
      }
      if (canonicalName === 'session.read' && toolCodec.sessionReadScope && !sessionReadAllowed(toolCodec.sessionReadScope, input)) {
        const message = 'The requested session and view are outside this tool declaration.';
        return { outputIndex: output.outputIndex, kind: 'toolCallRejected', providerCallId, name: canonicalName, item,
          error: { code: 'session_read_scope', message, issues: [{ path: '$', rule: 'session_read_scope', message }] } };
      }
      let decodedInput: JsonObject;
      try {
        decodedInput = decodeProviderToolInput(toolCodec, canonicalName, input);
      } catch (error) {
        if (!(error instanceof LoopFailure)) throw error;
        return {
          outputIndex: output.outputIndex,
          kind: 'toolCallRejected',
          providerCallId,
          name: canonicalName,
          item,
          error: {
            code: error.code,
            message: error.message,
            issues: [{ path: '$.workspace', rule: 'workspace_binding', message: error.message }],
          },
        };
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'toolCall',
        providerCallId,
        name: canonicalName,
        input: decodedInput,
        item,
      };
    }
    case 'web_search_call': {
      const providerCallId = typeof item.id === 'string' ? item.id : '';
      if (
        !providerCallId
        || item.status !== 'completed' && item.status !== 'failed'
        || item.action !== undefined && !isRecord(item.action)
      ) {
        throw new LoopFailure(
          'provider_hosted_search_item_invalid',
          'Provider hosted search 终态事实无效。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'providerHosted',
        providerCallId,
        item,
      };
    }
    default:
      throw new LoopFailure(
        'provider_output_item_type_unsupported',
        `Provider 返回了当前合同未支持的 output item 类型：${String(item.type)}`,
      );
  }
}

type NativeAssistantDraftBlock = AssistantDraftBlockProjection & { outputIndex: number };

/** The native phase has the same meaning while streaming and after settlement. */
function providerMessagePhase(item: JsonObject): 'commentary' | 'final_answer' | undefined {
  const phase = item.phase;
  if (phase === undefined || phase === null) return undefined;
  if (typeof phase !== 'string') {
    throw new LoopFailure('provider_output_message_phase_invalid', 'Provider output message 的 phase 不是字符串。');
  }
  if (phase !== 'commentary' && phase !== 'final_answer') {
    throw new LoopFailure(
      'provider_output_message_phase_unsupported',
      `Provider output message 返回了当前合同未支持的 phase：${phase}`,
    );
  }
  return phase;
}

function aggregateDraftBlocks(
  request: ProviderRequest,
  content: string,
): AssistantDraftBlockProjection[] {
  return content ? [{
    kind: 'message',
    content,
    streamId: providerTextStreamId(request.sessionId, request.runId, request.requestId),
  }] : [];
}

function completedAssistantDraftBlock(
  request: ProviderRequest,
  output: { outputIndex: number; item: JsonObject },
  toolCodec: ProviderToolCodec,
): NativeAssistantDraftBlock | null {
  // Draft presentation must not admit tool inputs or interrupt their native stream.
  if (output.item.type === 'function_call' || output.item.type === 'reasoning') return null;
  const block = decodeProviderOutputBlock(output, toolCodec);
  switch (block.kind) {
    case 'reasoning':
    case 'toolCall':
    case 'toolCallRejected':
      return null;
    case 'message': {
      const phase = providerMessagePhase(block.item);
      const kind = phase === 'commentary'
        ? 'narrative'
        : phase === 'final_answer'
          ? 'finalMessage'
          : 'message';
      return {
        outputIndex: block.outputIndex,
        kind,
        content: block.content,
        streamId: providerTextStreamId(
          request.sessionId, request.runId, request.requestId, block.outputIndex,
        ),
      };
    }
    case 'providerHosted': {
      const status = block.item.status;
      const action = block.item.action;
      if (
        status !== 'completed'
        && status !== 'failed'
        || action !== undefined && !isRecord(action)
      ) {
        throw new LoopFailure(
          'provider_hosted_search_item_invalid',
          'Provider hosted search 终态事实无效。',
        );
      }
      return {
        outputIndex: block.outputIndex,
        kind: 'providerHosted',
        providerCallId: block.providerCallId,
        providerToolType: 'web_search',
        status,
        ...(action === undefined ? {} : { action: structuredClone(action) }),
      };
    }
  }
}

function assistantDraftBlocks(
  request: ProviderRequest,
  completedBlocks: readonly NativeAssistantDraftBlock[],
  streamedTextByOutputIndex: ReadonlyMap<number, string>,
): NativeAssistantDraftBlock[] {
  const blocks = [...completedBlocks];
  for (const [outputIndex, content] of streamedTextByOutputIndex) {
    if (content) blocks.push({
      outputIndex, kind: 'message', content,
      streamId: providerTextStreamId(request.sessionId, request.runId, request.requestId, outputIndex),
    });
  }
  return blocks.sort((left, right) => left.outputIndex - right.outputIndex);
}

function providerOutputItemText(
  item: JsonObject,
  partType: 'output_text' | 'reasoning_text',
  required: boolean,
): string {
  const parts = item.content;
  if (!Array.isArray(parts)) {
    if (!required && parts === undefined) return '';
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output item content 不是数组。',
    );
  }
  let text = '';
  for (const part of parts) {
    if (!isRecord(part) || part.type !== partType) continue;
    if (typeof part.text !== 'string') {
      throw new LoopFailure(
        'provider_output_item_content_invalid',
        'Provider output item 文本 part 缺少 text。',
      );
    }
    text += part.text;
  }
  if (required && !text.trim()) {
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output message 没有可显示正文。',
    );
  }
  return text;
}

function decodeContextUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const value = data.usage;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的 usage 不是对象。');
  }
  const inputTokens = positiveOrZeroInteger(value.inputTokens);
  const outputTokens = positiveOrZeroInteger(value.outputTokens);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens);
  const cacheReadPresent = Object.hasOwn(value, 'cacheReadInputTokens');
  const cacheMissPresent = Object.hasOwn(value, 'cacheMissInputTokens');
  const cacheReadInputTokens = !cacheReadPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheReadInputTokens);
  const cacheMissInputTokens = !cacheMissPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheMissInputTokens);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || contextWindowTokens === undefined
    || inputTokens + outputTokens > contextWindowTokens
    || cacheReadPresent !== cacheMissPresent
    || cacheReadPresent && (cacheReadInputTokens === undefined || cacheMissInputTokens === undefined)
    || cacheReadInputTokens !== undefined && cacheMissInputTokens !== undefined
      && cacheReadInputTokens + cacheMissInputTokens !== inputTokens
  ) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的上下文计数无效。');
  }
  return {
    inputTokens,
    outputTokens,
    contextWindowTokens,
    ...(cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens, cacheMissInputTokens: cacheMissInputTokens! }),
  };
}

function assertProviderEvent(event: ProviderEvent, requestId: string): void {
  if (event.requestId !== requestId) {
    throw new LoopFailure('provider_request_identity_mismatch', 'Provider 事件属于其他请求。');
  }
}
