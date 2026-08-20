#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronCacheDirs, resolveElectronCacheEnv } from './package-resource-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ELECTRON_BUILDER_CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const args = process.argv.slice(2);
const electronBuilderEnv = resolveElectronCacheEnv(ROOT, process.env);
ensureElectronCacheDirs(electronBuilderEnv);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function spawnElectronBuilder() {
  if (process.platform === 'darwin') {
    const command = [
      'ulimit -n 65536 >/dev/null 2>&1 || ulimit -n 32768 >/dev/null 2>&1 || ulimit -n 16384 >/dev/null 2>&1 || true',
      `exec ${shellQuote(process.execPath)} ${shellQuote(ELECTRON_BUILDER_CLI)}${args.length > 0 ? ` ${args.map(shellQuote).join(' ')}` : ''}`,
    ].join('; ');

    return spawn('/bin/bash', ['-lc', command], {
      cwd: ROOT,
      stdio: 'inherit',
      env: electronBuilderEnv,
    });
  }

  return spawn(process.execPath, [ELECTRON_BUILDER_CLI, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: electronBuilderEnv,
  });
}

const child = spawnElectronBuilder();
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
