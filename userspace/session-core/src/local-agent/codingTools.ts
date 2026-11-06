import type { JsonObject, PreparedToolDescriptor, RunRuntimeSnapshot, ToolExecutionRecord } from '@achbit/protocol';

export const codingToolNames = new Map([
  ['fs.read', 'read'], ['bash', 'bash'], ['powershell', 'powershell'], ['fs.edit', 'edit'], ['fs.write', 'write'],
]);

/** Compose only the basic operations the model can call in this stage, using its actual wire names. */
export function codingToolInstruction(tools: readonly PreparedToolDescriptor[], aliases: ReadonlyMap<string, string>): RunRuntimeSnapshot['instructions'][number] | undefined {
  const descriptions: string[] = [];
  const rules: string[] = [];
  const active = new Set(tools.filter(tool => tool.origin === 'coreBuiltin').map(tool => tool.name));
  for (const canonical of codingToolNames.keys()) {
    const name = aliases.get(canonical);
    if (!name || !active.has(canonical)) continue;
    switch (canonical) {
      case 'fs.read':
        descriptions.push(`- ${name}: Read file or directory contents.`);
        rules.push(`- Use ${name} to examine files.`);
        break;
      case 'bash':
        descriptions.push(`- ${name}: Execute Bash commands.`);
        rules.push(`- Use ${name} for file operations like ls, rg and find, and to run project commands.`);
        break;
      case 'powershell':
        descriptions.push(`- ${name}: Execute PowerShell commands.`);
        rules.push(`- Use ${name} for file operations like Get-ChildItem and Select-String, and to run project commands.`);
        break;
      case 'fs.edit':
        descriptions.push(`- ${name}: Make precise file edits with exact text replacement, including multiple disjoint edits in one call.`);
        rules.push(`- Use ${name} for targeted changes. Batch changes to one file in a single call.`,
          '- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping. Merge nearby changes without including large unchanged regions.');
        break;
      case 'fs.write':
        descriptions.push(`- ${name}: Create or overwrite files.`);
        rules.push(`- Use ${name} only for new files or complete rewrites.`);
        break;
    }
  }
  if (!descriptions.length) return;
  return { id: 'achbit.coding-tools', text: [
    '<tools>', ...descriptions, '</tools>', '', '<rules>', ...rules, '</rules>',
  ].join('\n') };
}

const readBytes = 50 * 1024;
const record = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The coding interface adapts the Kernel bindings. Optional tools keep their own declarations. */
export function codingToolView(tools: readonly PreparedToolDescriptor[]): readonly PreparedToolDescriptor[] {
  return tools.map(tool => {
    if (tool.origin !== 'coreBuiltin' || !codingToolNames.has(tool.name)) return tool;
    const schema = tool.inputSchema;
    if (!record(schema.properties)) return tool;
    const fields = schema.properties;
    let properties: JsonObject;
    let description: string;
    switch (tool.name) {
      case 'fs.read':
        properties = { path: fields.path, offset: { ...fields.startLine as JsonObject, description: 'First line or directory entry to read (1-indexed).' },
          limit: { ...fields.maxLines as JsonObject, description: 'Maximum number of lines or directory entries.' } };
        description = tool.description;
        break;
      case 'fs.edit':
        properties = { path: fields.path, edits: fields.edits };
        description = tool.description;
        break;
      case 'fs.write':
        properties = { path: fields.path, content: fields.content };
        description = 'Write a new file or replace all its contents. Use edit for targeted changes.';
        break;
      default:
        properties = { command: { ...fields.command as JsonObject, description: tool.name === 'bash'
          ? "Preserve the target command's exit status through pipelines and trailing commands."
          : 'Preserve $LASTEXITCODE when reporting the result of a native command.' }, timeout: fields.timeout };
        // Resource and sandbox grants are contributed only when the prepared Shell actually exposes them.
        for (const key of ['requestFileAccess', 'requestHostPermission', 'requestNetworkPermission']) {
          if (fields[key] !== undefined) properties[key] = fields[key];
        }
        description = tool.description;
    }
    return { ...tool, description, inputSchema: { ...schema, properties } };
  });
}

