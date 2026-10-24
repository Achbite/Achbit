import type { ToolExecutionProgress, ToolOutputProjection } from '@achbit/protocol';

// Same scale as terminal tool output. Full bytes stay in the Kernel archive.
const STREAM_TAIL_CHARACTERS = 32 * 1024;

export class LiveToolOutput {
  readonly #calls = new Map<string, {
    output: ToolOutputProjection;
    stdout: TextDecoder;
    stderr: TextDecoder;
  }>();

  update(callId: string, progress: ToolExecutionProgress): void {
    if (progress.type === 'started') {
      this.#calls.set(callId, {
        output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false },
        stdout: new TextDecoder(), stderr: new TextDecoder(),
      });
      return;
    }
    const current = this.#calls.get(callId);
    if (!current) throw new Error('tool_output_without_started');
    const byteKey = progress.stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
    if (current.output[byteKey] !== progress.offset) throw new Error('tool_output_offset_invalid');
    current.output[byteKey] += progress.bytes.length;
    const text = current.output[progress.stream] + current[progress.stream].decode(
      Uint8Array.from(progress.bytes), { stream: true },
    );
    let start = Math.max(0, text.length - STREAM_TAIL_CHARACTERS);
    // Do not split a supplementary Unicode character at the tail boundary.
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start += 1;
    current.output.truncated ||= start > 0;
    current.output[progress.stream] = text.slice(start);
  }

  get(callId: string): ToolOutputProjection | undefined {
    const value = this.#calls.get(callId)?.output;
    return value ? { ...value } : undefined;
  }

  delete(callId: string): void { this.#calls.delete(callId); }
  clear(): void { this.#calls.clear(); }
}
