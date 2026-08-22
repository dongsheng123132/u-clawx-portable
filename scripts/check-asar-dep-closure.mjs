#!/usr/bin/env node
/**
 * check-asar-dep-closure.mjs
 *
 * Pre-flight for packaged builds: verify every package inside app.asar can
 * actually resolve its own `dependencies` from the packaged tree.
 *
 * Why this exists: electron-builder packages the *production* dependency graph.
 * With pnpm, a transitive runtime dep whose only declaration in package.json
 * sits under devDependencies gets pruned, and the app dies at startup with an
 * "A JavaScript error occurred in the main process / Cannot find module X"
 * native dialog — no log file, no window, nothing to grep. That cost a full
 * build+USB deploy cycle to find once (`ms`, required by `debug`, required by
 * electron-updater). Catch it here instead, in seconds.
 *
 * Usage: node scripts/check-asar-dep-closure.mjs [path/to/app.asar]
 * Exits non-zero when a dependency is unresolvable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const asarPath = resolve(process.argv[2] ?? 'release/win-unpacked/resources/app.asar');
if (!existsSync(asarPath)) {
  console.error(`[dep-closure] asar not found: ${asarPath}`);
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), 'clawx-asar-'));
try {
  execFileSync('npx', ['asar', 'extract', asarPath, workDir], { stdio: 'pipe', shell: true });
} catch (error) {
  console.error(`[dep-closure] failed to extract asar: ${error.message}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(2);
}

/** Every package dir under a node_modules dir, scoped packages included. */
function listPackageDirs(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) return [];
  const out = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry === '.bin' || entry.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(entryPath)) out.push({ name: `${entry}/${sub}`, dir: join(entryPath, sub) });
    } else {
      out.push({ name: entry, dir: entryPath });
    }
  }
  return out;
}

/** Node resolution: walk up from `fromDir` looking for node_modules/<name>. */
function resolvable(name, fromDir) {
  let dir = fromDir;
  while (true) {
    if (existsSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'))) return true;
    const parent = resolve(dir, '..');
    if (parent === dir || !parent.startsWith(workDir)) return false;
    dir = parent;
  }
}

const missing = [];
const queue = listPackageDirs(join(workDir, 'node_modules'));
let checked = 0;
while (queue.length > 0) {
  const { name, dir } = queue.shift();
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  checked++;
  // optionalDependencies are allowed to be absent by definition; peers are the
  // host's job (that is exactly how the bundled OpenClaw plugins are built).
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (optional.has(dep)) continue;
    if (!resolvable(dep, dir)) missing.push({ from: name, dep });
  }
  queue.push(...listPackageDirs(join(dir, 'node_modules')));
}

rmSync(workDir, { recursive: true, force: true });

console.log(`[dep-closure] checked ${checked} packaged package(s) in ${asarPath}`);
if (missing.length === 0) {
  console.log('[dep-closure] OK — every dependency resolves inside the package');
  process.exit(0);
}
console.error(`[dep-closure] ${missing.length} unresolvable dependency reference(s):`);
for (const { from, dep } of missing) console.error(`  ${from} -> ${dep}`);
process.exit(1);
