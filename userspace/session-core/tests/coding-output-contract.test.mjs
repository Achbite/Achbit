import assert from 'node:assert/strict';
import test from 'node:test';
import { codingToolView } from '../dist/local-agent/codingTools.js';
import { toolResultContent } from '../dist/local-agent/modelToolResult.js';
import { createProviderToolAliases, createProviderToolCodec, decodeProviderToolInput, encodeProviderMessage } from '../dist/local-agent/providerToolCodec.js';

const startByte = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const read = { name: 'fs.read', origin: 'coreBuiltin', availability: 'callable', description: 'Read files or directories.',
  possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1 }, startByte } } };
const readOnly = createProviderToolCodec(codingToolView([read]), [], createProviderToolAliases([read.name], [], true),
  [{ workspaceId: 'workspace:source', displayName: 'Source' }], undefined, true);
const render = (toolName, output, input = {}, error) => toolResultContent({ toolName, input, output,
  preparedEffect: { origin: 'coreBuiltin', operation: toolName }, outcome: error ? 'failed' : 'completed', error,
}, undefined, readOnly.workspaceHandleById, true);

test('read-only coding exposes the bounded Kernel byte cursor without adding another tool', () => {
  assert.deepEqual(readOnly.definitions.map(tool => tool.name), ['read']);
  const { properties } = readOnly.definitions[0].inputSchema;
  assert.deepEqual(Object.keys(properties).sort(), ['limit', 'offset', 'path', 'startByte', 'workspace']);
  const { description, ...constraints } = properties.startByte;
  assert.deepEqual(constraints, startByte);
  assert.match(description, /nextByte/u);
});

test('coding read resumes from the returned UTF-8 byte cursor and reconstructs both long lines exactly', () => {
  const path = 'records.txt', window = 50 * 1024;
  // First window stops two bytes before the limit so as not to split the next emoji.
  // The next window crosses a newline, but ends halfway through the following line.
  const first = '界'.repeat(17066), middle = '🙂\n' + '字'.repeat(17065), last = '尾🙂\r\n';
  const pages = new Map([[0, { content: first, startLine: 1, truncated: true, byteTruncated: true, nextByte: 51198 }],
    [51198, { content: middle, startLine: 1, truncated: true, byteTruncated: true, nextByte: 102398 }],
    [102398, { content: last, startLine: 2, truncated: false, byteTruncated: false }]]);
  let input = { path, workspace: 'primary' }, recovered = '';
  for (let page = 0; page < pages.size; page++) {
    const kernel = decodeProviderToolInput(readOnly, read.name, input);
    assert.deepEqual(kernel, { path, workspaceId: 'workspace:source', maxBytes: window, ...(page ? { startByte: input.startByte } : {}) });
    const replay = encodeProviderMessage({ role: 'assistant', content: '', toolCalls: [{ name: read.name, callId: `page:${page}`, input: kernel }] }, readOnly);
    assert.deepEqual(replay.toolCalls[0].input, input);
    const receipt = pages.get(kernel.startByte ?? 0);
    assert.ok(receipt, 'the returned byte cursor must address the next UTF-8 window');
    const body = render(read.name, receipt, kernel);
    if (!receipt.truncated) { recovered += body; break; }
    const { content, nextByte } = JSON.parse(body);
    assert.equal(nextByte, receipt.nextByte);
    recovered += content;
    input = { path, workspace: 'primary', startByte: nextByte };
  }
  assert.ok(Buffer.from(recovered).equals(Buffer.from(first + middle + last)), 'no byte may be omitted or duplicated');
});

test('coding line and directory pagination still use the returned one-based offset', () => {
  for (const [result, text] of [[{ content: 'first\n', nextByte: 6 }, 'first\n'], [{ entries: [{ name: 'sub', kind: 'directory' }] }, 'sub/']]) {
    assert.equal(render(read.name, { ...result, truncated: true, nextStartLine: 2 }), `${text}\n\n[Output truncated. Use offset=2 to continue.]`);
  }
});

test('coding shell preserves separate pipes, errors and exit codes without implying cross-stream order', () => {
  const stdout = 'first\n[stderr]\nlast', stderr = 'one\n[stdout]\ntwo\n';
  const fullOutput = { stdout: { path: '/archive/out', bytes: 80000 }, stderr: { path: '/archive/err', bytes: 80000 } };
  for (const shell of ['bash', 'powershell']) {
    const error = { code: `${shell}_exit_nonzero`, message: 'The command failed.' };
    const result = { stdout, stderr, exitCode: 7, truncated: true, fullOutput };
    assert.deepEqual(JSON.parse(render(shell, { ...result, terminal: false }, {}, error)), { error, result });
    assert.deepEqual(JSON.parse(render(shell, { stdout: '', stderr, exitCode: 0, terminal: false })), { stderr, exitCode: 0 });
  }
});

test('coding shell leaves plain stdout and the single ordered PTY stream verbatim', () => {
  for (const terminal of [false, true]) {
    const stdout = ' first\r\nsecond\n';
    assert.equal(render('bash', { terminal, stdout, stderr: '', exitCode: 0 }), stdout);
  }
  assert.equal(render('bash', { stdout: '', stderr: '', exitCode: 0 }), '(no output)');
});