export function decodeCodingRead(input: JsonObject): JsonObject {
  const { offset, limit, ...rest } = input;
  return { ...rest, ...(offset !== undefined ? { startLine: offset } : {}), ...(limit !== undefined ? { maxLines: limit } : {}), maxBytes: readBytes };
}

export function encodeCodingRead(input: JsonObject): JsonObject {
  const { startLine, maxLines, maxBytes: _window, ...rest } = input;
  return { ...rest, ...(startLine !== undefined ? { offset: startLine } : {}), ...(maxLines !== undefined ? { limit: maxLines } : {}) };
}

function shellText(out: JsonObject): string {
  const stdout = typeof out.stdout === 'string' ? out.stdout : '';
  const stderr = typeof out.stderr === 'string' ? out.stderr : '';
  const text = stdout && stderr && !stdout.endsWith('\n') ? stdout + '\n' + stderr : stdout + stderr;
  if (!out.truncated) return text;
  const files = record(out.fullOutput) ? Object.values(out.fullOutput)
    .filter(record).filter(file => Number(file.bytes) > 0 && typeof file.path === 'string').map(file => file.path) : [];
  return [text, files.length ? `[Output truncated. Full output: ${files.join(', ')}]` : '[Output truncated]'].filter(Boolean).join('\n');
}

function readText(out: JsonObject): string | undefined {
  let text: string;
  if (typeof out.content === 'string') text = out.content;
  else if (Array.isArray(out.entries)) text = out.entries.filter(record)
    .map(entry => String(entry.name) + (entry.kind === 'directory' ? '/' : '')).join('\n');
  else return;
  if (!out.truncated) return text;
  let next = out.nextStartLine;
  if (next === undefined && typeof out.startLine === 'number') {
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) return `[Line ${out.startLine} exceeds the read window. Use the shell to read part of that line.]`;
    text = text.slice(0, lastBreak + 1);
    next = out.startLine + text.split('\n').length - 1;
  }
  return `${text}\n\n[Output truncated. Use offset=${next} to continue.]`;
}

/** Only the model-facing body changes. Permission decisions, partial effects and jobs keep their own facts. */
export function codingToolText(call: ToolExecutionRecord): string | undefined {
  if (call.preparedEffect.origin !== 'coreBuiltin' || !codingToolNames.has(call.toolName)) return;
  const out = 'output' in call && record(call.output) ? call.output : {};
  const path = String(call.input.path ?? '');
  if (call.toolName === 'bash' || call.toolName === 'powershell') {
    if (out.job || !('stdout' in out || 'stderr' in out)) return;
    const text = shellText(out);
    if (call.outcome === 'completed') return text || '(no output)';
    if (call.outcome === 'failed') {
      const error = 'error' in call ? call.error : undefined;
      const status = out.timedOut || !Number.isInteger(out.exitCode) || out.exitCode === 0
        || error && error.code !== 'bash_exit_nonzero' && error.code !== 'powershell_exit_nonzero'
        ? error?.message : `Command exited with code ${out.exitCode}`;
      return [text, status].filter(Boolean).join('\n') || undefined;
    }
    return;
  }
  if (call.outcome === 'failed' && 'error' in call && call.error) {
    if (out.saved || out.patched || (Array.isArray(out.fileChanges) && out.fileChanges.length)) return;
    return call.error.message;
  }
  if (call.outcome !== 'completed') return;
  if (call.toolName === 'fs.write') return `Successfully wrote to ${path}.`;
  if (call.toolName === 'fs.edit') return typeof out.editCount === 'number'
    ? `Successfully replaced ${out.editCount} block(s) in ${path}.` : undefined;
  if (Array.isArray(out.modelImages) && out.modelImages.length) return `Read image from ${path}.`;
  return readText(out);
}
