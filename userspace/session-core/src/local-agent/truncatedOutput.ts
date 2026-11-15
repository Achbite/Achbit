import type { LocalAgentError, ProviderEvent, ProviderToolCallInput } from '@achbit/protocol';
import type { ProviderToolCodec } from './providerToolCodec.js';
import { LoopFailure, ProviderReportedFailure } from './loopFailure.js';

/** A failed generation with identifiable calls, never a successful or executable response. */
export class TruncatedToolOutput extends ProviderReportedFailure {
  constructor(readonly failure: LocalAgentError, readonly calls: ProviderToolCallInput[]) {
    super(failure.code, failure.message, failure.diagnostics);
  }
}

export class TruncatedCallCollector {
  readonly #calls = new Map<string, { name: string; arguments: string; order: number; thoughtSignature?: string }>();
  observe(event: ProviderEvent): void {
    if (event.type === 'tool.call.delta') {
      const { callId, name, argumentsDelta, callIndex } = event.data;
      const previous = this.#calls.get(callId);
      if (previous && previous.name !== name) throw new LoopFailure('provider_tool_identity_changed', 'A streamed tool call changed its name.');
      this.#calls.set(callId, { name, arguments: (previous?.arguments ?? '') + argumentsDelta, order: callIndex });
    } else if (event.type === 'tool.call') {
      const call = event.data;
      this.#calls.set(call.callId, { name: call.name, arguments: call.arguments ?? JSON.stringify(call.input),
        order: this.#calls.get(call.callId)?.order ?? this.#calls.size,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
    } else if (event.type === 'output.item.completed' && event.data.item.type === 'function_call') {
      const call = event.data.item;
      if (typeof call.call_id === 'string' && typeof call.name === 'string' && typeof call.arguments === 'string') {
        this.#calls.set(call.call_id, { name: call.name, arguments: call.arguments, order: event.data.outputIndex });
      }
    }
  }

  failure(error: LocalAgentError, codec: ProviderToolCodec, nextId: (kind: string) => string): TruncatedToolOutput | undefined {
    if (error.code !== 'provider_output_truncated' || !this.#calls.size) return;
    const calls: ProviderToolCallInput[] = [...this.#calls].sort((a, b) => a[1].order - b[1].order).map(([providerCallId, call]) => {
      const canonical = codec.canonicalByWire.get(call.name);
      const message = `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
      return { callId: nextId('call'), providerCallId, toolName: canonical ?? call.name, arguments: call.arguments,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        error: { code: canonical ? 'provider_output_truncated' : 'provider_tool_alias_unknown', message,
          issues: [{ path: '$', rule: 'outputTruncated', message }] } };
    });
    return new TruncatedToolOutput(error, calls);
  }
}
