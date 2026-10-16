import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fontPreference, shellQuote, windowArguments } from './font-preferences.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const resources = dirname(here);
const binary = resolve(resources, '../MacOS/deepcode-tui');
const stages = { prepare: 'font preparation', create: 'Terminal window creation', capture: 'current terminal capture', apply: 'window font application', restore: 'terminal appearance restoration', close: 'owned window cleanup', closeFinished: 'finished terminal cleanup' };

export function native(action, config, execute = execFileSync) {
  try {
    return JSON.parse(execute('/usr/bin/osascript',
      ['-l', 'JavaScript', join(here, 'font-bridge.js'), action, JSON.stringify(config)],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (cause) {
    const detail = cause.stderr?.toString().trim() || cause.message;
    throw new Error(`${stages[action] ?? action} failed (${cause.code ?? 'native error'}): ${detail}`, { cause });
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeReceipt(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function closeFinishedWindow(config, callNative = native, isAlive = processExists, wait = delay) {
  if (!Number.isSafeInteger(config.waitForPid) || config.waitForPid <= 1) throw new Error('Invalid terminal entry process.');
  // A manually invoked .command returns to its ordinary shell. Stop watching it
  // after this bounded exit window instead of ever closing that live shell.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!isAlive(config.waitForPid)) {
      return callNative('closeFinished', { windowId: config.windowId, tty: config.tty });
    }
    await wait(100);
  }
  return { closed: false };
}

async function scheduleWindowClose(owner, waitForPid, temporary) {
  await mkdir(temporary, { recursive: true });
  const log = await open(join(temporary, 'tui-window-cleanup.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--close-finished',
      JSON.stringify({ windowId: owner.windowId, tty: owner.tty, waitForPid })],
      { detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}

async function preferences(args, choice) {
  const { DEFAULT_USER_SETTINGS } = await import(pathToFileURL(join(resources, 'node_modules/@deepcode/protocol/dist/index.js')));
  let settings;
  try {
    settings = JSON.parse(execFileSync(binary, [...args, '--font-settings'], { encoding: 'utf8', timeout: 30_000 }));
  } catch (cause) {
    throw new Error(`font preference read failed: ${cause.stderr?.toString().trim() || cause.message}`, { cause });
  }
  const font = fontPreference(settings, DEFAULT_USER_SETTINGS, choice);
  return { ...font, file: font.file ? join(here, 'fonts', font.file) : null };
}

export async function runChild(path) {
  const folder = dirname(path);
  let child;
  let interrupted;
  let watching = true;
  let watcher;
  let code = 1;
  let failure;
  let stderr = '';
  const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    interrupted = signal;
    child?.kill(signal);
  }]));
  for (const [signal, handler] of signals) process.on(signal, handler);
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    await rm(path); // Remove the one-shot environment before starting the TUI.
    const deadline = Date.now() + 130_000;
    while (true) {
      if (interrupted || await exists(join(folder, 'abort'))) return (code = 130);
      if (await exists(join(folder, 'ready'))) break;
      await access(folder);
      if (Date.now() >= deadline) throw new Error('Timed out waiting for window font application.');
      await delay(100);
    }
    const tty = execFileSync('/usr/bin/tty', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    const environment = { ...process.env, ...payload.environment,
      DEEPCODE_TUI_WINDOW_TTY: tty, DEEPCODE_TUI_READY_FILE: join(folder, 'rendered.json') };
    const apiIndex = payload.args.indexOf('--api');
    if (apiIndex >= 0) environment.DEEPCODE_API_URL = payload.args[apiIndex + 1];
    child = spawn(payload.binary, payload.args, { cwd: payload.cwd, stdio: ['inherit', 'inherit', 'pipe'], env: environment });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {
      process.stderr.write(text);
      stderr = (stderr + text).slice(-8192);
    });
    // Until the parent acknowledges readiness, it retains ownership of launch failure cleanup.
    watcher = (async () => {
      while (watching && !await exists(join(folder, 'accepted'))) {
        if (await exists(join(folder, 'abort'))) { child.kill('SIGTERM'); return; }
        await delay(100);
      }
    })().catch(error => { failure = error; child.kill('SIGTERM'); });
    code = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (exit, signal) => accept(exit ?? (signal ? 130 : 1)));
    });
    if (failure) throw failure;
    return code;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    watching = false;
    await watcher;
    for (const [signal, handler] of signals) process.off(signal, handler);
    if (await exists(folder)) {
      const owner = await readOptional(join(folder, 'owner.json'));
      await writeReceipt(join(folder, 'exit.json'), { code, error: failure?.message || (code !== 0 ? stderr.trim() || undefined : undefined) });
      if (code === 0 && !failure && owner) await scheduleWindowClose(owner, process.pid, dirname(folder));
      if (await exists(join(folder, 'accepted'))) {
        await rm(folder, { recursive: true, force: true });
      }
    }
  }
}

