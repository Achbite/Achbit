export const BUILTIN_FONTS = {
  warm: 'DeepCodeQuietTerminalReadingSC-Regular',
  'warm-sans': 'DeepCodeQuietTerminalReadingSansSC-Regular',
  'compact-kai': 'DeepCodeQuietTerminalMonoKaiSC-Regular',
  compact: 'DeepCodeQuietTerminalMonoSC-Regular',
};

export function fontPreference(settings, defaults, choice = 'follow') {
  if (choice !== 'follow' && choice !== 'system' && !Object.hasOwn(BUILTIN_FONTS, choice)) {
    throw new Error(`Unknown built-in font: ${choice}`);
  }
  const value = key => settings[key] ?? defaults[key];
  const group = value('gui.terminalFontFamily');
  const family = choice === 'follow' ? (group === 'inherit' ? value('gui.fontFamily') : group) : choice;
  if (typeof family !== 'string' || !family.trim() || family.length > 120 || /[\x00-\x1f;{}<>]/.test(family)) {
    throw new Error('Invalid terminal font family.');
  }
  const size = value('gui.codeFontSize');
  if (!Number.isInteger(size) || size < 10 || size > 18) throw new Error('Code font size must be an integer from 10 to 18.');
  return {
    family, size,
    name: BUILTIN_FONTS[family] ?? ({ system: 'Menlo-Regular', mono: 'Menlo-Regular', sans: 'Arial', serif: 'Georgia' })[family] ?? family.trim(),
    file: Object.hasOwn(BUILTIN_FONTS, family) ? `${BUILTIN_FONTS[family]}.ttf` : null,
  };
}

export function windowArguments(args) {
  const forward = [];
  let font = 'follow';
  let inPlace = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--font') {
      font = args[++index];
      if (font !== 'follow' && font !== 'system' && !Object.hasOwn(BUILTIN_FONTS, font)) throw new Error('Expected --font follow|warm|warm-sans|compact-kai|compact|system');
    } else if (args[index] === '--in-place') inPlace = true;
    else forward.push(args[index]);
  }
  return { font, inPlace, forward };
}

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
