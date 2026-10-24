import type { ShellCommandIntent } from '@achbit/protocol';

/** Display-only command intent, never evidence that a file was opened or a branch ran.
 * Recognize a small set of literal commands. Unknown syntax keeps the raw command UI.
 */
export function shellCommandIntents(command: string, shell = 'bash'): ShellCommandIntent[] {
  const segments = literalCommands(command, shell === 'powershell');
  if (!segments) return [];
  const intents: ShellCommandIntent[] = [];
  for (const { words, piped } of segments) {
    const name = words[0]?.split(/[\\/]/u).at(-1)?.toLowerCase();
    // A directory/environment change makes subsequent relative targets ambiguous.
    if (['cd', 'pushd', 'popd', 'set-location', 'docker', 'ssh', 'eval', 'source', '.'].includes(name ?? '')) break;
    if (!name) continue;
    const powershell = shell === 'powershell';
    const reader = powershell ? ['get-content', 'gc', 'cat', 'type'].includes(name) : ['cat', 'head', 'tail', 'sed'].includes(name);
    const search = ['rg', 'grep'].includes(name) || powershell && name === 'select-string';
    if (!reader && !search) continue;
    const args = words.slice(1), targets: string[] = [], queries: string[] = [];
    let positionalPattern = search || name === 'sed', literal = false, valid = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!literal && arg === '--') { literal = true; continue; }
      if (!literal && arg.startsWith('-') && arg !== '-') {
        const option = arg.toLowerCase();
        const pair = (choices: string[]) => choices.includes(option);
        if (pair(['-e', '--regexp', '--expression', '-pattern'])) {
          const value = args[++i]; if (value === undefined) { valid = false; break; }
          if (search) queries.push(value);
          positionalPattern = false; continue;
        }
        if (powershell && pair(['-path', '-literalpath'])) {
          const value = args[++i]; if (value === undefined) { valid = false; break; }
          targets.push(value); continue;
        }
        const valueOption = search ? ['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context', '--max-depth']
          : name === 'head' || name === 'tail' ? ['-n', '-c', '--lines', '--bytes']
            : powershell ? ['-totalcount', '-tail', '-encoding', '-delimiter'] : [];
        if (valueOption.includes(arg) || powershell && valueOption.includes(option)) {
          if (args[++i] === undefined) { valid = false; break; } continue;
        }
        const flags = search ? /^-[nrilwsvFHoI]+$/u : name === 'cat' ? /^-[nbEsTvA]+$/u
          : name === 'sed' ? /^-[nEr]+$/u : /^-[qv]+$|^-\d+$|^-[nc]\d+$/u;
        if (flags.test(arg) || search && ['--hidden', '--no-ignore', '--line-number', '--ignore-case', '--fixed-strings'].includes(arg)
          || powershell && ['-raw', '-casesensitive', '-simplematch', '-allmatches'].includes(option)) continue;
        valid = false; break;
      }
      if (positionalPattern) { if (search) queries.push(arg); positionalPattern = false; }
      else targets.push(arg);
    }
    if (!valid || positionalPattern || reader && !targets.length || search && !queries.length) continue;
    intents.push({ kind: search ? 'search' : 'read', targets: [...new Set(targets.length ? targets : piped ? [] : ['.'])],
      ...(search ? { query: queries.join(' | ') } : {}) });
  }
  return intents;
}

function literalCommands(command: string, powershell: boolean): Array<{ words: string[]; piped: boolean }> | null {
  const commands: Array<{ words: string[]; piped: boolean }> = [];
  let words: string[] = [], word = '', present = false, quote = '', piped = false;
  const finishWord = () => { if (present) words.push(word); word = ''; present = false; };
  const finishCommand = () => { finishWord(); if (words.length) commands.push({ words, piped }); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) { if (powershell && command[i + 1] === quote) return null; quote = ''; }
      else if (quote === '"' && (powershell ? /[$`]/u : /[$`\\]/u).test(c)) return null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; present = true; continue; }
    if (c === '\\' && !powershell) {
      const next = command[++i]; if (next === undefined) return null;
      if (next !== '\n') { word += next; present = true; }
      continue;
    }
    if (/[$`<>(){}]/u.test(c)) return null;
    if (c === '#' && !present) { while (i < command.length && command[i] !== '\n') i++; finishCommand(); piped = false; continue; }
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      finishCommand(); piped = c === '|' && command[i + 1] !== '|';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
    } else if (/\s/u.test(c)) finishWord();
    else { word += c; present = true; }
  }
  if (quote) return null;
  finishCommand();
  return commands;
}
