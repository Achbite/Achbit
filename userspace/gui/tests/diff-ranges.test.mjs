import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('large diff anchors preserve every unmodified span and replay the exact edit', async (t) => {
  const { calculateChangedRanges } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const before = ['same', 'old', 'keep', 'delete', '重复', 'keep', 'tail'].join('\n');
  const after = ['insert', 'same', 'new', 'keep', '重复', 'keep', 'tail', ''].join('\n');
  for (const [original, current] of [[before, after], [after, before], ['', after], [before, ''], [after, after],
    ['初🧭\r重复\r末🐈', '初🧭\r增长🦊\r重复\r末🐈\r'],
    ['前🧪\r\n保留😀\r\n末\r\n', '前🧪\r\n保留😀\r\n新🚀\r\n末'],
    ['前🐱x\r中🌍\r\n末', '前🦊x\n中🌍\r末!'], ['A\n\nB\nC', 'X\n\nY\nZ'],
    ['A\nB\nEND', '新增\n重写\nDONE'], ['', ''], ['共同🧭\nA\nA', '共同🧭\nB\nB'],
    ['A\nA\n末尾🧪', 'B\nB\n末尾🧪'], ['共有', '共有\n'],
    ['a\nunique2\n🧭\nunique1\nend', 'b\nunique1\n🧭\nunique2\nlast'],
    ['前\n\n重复\n重复\n中\n尾', 'new\n\n重复\n中\n重复\nafter']]) {
    let fromA = 0, fromB = 0, replay = '';
    for (const range of calculateChangedRanges(original, current)) {
      assert.equal(original.slice(fromA, range.fromA), current.slice(fromB, range.fromB));
      replay += original.slice(fromA, range.fromA) + current.slice(range.fromB, range.toB);
      fromA = range.toA; fromB = range.toB;
    }
    assert.equal(replay + original.slice(fromA), current);
  }
});

test('an isolated common line separates the two changed regions of a complete rewrite', async (t) => {
  const { calculateChangedRanges } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  for (const shared of ['', '// reset', '唯一 🧭']) {
    const make = (side) => Array.from({ length: 15000 }, (_, i) => i === 7600 ? shared : side + i).join('\n');
    const old = make('OLD '), current = make('NEW ');
    const ranges = calculateChangedRanges(old, current);
    const retained = ranges.slice(1).map((range, index) => old.slice(ranges[index].toA, range.fromA));
    assert.ok(retained.includes(shared + '\n'), 'preserve the sole common source line');
  }
});
