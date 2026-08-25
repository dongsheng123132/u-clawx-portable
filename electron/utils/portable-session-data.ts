import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORTABLE_SESSION_CACHE_ID_FILE = 'portable-session-cache-id';
const PORTABLE_SESSION_CACHE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PortableSessionDataOptions {
  appRoot: string;
  portableStateDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface PortableSessionDataDecision {
  enabled: boolean;
  path: string | null;
}

function readSystemSessionDataSetting(portableStateDir: string): boolean {
  try {
    const settingsPath = join(portableStateDir, 'settings.json');
    if (!existsSync(settingsPath)) return true;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      portableUseSystemChromiumCache?: unknown;
    };
    return settings.portableUseSystemChromiumCache !== false;
  } catch {
    return true;
  }
}

function getSystemCacheRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    return env.LOCALAPPDATA?.trim() || tmpdir();
  }
  if (platform === 'darwin') {
    return join(env.HOME?.trim() || tmpdir(), 'Library', 'Caches');
  }
  return env.XDG_CACHE_HOME?.trim() || join(env.HOME?.trim() || tmpdir(), '.cache');
}

function normalizePortableSessionCacheId(value: string): string | null {
  const id = value.trim();
  return PORTABLE_SESSION_CACHE_ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

function readOrCreatePortableSessionCacheId(portableStateDir?: string): string | null {
  if (!portableStateDir) return null;

  const idPath = join(portableStateDir, PORTABLE_SESSION_CACHE_ID_FILE);
  try {
    if (existsSync(idPath)) {
      const existing = normalizePortableSessionCacheId(readFileSync(idPath, 'utf8'));
      if (existing) return existing;
    }

    const nextId = randomUUID();
    mkdirSync(portableStateDir, { recursive: true });
    writeFileSync(idPath, `${nextId}\n`, { encoding: 'utf8', mode: 0o600 });
    return nextId;
  } catch {
    return null;
  }
}

export function getPortableSystemSessionDataPath(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  portableStateDir?: string,
): string {
  const cacheId = readOrCreatePortableSessionCacheId(portableStateDir);
  const cacheIdentity = cacheId ? `portable-id:${cacheId}` : appRoot.toLowerCase();
  const rootHash = createHash('sha256').update(cacheIdentity).digest('hex').slice(0, 16);
  return join(getSystemCacheRoot(platform, env), 'U-ClawX', 'portable-chromium-session', rootHash);
}

export function resolvePortableSessionDataDecision(
  options: PortableSessionDataOptions,
): PortableSessionDataDecision {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const enabled = readSystemSessionDataSetting(options.portableStateDir);
  if (!enabled) {
    return { enabled: false, path: null };
  }

  return {
    enabled: true,
    path: getPortableSystemSessionDataPath(options.appRoot, platform, env, options.portableStateDir),
  };
}

export function ensurePortableSessionDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
