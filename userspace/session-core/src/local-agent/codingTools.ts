import type { JsonObject, PreparedToolDescriptor, RunRuntimeSnapshot, ToolExecutionRecord } from '@achbit/protocol';

export const codingToolNames = new Map([
  ['fs.read', 'read'], ['bash', 'bash'], ['powershell', 'powershell'], ['fs.edit', 'edit'], ['fs.write', 'write'],
]);

/** Shared tools/rules slices for every context; expanded guidance is inserted, never substituted. */
export function codingToolInstruction(tools: readonly PreparedToolDescriptor[], aliases: ReadonlyMap<string, string>,
  expanded = true): RunRuntimeSnapshot['instructions'][number] | undefined {
  const active = tools.filter(tool => tool.availability === 'callable');
  const ordered = [...codingToolNames.keys()].flatMap(name => active.filter(tool => tool.origin === 'coreBuiltin' && tool.name === name));
  const descriptions: string[] = [], rules = new Set<string>();
  const shell = ordered.find(tool => tool.name === 'bash' || tool.name === 'powershell');
  // Optional tools retain their declaration-owned guidance; activation must not rewrite this prefix.
  for (const tool of ordered) {
    const name = aliases.get(tool.name);
    if (!name) continue;
    const guidance = codingToolGuidance(tool.name, name)!;
    descriptions.push(`- ${name}: ${guidance.snippet}`);
    for (const rule of guidance.guidelines) rules.add(rule);
    if (expanded) for (const rule of guidance.additionalGuidelines ?? []) rules.add(rule);
  }
  if (!descriptions.length) return;
  if (expanded) rules.add('Honor declared tool permissions.');
  if (shell && active.some(tool => tool.origin === 'coreBuiltin' && tool.name === 'process')) {
    rules.add('Long shell commands are automatically managed. Continue independent file operations; final command results arrive automatically without polling. Read command-produced files after consuming the command result.');
    rules.add('Use dependency waiting when the next step needs a managed result, and status only for a current snapshot. A wait deadline leaves the command running; cancellation targets the returned job handle.');
  }
  if (expanded && shell) rules.add('Preserve the target exit status in pipelines and diagnostics. Check it before using output. Bound runs and keep ownership of test processes until they exit. Clean up only resources this task is authorized to manage.');
  rules.add('Reply concisely with clear file paths.');
  return { id: 'achbit.coding-tools', text: [
    '<tools>', ...descriptions, 'Additional tools may be available.', '</tools>', '',
    '<rules>', ...[...rules].map(rule => `- ${rule}`), '</rules>',
  ].join('\n') };
}

/** Coding declarations and prompt contributions share one owner, as in PI's tool definitions. */
export function codingToolGuidance(canonical: string, name: string): { snippet: string; guidelines: string[]; additionalGuidelines?: string[] } | undefined {
  switch (canonical) {
    case 'fs.read': return {
      snippet: 'Read file or directory contents', guidelines: [
        `Use ${name} to examine files instead of cat or sed.`,
        'Read paths observed in listings, user input or source directly. Resolve project-root references (such as res://) from their project and file-relative paths from the referring file.',
        'For a symbol or uncertain filename, search the workspace or list the nearest known directory. Distinguish same-name matches by reference or declaration.',
        'After NotFound, check the parent or reference for a verified path.',
      ],
      additionalGuidelines: [
        'Read generated output after its producing command has completed.',
        'Follow returned cursors or full-output paths when truncated.',
      ],
    };
    case 'bash': case 'powershell': return {
      snippet: canonical === 'bash' ? 'Run project commands' : 'Execute PowerShell commands',
      guidelines: [`For unknown paths, use ${name} with ${canonical === 'bash' ? 'ls, rg or find' : 'Get-ChildItem or Select-String'}.`],
    };
    case 'fs.edit': return {
      snippet: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      guidelines: [`Use ${name} for targeted changes. Batch changes to one file in a single call.`,
        'Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.'],
      additionalGuidelines: ['Read the relevant content before editing.'],
    };
    case 'fs.write': return {
      snippet: 'Create or overwrite files', guidelines: [`Use ${name} only for new files or complete rewrites.`],
    };
  }
}

const readBytes = 50 * 1024;
const record = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A presentation selects fields from one captured Kernel definition; it never copies its operation prose. */
export function codingToolView(tools: readonly PreparedToolDescriptor[], coding = true): readonly PreparedToolDescriptor[] {
  return tools.map(tool => {
    if (!coding || tool.origin !== 'coreBuiltin' || !codingToolNames.has(tool.name)) return tool;
    const schema = tool.inputSchema;
    if (!record(schema.properties)) return tool;
    const fields = schema.properties;
    let properties: JsonObject;
    let description = tool.description;
    switch (tool.name) {
      case 'fs.read':
        properties = { path: fields.path,
          ...(fields.startLine === undefined ? {} : { offset: { ...fields.startLine as JsonObject,
            description: 'First line or directory entry to read (1-indexed). Defaults to 1.' } }),
          ...(fields.maxLines === undefined ? {} : { limit: fields.maxLines }) };
        description += `\nText window: ${readBytes / 1024} KiB. Use offset/limit; continue with the returned offset.`;
        break;
      case 'fs.edit': properties = { path: fields.path, edits: fields.edits }; break;
      case 'fs.write': properties = { path: fields.path, content: fields.content }; break;
      default:
        properties = { command: fields.command, ...(fields.timeout === undefined ? {} : { timeout: fields.timeout }) };
        for (const key of ['requestFileAccess', 'requestHostPermission', 'requestNetworkPermission']) {
          if (fields[key] !== undefined) properties[key] = fields[key];
        }
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
    if (call.toolName === 'fs.read' && record(out.details)) return;
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
