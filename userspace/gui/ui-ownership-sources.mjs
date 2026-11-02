import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Diagnostic-only source map, extracted from the actual declarations, never a second ID table. */
export async function collectUiSources(directory, repositoryRoot) {
  const sources = {};
  const declarations = new Set();
  const add = (ownerId, node, file, declaration = false) => {
    if (!/^[a-zA-Z][\w.-]*(?:\.\*)?$/.test(ownerId)) throw Error(`Invalid UI owner: ${ownerId}`);
    if (declaration && declarations.has(ownerId)) throw Error(`Duplicate UI owner declaration: ${ownerId}`);
    if (declaration) declarations.add(ownerId);
    let scope = node.parent;
    while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    const symbol = scope?.name?.getText(file)
      ?? (scope && ts.isVariableDeclaration(scope.parent) ? scope.parent.name.getText(file) : 'module');
    const location = { file: relative(repositoryRoot, file.fileName).split('\\').join('/'),
      symbol, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 };
    (sources[ownerId] ??= []).push(location);
  };
  const walk = async path => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) { await walk(name); continue; }
      if (!/\.tsx?$/.test(name) || /\.d\.ts$/.test(name)) continue;
      const file = ts.createSourceFile(name, await readFile(name, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useUiOwner') {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) add(arg.text, node, file, true);
          else if (arg && ts.isTemplateExpression(arg) && arg.head.text === 'region.'
            && arg.templateSpans.length === 1 && arg.templateSpans[0].literal.text === '') add('region.*', node, file, true);
          else throw Error(`UI owner must be an explicit semantic declaration: ${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
          && ['UiRegion', 'UiPluginSlotView'].includes(node.tagName.getText(file))) {
          const slot = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(file) === 'slot');
          const value = slot?.initializer;
          const literal = value && ts.isJsxExpression(value) ? value.expression : value;
          if (literal && ts.isStringLiteral(literal)) add(`region.${literal.text}`, node, file);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  };
  await walk(directory);
  return sources;
}
