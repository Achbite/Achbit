import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function luminance(color) {
  assert.match(color, /^#[0-9a-f]{6}$/i, 'these built-in resting text/surface pairs are opaque');
  const linear = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

test('built-in supporting text remains readable on the resting surfaces that host it', async () => {
  const { tokens, themes } = JSON.parse(await readFile(new URL('../../../config/ui/palette.json', import.meta.url), 'utf8'));
  for (const theme of [{ name: 'Achbit', light: {}, dark: {} }, ...themes]) for (const mode of ['light', 'dark']) {
    if (!theme[mode]) continue;
    const value = key => theme[mode][key] ?? tokens[`--ac-theme-${mode}-${key}`];
    for (const text of ['muted', 'faint']) for (const surface of ['background','sidebar','surface','surface-subtle','surface-raised']) {
      const [lo, hi] = [luminance(value(text)), luminance(value(surface))].sort((a,b)=>a-b);
      const ratio = (hi+.05)/(lo+.05);
      assert.ok(ratio >= 4.5, `${theme.name} ${mode} ${text}/${surface}: ${ratio}`);
    }
  }
});
