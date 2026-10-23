// Windows consumes the same settings and protocol defaults as the macOS adapter.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fontPreference } from './macos/font-preferences.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try {
  const { DEFAULT_USER_SETTINGS } = await import(pathToFileURL(join(here, '../node_modules/@achbit/protocol/dist/index.js')));
  const settings = JSON.parse(readFileSync(0, 'utf8'));
  const font = fontPreference(settings, DEFAULT_USER_SETTINGS, process.argv[2] ?? 'follow', 'win32');
  console.log(JSON.stringify({ ...font, file: font.file ? join(here, 'fonts', font.file) : null }));
} catch (error) {
  console.error(`Font preference read failed: ${error.message}`);
  process.exitCode = 1;
}
