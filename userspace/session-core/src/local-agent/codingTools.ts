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
  const reader = ordered.find(tool => tool.name === 'fs.read');
  // Optional tools retain their declaration-owned guidance; activation must not rewrite this prefix.
  for (const tool of ordered) {
    const name = aliases.get(tool.name);
    if (!name) continue;
    const guidance = codingToolGuidance(tool.name, name)!;
    descriptions.push(`- ${name}: ${guidance.snippet}`);
    // Either reader can locate files. Describe the shared workflow once, using this stage's aliases.
    if (tool === (reader ?? shell)) {
      const search = shell && aliases.get(shell.name);
      const commands = shell?.name === 'bash' ? 'ls or find' : 'Get-ChildItem or Select-String';
      const routes = [reader && `${name} to list a known directory`, search && `${search} to search (${commands})`].filter(Boolean).join(' or ');
      rules.add('Read paths observed in listings or input directly: project-root references from the project root; file-relative paths from the referring file.');
      rules.add(`For unknown paths/symbols: Use ${routes}; read hits next batch, same workspace.`);
      rules.add('NotFound/same-name hits: check root and source for a verified path, not a repository name prefix.');
    }
    for (const rule of guidance.guidelines) rules.add(rule);
    if (expanded) for (const rule of guidance.additionalGuidelines ?? []) rules.add(rule);
  }
  if (!descriptions.length) return;
  if (expanded) rules.add('Honor declared tool permissions.');
  const discovery = aliases.get('plugin.search');
  if (shell && discovery && active.some(tool => tool.origin === 'coreBuiltin' && tool.name === 'plugin.search')) {
    rules.add(`For specialized capabilities, use a matching callable tool or check enabled plugins with ${discovery} before writing a replacement script or adding a dependency. Shell commands keep their own permissions; a denied action is not authorized through another tool.`);
  }
  if (shell && active.some(tool => tool.origin === 'coreBuiltin' && tool.name === 'process')) {
    rules.add('Long shell commands are automatically managed. Continue independent file operations; final command results arrive automatically without polling. Read command-produced files after consuming the command result.');
    rules.add('Use dependency waiting when the next step needs a managed result, and status only for a current snapshot. A wait deadline leaves the command running; cancellation targets the returned job handle.');
  }
  if (expanded && shell) rules.add('Preserve the target exit status. Bound runs and keep ownership of test processes until they exit. Clean up only resources this task is authorized to manage.');
  rules.add('Reply concisely with clear file paths.');
  const extraTools = expanded || active.some(tool => tool.origin === 'coreBuiltin' && !codingToolNames.has(tool.name));
  return { id: 'achbit.coding-tools', text: [
    '<tools>', ...descriptions, ...(extraTools ? ['Additional tools may be available.'] : []), '</tools>', '',
    '<rules>', ...[...rules].map(rule => `- ${rule}`), '</rules>',
  ].join('\n') };
}

/** Coding declarations and prompt contributions share one owner, as in PI's tool definitions. */
export function codingToolGuidance(canonical: string, name: string): { snippet: string; guidelines: string[]; additionalGuidelines?: string[] } | undefined {
  switch (canonical) {
    case 'fs.read': return {
      snippet: 'Read file or directory contents', guidelines: [],
      additionalGuidelines: [
        'Read generated output after its producing command has completed.',
        'Follow returned cursors or full-output paths when truncated.',
      ],
    };
    case 'bash': case 'powershell': return {
      snippet: `${canonical === 'bash' ? 'Run project commands' : 'Execute PowerShell commands'} (reading multiple files)`, guidelines: [],
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

// Change field help, never field presence, constraints or binding facts.
function fieldHelp(field: unknown, description: string): unknown {
  return record(field) ? { ...field, description } : field;
}

/** A presentation selects fields from one captured Kernel definition; it never copies its operation prose. */
export function codingToolView(tools: readonly PreparedToolDescriptor[], coding = true, compact = false): readonly PreparedToolDescriptor[] {
  return tools.map(tool => {
    if (!coding || tool.origin !== 'coreBuiltin' || !codingToolNames.has(tool.name)) return tool;
    const schema = tool.inputSchema;
    if (!record(schema.properties)) return tool;
    const fields = schema.properties;
    let properties: JsonObject;
    let description = tool.description;
    switch (tool.name) {
      case 'fs.read':
        properties = { path: compact ? fieldHelp(fields.path, 'Workspace-relative path or an authorized absolute file path.') : fields.path,
          ...(fields.startLine === undefined ? {} : { offset: fieldHelp(fields.startLine,
            compact ? 'First line or directory entry (1-based; default 1).' : 'First line or directory entry to read (1-indexed). Defaults to 1.') }),
          ...(fields.maxLines === undefined ? {} : { limit: fields.maxLines }),
          ...(fields.startByte === undefined ? {} : { startByte: fieldHelp(fields.startByte, compact
            ? 'Files: resume at nextByte, even mid-line. Overrides offset.'
            : 'Files only. Resume at the returned nextByte, even within a line. Takes precedence over offset.') }) };
        if (compact) {
          const lineFields = ['offset', 'limit'].filter(name => properties[name] !== undefined).join('/');
          description += `\n${readBytes / 1024} KiB per call${lineFields ? ` (${lineFields})` : ''}.`;
        } else description += `\nText window: ${readBytes / 1024} KiB. Use offset/limit; follow the returned cursor.`;
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

function stdoutText(out: JsonObject): string {
  const text = typeof out.stdout === 'string' ? out.stdout : '';
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
  // For byte windows use the shared structured { content, nextByte } result; a page can end mid-line.
  if (typeof out.nextStartLine !== 'number') return;
  return `${text}\n\n[Output truncated. Use offset=${out.nextStartLine} to continue.]`;
}

/** Only the model-facing body changes. Permission decisions, partial effects and jobs keep their own facts. */
export function codingToolText(call: ToolExecutionRecord): string | undefined {
  if (call.preparedEffect.origin !== 'coreBuiltin' || !codingToolNames.has(call.toolName)) return;
  const out = 'output' in call && record(call.output) ? call.output : {};
  const path = String(call.input.path ?? '');
  if (call.toolName === 'bash' || call.toolName === 'powershell') {
    if (out.job || !('stdout' in out || 'stderr' in out)) return;
    // Separate pipes have no recorded cross-stream order. Keep the structured shell result
    // when stderr has content; a PTY has already merged its output into stdout in order.
    if (out.stderr) return;
    const text = stdoutText(out);
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
