#!/usr/bin/env node
/**
 * check-provider-env-catalog-drift.mjs
 *
 * `electron/gateway/process-launcher.ts` strips the environment variables that
 * make OpenClaw treat an external provider plugin as configured, because on
 * exFAT (every customer USB stick) installing such a plugin fails and the
 * Gateway then refuses to start. That list has to be a literal — it is read on
 * the launch path, long before any OpenClaw module is loaded.
 *
 * A literal copied out of upstream drifts on the next sync, and the drift is
 * invisible: nothing breaks until a customer whose machine happens to have,
 * say, GROQ_API_KEY set plugs the drive in. So re-derive the list from the
 * bundled OpenClaw runtime's own catalog and diff it.
 *
 * Usage: node scripts/check-provider-env-catalog-drift.mjs [path/to/openclaw]
 *   default: node_modules/openclaw (falls back to build/openclaw)
 * Exits non-zero on drift.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';

const CATALOG_MARKER = 'var official_external_provider_catalog_default = ';
const LAUNCHER_PATH = resolve('electron/gateway/process-launcher.ts');

function resolveOpenClawDistDir(argPath) {
  const candidates = argPath
    ? [resolve(argPath)]
    : [resolve('node_modules/openclaw'), resolve('build/openclaw')];
  for (const root of candidates) {
    const dist = join(root, 'dist');
    if (existsSync(dist)) return dist;
  }
  console.error(`[provider-env] no OpenClaw dist found (looked in: ${candidates.join(', ')})`);
  process.exit(2);
}

/** The catalog lives in a content-hashed chunk, so find it by its marker. */
function readCatalogSource(distDir) {
  for (const entry of readdirSync(distDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = readFileSync(join(distDir, entry), 'utf8');
    if (source.includes(CATALOG_MARKER)) return { source, file: entry };
  }
  console.error(`[provider-env] no chunk in ${distDir} declares the external provider catalog`);
  process.exit(2);
}

/**
 * Slice the object literal that follows the marker by matching braces, then
 * evaluate it. It is a JS literal, not JSON — the bundler leaves the outer keys
 * unquoted — so it is evaluated in an empty vm context with no globals and a
 * timeout rather than parsed. The input is our own packaged runtime.
 */
function extractCatalog(source) {
  const open = source.indexOf('{', source.indexOf(CATALOG_MARKER));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return runInNewContext(`(${source.slice(open, i + 1)})`, Object.create(null), {
          timeout: 5000,
        });
      }
    }
  }
  console.error('[provider-env] could not slice the catalog object literal');
  process.exit(2);
}

function envVarsFromCatalog(catalog) {
  const envVars = new Set();
  for (const entry of catalog.entries ?? []) {
    for (const provider of entry.openclaw?.providers ?? []) {
      for (const envVar of provider.envVars ?? []) envVars.add(envVar);
    }
  }
  return envVars;
}

function envVarsFromLauncher() {
  const source = readFileSync(LAUNCHER_PATH, 'utf8');
  const block = source.match(
    /const OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS = \[([\s\S]*?)\] as const;/,
  );
  if (!block) {
    console.error(`[provider-env] OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS not found in ${LAUNCHER_PATH}`);
    process.exit(2);
  }
  return new Set([...block[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]));
}

const distDir = resolveOpenClawDistDir(process.argv[2]);
const { source, file } = readCatalogSource(distDir);
const expected = envVarsFromCatalog(extractCatalog(source));
const actual = envVarsFromLauncher();

const missing = [...expected].filter((envVar) => !actual.has(envVar)).sort();
// Extra entries are not failures on their own: an upstream release may drop a
// provider while customer machines still have its variable set, and stripping a
// stale name costs nothing. Report them so the list can be pruned deliberately.
const extra = [...actual].filter((envVar) => !expected.has(envVar)).sort();

console.log(`[provider-env] catalog: ${file} (${expected.size} env var(s))`);
if (extra.length > 0) console.log(`[provider-env] note — stripped but no longer in catalog: ${extra.join(', ')}`);
if (missing.length === 0) {
  console.log('[provider-env] OK — every catalog provider env var is stripped before Gateway launch');
  process.exit(0);
}
console.error(`[provider-env] ${missing.length} provider env var(s) reach the Gateway unstripped:`);
for (const envVar of missing) console.error(`  ${envVar}`);
console.error('[provider-env] add them to OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS in electron/gateway/process-launcher.ts');
process.exit(1);
