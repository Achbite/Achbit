import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(repository, '.task-artifacts', 'windows-installer');
const script = join(repository, 'scripts', 'installers', 'install-runtime.ps1');
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const options = { skip: process.platform !== 'win32' };

function write(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function fixture(t, crossVolume = false) {
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, 'case-'));
  const stage = crossVolume ? mkdtempSync(join(tmpdir(), 'achbit-installer-test-')) : join(directory, 'stage');
  const destination = join(directory, 'installed app');
  const errorLog = join(directory, 'logs', 'error.log');
  t.after(() => {
    // Only delete these test-created directories, after checking their full paths.
    for (const [path, parent] of [[directory, artifacts], ...(crossVolume ? [[stage, tmpdir()]] : [])]) {
      const child = relative(resolve(parent), resolve(path));
      assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
      rmSync(path, { recursive: true, force: true });
    }
  });
  return { stage, destination, errorLog, run() {
    return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Stage', stage, '-Destination', destination, '-ErrorLog', errorLog],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  } };
}
function manifest(root, entries) { write(root, 'package-files.json', JSON.stringify([...entries, 'package-files.json'])); }

for (const crossVolume of [false, true]) {
  test(`Windows PowerShell 5.1 installs and upgrades a runtime (${crossVolume ? 'cross volume' : 'same volume'})`, options, t => {
    const f = fixture(t, crossVolume);
    if (crossVolume && parse(f.stage).root.toLowerCase() === parse(f.destination).root.toLowerCase()) {
      t.skip('A separate volume from TEMP is required for this case'); return;
    }
    manifest(f.stage, ['Achbit.exe', 'node', 'retired.txt']);
    write(f.stage, 'Achbit.exe', 'old application');
    write(f.stage, 'node/deep/runtime.js', 'old runtime');
    write(f.stage, 'retired.txt', 'old owned file');
    let result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.destination, 'node/deep/runtime.js'), 'utf8'), 'old runtime');
    write(f.destination, 'user notes.txt', 'keep this');
    manifest(f.stage, ['Achbit.exe', 'node']);
    write(f.stage, 'Achbit.exe', 'new application');
    write(f.stage, 'node/deep/runtime.js', 'new runtime');
    result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.destination, 'Achbit.exe'), 'utf8'), 'new application');
    assert.equal(readFileSync(join(f.destination, 'node/deep/runtime.js'), 'utf8'), 'new runtime');
    assert.equal(readFileSync(join(f.destination, 'user notes.txt'), 'utf8'), 'keep this');
    assert.equal(existsSync(join(f.destination, 'retired.txt')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(f.destination, 'package-files.json'), 'utf8')), ['Achbit.exe', 'node', 'package-files.json']);
  });
}

test('a failed replacement restores previous program entries and records the original error', options, t => {
  const f = fixture(t, true);
  manifest(f.destination, ['Achbit.exe', 'node']);
  write(f.destination, 'Achbit.exe', 'old application');
  write(f.destination, 'node/deep/runtime.js', 'old runtime');
  write(f.destination, 'user notes.txt', 'keep this');
  manifest(f.stage, ['Achbit.exe', 'node', 'missing-payload']);
  write(f.stage, 'Achbit.exe', 'new application');
  write(f.stage, 'node/deep/runtime.js', 'new runtime');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(f.destination, 'Achbit.exe'), 'utf8'), 'old application');
  assert.equal(readFileSync(join(f.destination, 'node/deep/runtime.js'), 'utf8'), 'old runtime');
  assert.equal(readFileSync(join(f.destination, 'user notes.txt'), 'utf8'), 'keep this');
  assert.equal(readFileSync(join(f.stage, 'Achbit.exe'), 'utf8'), 'new application');
  assert.equal(readFileSync(join(f.stage, 'node/deep/runtime.js'), 'utf8'), 'new runtime');
  assert.match(readFileSync(f.errorLog, 'utf8'), /missing-payload/);
});

test('an invalid manifest entry is rejected before touching the installation', options, t => {
  const f = fixture(t);
  manifest(f.stage, ['../outside.txt']);
  write(f.destination, 'Achbit.exe', 'untouched application');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(f.errorLog, 'utf8'), /Invalid program entry/);
  assert.equal(readFileSync(join(f.destination, 'Achbit.exe'), 'utf8'), 'untouched application');
});
