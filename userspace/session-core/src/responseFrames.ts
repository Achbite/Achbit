import { LOCAL_AGENT_PROTOCOL_VERSION } from '@achbit/protocol';

/** A logical reply may span multiple bounded NDJSON transport frames. */
export function* responseFrames(value: unknown): Generator<string> {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength <= 1024 * 1024) {
    yield encoded;
    return;
  }
  for (let offset = 0, index = 0; offset < encoded.length; index += 1) {
    let end = Math.min(offset + 128 * 1024, encoded.length);
    const last = encoded.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield JSON.stringify({
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      type: 'response.chunk', index, final: end === encoded.length,
      text: encoded.slice(offset, end),
    });
    offset = end;
  }
}