// This is a Host startup handshake, not a Session execution or settlement fact.
export async function launchWindow(config, callNative = native) {
  const { font, args, cwd, environment, temporary } = config;
  await mkdir(temporary, { recursive: true });
  const folder = await mkdtemp(join(temporary, 'tui-window-'));
  let owner;
  let stage = 'font preparation';
  try {
    await callNative('prepare', font);
    const path = join(folder, 'launch.json');
    await writeFile(path, JSON.stringify({ binary: config.binary, args, cwd, environment }), { mode: 0o600 });
    const command = 'exec ' + [process.execPath, fileURLToPath(import.meta.url), '--run', path].map(shellQuote).join(' ');
    stage = 'Terminal window creation';
    owner = await callNative('create', { command, ownerPath: join(folder, 'owner.json') });
    stage = 'window font application';
    await callNative('apply', { ...font, ...owner });
    await writeFile(join(folder, 'ready'), '', { mode: 0o600 });
    stage = 'TUI initialization and first frame';
    const deadline = Date.now() + 60_000;
    while (true) {
      const exited = await readOptional(join(folder, 'exit.json'));
      if (exited) throw new Error(`TUI exited before startup confirmation (exit ${exited.code})${exited.error ? ': ' + exited.error : ''}`);
      if (await readOptional(join(folder, 'rendered.json'))) break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the TUI ready frame.');
      await delay(100);
    }
    await writeFile(join(folder, 'accepted'), '', { mode: 0o600 });
    // The child may have exited between our ready check and ownership transfer.
    if (await exists(join(folder, 'exit.json'))) await rm(folder, { recursive: true, force: true });
    return 0;
  } catch (cause) {
    const cleanupErrors = [];
    try {
      await writeFile(join(folder, 'abort'), '', { mode: 0o600 });
      owner ??= await readOptional(join(folder, 'owner.json'));
      if (owner) {
        // Give the waiting supervisor / owned TUI time to exit before closing its window.
        const deadline = Date.now() + 3_000;
        while (!await exists(join(folder, 'exit.json')) && Date.now() < deadline) await delay(100);
        await callNative('close', owner);
      }
    } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length === 0) await rm(folder, { recursive: true, force: true });
    throw new Error(`${stage}: ${cause.message}${cleanupErrors.length ? `; cleanup failed: ${cleanupErrors.join('; ')}; ownership: ${folder}` : ''}`, { cause });
  }
}

// Terminal already opened a window for a double-clicked .command. Borrow its tab
// for the TUI lifetime, then close it only if its parent shell has also exited.
export async function runInCurrentWindow(config, callNative = native, start = spawn, scheduleClose = scheduleWindowClose) {
  const { font, tty, binary, args, cwd, environment } = config;
  await callNative('prepare', font);
  const previous = await callNative('capture', { tty });
  let failure;
  let child;
  let code;
  const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child?.kill(signal)]));
  try {
    await callNative('apply', { ...font, windowId: previous.windowId, tty });
    const env = { ...process.env, ...environment, DEEPCODE_TUI_WINDOW_TTY: tty };
    const apiIndex = args.indexOf('--api');
    if (apiIndex >= 0) env.DEEPCODE_API_URL = args[apiIndex + 1];
    child = start(binary, args, { cwd, env, stdio: 'inherit' });
    for (const [signal, handler] of signals) process.on(signal, handler);
    code = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept(code ?? (signal ? 130 : 1)));
    });
    return code;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
    try { await callNative('restore', previous); }
    catch (error) {
      if (failure) throw new Error(`${failure.message}; ${error.message}`, { cause: failure });
      throw error;
    }
    if (code === 0 && !failure) await scheduleClose(previous, process.ppid, config.temporary);
  }
}

async function main(args) {
  // This private marker belongs only to the .command wrapper, not the installed CLI.
  const commandWindow = args[0] === '--command-window';
  if (commandWindow) args = args.slice(1);
  if (args[0] === '--close-finished') { await closeFinishedWindow(JSON.parse(args[1])); return 0; }
  if (args[0] === '--run') return runChild(args[1]);
  if (args[0] === '--apply-font') {
    const tty = process.env.DEEPCODE_TUI_WINDOW_TTY;
    if (!tty) throw new Error('Use the DeepCode dedicated terminal window to change its font.');
    const font = await preferences([], args[1]);
    native('prepare', font);
    native('apply', { ...font, tty });
    return 0;
  }
  const { font: choice, inPlace, forward } = windowArguments(args);
  const plain = inPlace || forward.some(arg => ['--help', '-h', '--smoke', '--font-settings'].includes(arg))
    || !process.stdin.isTTY || !process.stdout.isTTY;
  if (plain) {
    if (choice !== 'follow') throw new Error('--font requires a dedicated interactive terminal window.');
    const child = spawn(binary, forward, { stdio: 'inherit' });
    return await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', code => accept(code ?? 1));
    });
  }
  const font = await preferences(forward, choice);
  const temporary = process.env.DEEPCODE_USER_ROOT
    ? join(resolve(process.env.DEEPCODE_USER_ROOT), 'tmp') : join(tmpdir(), 'DeepCode');
  if (commandWindow && process.env.TERM_PROGRAM === 'Apple_Terminal') {
    const tty = execFileSync('/usr/bin/tty', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    return runInCurrentWindow({ font, tty, binary, args: forward, cwd: process.cwd(), environment: {}, temporary });
  }
  const environment = Object.fromEntries(['DEEPCODE_RUNTIME_DIR', 'DEEPCODE_KERNEL_BIN',
    'DEEPCODE_USER_ROOT', 'DEEPCODE_API_URL', 'DEEPCODE_HOST_SHELL_TOKEN']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return launchWindow({ font, args: forward, binary, cwd: process.cwd(), environment, temporary });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(`DeepCode TUI: ${error.message}`);
    process.exitCode = 1;
  });
}
