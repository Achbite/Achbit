// Review changed GUI operations and styles. Only a proven catalog bypass is a failure.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const gui = fileURLToPath(new URL('..', import.meta.url));
const src = resolve(gui, 'src');
const extensions = /\.(?:[cm]?[jt]sx?|css|html)$/i;
const native = new Map(Object.entries({
  button: 'Button / IconButton', summary: 'DisclosureSummary', select: 'NativeSelect',
  dialog: 'ModalDialog', svg: 'UiIcon', input: '原生字段或 ToggleSwitch',
}));

export function catalogViolation(file, specifier) {
  if (relative(src, file).split('\\').join('/').startsWith('ui-components/')) return;
  const target = specifier.startsWith('/src/') ? join(src, specifier.slice(5)) : resolve(dirname(file), specifier);
  const key = relative(src, target).split('\\').join('/').replace(/\.[cm]?[jt]sx?$/, '');
  if (key === 'icons/registry' || (key.startsWith('ui-components/') && key !== 'ui-components/index')) {
    return '请通过 ui-components 公共入口导入 ' + specifier;
  }
}

export function reviewSource(file, source, ranges) {
  const hits = [];
  const added = (start, end) => ranges.some(([a, b]) => a <= end && start <= b);
  const lines = source.split(/\r?\n/);
  const report = (line, kind, detail) => hits.push({ line, kind, detail });
  if (extname(file) === '.css') {
    // Keep every changed selector (including state selectors) visible even when only a declaration changed.
    let selector = '';
    for (const [i, text] of lines.entries()) {
      const opens = [...text.matchAll(/(?:^|[{}])\s*([^{}]+?)\s*\{/g)].map(match => match[1].trim());
      if (opens.length) selector = opens.at(-1);
      if (added(i + 1, i + 1) && text.trim() && !/^\s*}/.test(text)) {
        for (const label of opens.length ? opens : [selector || text.trim()]) {
          if (hits.at(-1)?.detail !== label) report(i + 1, 'style', label);
        }
      }
    }
  } else if (extname(file) === '.html') {
    let line = 1, offset = 0;
    for (const match of source.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi)) {
      line += source.slice(offset, match.index).split('\n').length - 1;
      offset = match.index;
      const tag = match[1].toLowerCase();
      if (added(line, line + match[0].split('\n').length - 1) &&
          (native.has(tag) || /\b(?:role|tabindex|on\w+)\s*=/i.test(match[2]))) {
        report(line, 'control', tag + ' · ' + (native.get(tag) ?? '交互语义'));
      }
    }
  } else {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const line = offset => ast.getLineAndCharacterOfPosition(offset).line + 1;
    const visit = node => {
      const start = line(node.getStart(ast)), end = line(node.getEnd());
      if (!added(start, end)) return;
      const spec = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier :
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (spec && ts.isStringLiteral(spec)) {
        const issue = catalogViolation(file, spec.text);
        if (issue) report(start, 'error', issue);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        const props = node.attributes.properties.map(attr => attr.name?.getText(ast)).filter(Boolean);
        if (native.has(tag) || /^[A-Z]/.test(tag) || props.some(p => /^(?:on[A-Z]|role$|tabIndex$|aria-)/.test(p))) {
          const label = node.attributes.properties.find(p => p.name?.getText(ast) === 'aria-label');
          const name = label?.initializer?.getText(ast) ?? '';
          report(start, 'control', [tag, name, native.get(tag)].filter(Boolean).join(' · '));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  // Include changed state handlers, children, markup or styles outside a recognized control.
  for (const [start, end] of ranges) {
    if (!hits.some(hit => hit.line >= start && hit.line <= end)) {
      report(start, 'context', lines[start - 1]?.trim().slice(0, 120) || '检查变更上下文');
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

export async function sourceFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return extensions.test(path) ? [path] : [];
  const list = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name) || entry.isSymbolicLink()) continue;
    list.push(...await sourceFiles(join(path, entry.name)));
  }
  return list;
}

async function main() {
  const { values } = parseArgs({ options: {
    base: { type: 'string', default: 'HEAD' }, source: { type: 'string', multiple: true, default: [] }, json: { type: 'boolean' },
  } });
  const git = (...args) => execFileSync('git', ['-C', gui, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const root = git('rev-parse', '--show-toplevel').trim();
  const commit = git('rev-parse', '--verify', '--end-of-options', values.base + '^{commit}').trim();
  const scopes = ['src', 'tests/manual'];
  const changed = git('diff', '--name-only', '--diff-filter=ACMRT', '-z', commit, '--', ...scopes).split('\0').filter(Boolean);
  const pending = new Map(changed.filter(p => extensions.test(p)).map(p => [join(root, p), 'diff']));
  const untracked = git('ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...scopes).split('\0');
  for (const p of untracked.filter(p => extensions.test(p))) pending.set(join(root, p), 'all');
  for (const path of values.source) {
    for (const file of await sourceFiles(isAbsolute(path) ? path : resolve(path))) pending.set(file, 'all');
  }
  const items = [];
  for (const [file, scope] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
    const source = await readFile(file, 'utf8');
    const path = relative(root, file);
    let ranges = [[1, source.split('\n').length]];
    if (scope === 'diff') {
      const diff = git('diff', '--no-color', '--no-ext-diff', '-U0', commit, '--', ':(top,literal)' + path);
      ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
        .filter(match => match[2] !== '0').map(match => [+match[1], +match[1] + Number(match[2] ?? 1) - 1]);
    }
    for (const item of reviewSource(file, source, ranges)) items.push({ path, ...item });
  }
  if (values.json) console.log(JSON.stringify(items, null, 2));
  else {
    for (const item of items) console.log(`${item.kind.padEnd(7)} ${item.path}:${item.line}  ${item.detail}`);
    console.log(`共 ${items.length} 条记录。control、style、context 供逐项审阅，error 表示绕过组件公共入口。`);
  }
  if (items.some(item => item.kind === 'error')) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
