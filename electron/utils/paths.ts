/**
 * Path Utilities
 * Cross-platform path resolution helpers
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';

const require = createRequire(import.meta.url);

type ElectronAppLike = Pick<typeof import('electron').app, 'isPackaged' | 'getPath' | 'getAppPath'>;

export {
  quoteForCmd,
  needsWinShell,
  prepareWinSpawn,
  normalizeNodeRequirePathForNodeOptions,
  appendNodeRequireToNodeOptions,
} from './win-shell';

// ── 便携模式 ─────────────────────────────────────────────────────
//
// U-Claw 薄壳的唯一目的：让 ClawX 从 U 盘 / 移动硬盘 / 任意目录绿色运行，
// **不往宿主机写任何东西**。整个便携层就是这里的三个探测函数 +
// 下面几个路径解析器里的分支；其余代码一律走这些 helper，不要自己拼
// `homedir()`（上游没有便携约束，它那样写对它是对的，对我们不是）。

let _portableMode: boolean | undefined;
let _appRoot: string | undefined;

const PRODUCT_CACHE_DIR = 'U-Claw';

function resolveHostCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), PRODUCT_CACHE_DIR);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', PRODUCT_CACHE_DIR);
  }
  return join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), PRODUCT_CACHE_DIR);
}

/** 应用根目录：打包后是 exe 所在目录，开发/测试是项目根。 */
export function getAppRoot(isPackagedOverride?: boolean): string {
  if (_appRoot !== undefined) return _appRoot;
  try {
    const electronApp = getElectronApp();
    const isPackaged = isPackagedOverride ?? electronApp.isPackaged;
    _appRoot = isPackaged ? dirname(process.execPath) : process.cwd();
  } catch {
    _appRoot = process.cwd();
  }
  return _appRoot;
}

/** exe 旁边有 `portable.flag` 或 `data/` 就是便携模式。 */
export function isPortableMode(): boolean {
  if (_portableMode !== undefined) return _portableMode;
  const root = getAppRoot();
  _portableMode = existsSync(join(root, 'portable.flag')) || existsSync(join(root, 'data'));
  return _portableMode;
}

/** 便携数据根：`<appRoot>/data/`。 */
export function getPortableDataDir(): string {
  return join(getAppRoot(), 'data');
}

/**
 * Host-only cache root for portable builds.
 *
 * The USB drive owns user state and secrets. The host owns disposable/high-
 * churn material such as logs, browser data, and (in a future runtime
 * manager) downloaded runtime versions. This boundary is deliberately
 * separate from Electron's appData/userData paths so it cannot accidentally
 * move the device wallet off the USB drive.
 */
export function getPortableHostCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (!isPortableMode()) return join(getElectronApp().getPath('userData'), 'cache');
  return resolveHostCacheRoot(env);
}

export function getPortableHostLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getPortableHostCacheDir(env), 'logs');
}

export function getPortableHostRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getPortableHostCacheDir(env), 'runtime');
}

/**
 * 注入给内置 OpenClaw runtime 的环境变量，让它把 `~/.openclaw`
 * 解析到便携数据根里。启动 Gateway / CLI 子进程时必须带上。
 */
export function getOpenClawPortableEnv(): Record<string, string> {
  if (!isPortableMode()) return {};
  const stateDir = getOpenClawConfigDir();
  return {
    OPENCLAW_HOME: getPortableDataDir(),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, 'openclaw.json'),
  };
}

function getElectronApp() {
  if (process.versions?.electron) {
    return (require('electron') as typeof import('electron')).app;
  }

  const fallbackUserData = process.env.CLAWX_USER_DATA_DIR?.trim() || join(homedir(), '.clawx');
  const fallbackAppData = process.env.APPDATA?.trim() || dirname(fallbackUserData);
  const fallbackAppPath = process.cwd();
  const fallbackApp: ElectronAppLike = {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'userData') return fallbackUserData;
      if (name === 'appData') return fallbackAppData;
      return fallbackUserData;
    },
    getAppPath: () => fallbackAppPath,
  };
  return fallbackApp;
}

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  // 🔴 便携化关键：OpenClaw 配置里到处是 `~/.openclaw/...` 字符串（workspace、
  // agentDir 等）。便携模式下必须落到 U 盘 data/.openclaw，否则配置看着对、
  // 实际读写宿主机。上游只做朴素的 `~` → homedir 替换。
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '~/.openclaw' || normalized.startsWith('~/.openclaw/')) {
    const relative = normalized.slice('~/.openclaw'.length).replace(/^\/+/, '');
    return relative
      ? join(getOpenClawConfigDir(), ...relative.split('/'))
      : getOpenClawConfigDir();
  }

  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Get OpenClaw config directory
 */
export function getOpenClawConfigDir(): string {
  if (isPortableMode()) {
    return join(getPortableDataDir(), '.openclaw');
  }
  return join(homedir(), '.openclaw');
}

export function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  // Portable containment is authoritative. A machine-wide OPENCLAW_STATE_DIR
  // belongs to the host installation and must never redirect a USB build away
  // from its own data directory.
  if (isPortableMode()) {
    return resolve(getOpenClawConfigDir());
  }
  const configured = env.OPENCLAW_STATE_DIR?.trim();
  return resolve(expandPath(configured || getOpenClawConfigDir()));
}

export function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // Same boundary as resolveOpenClawStateDir(): ignore a host-level explicit
  // config path once portable mode is active.
  if (isPortableMode()) {
    return join(resolveOpenClawStateDir(env), 'openclaw.json');
  }
  const configured = env.OPENCLAW_CONFIG_PATH?.trim();
  return resolve(expandPath(configured || join(resolveOpenClawStateDir(env), 'openclaw.json')));
}

export function resolveOpenClawConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolveOpenClawConfigPath(env));
}

/**
 * OpenClaw 扩展目录。便携模式下在 U 盘上，**不写宿主机主目录**。
 */
export function getOpenClawExtensionsDir(): string {
  return join(getOpenClawConfigDir(), 'extensions');
}

/** OpenClaw 各 agent 的目录（含 auth-profiles / models.json / sqlite）。 */
export function getOpenClawAgentsDir(): string {
  return join(getOpenClawConfigDir(), 'agents');
}

/** 渠道凭证目录（微信 / WhatsApp 等）。凭证尤其不能落到宿主机。 */
export function getOpenClawCredentialsDir(): string {
  return join(getOpenClawConfigDir(), 'credentials');
}

/** 媒体目录（收发附件落盘处）。 */
export function getOpenClawMediaDir(): string {
  return join(getOpenClawConfigDir(), 'media');
}

/**
 * 个人 agent skills 目录（OpenClaw 约定的 `~/.agents`，和 `.openclaw` 平级）。
 * 便携模式下同样跟着盘走 —— 它也是应用状态，不是用户主动指定的落点。
 */
export function getPersonalAgentsDir(): string {
  if (isPortableMode()) {
    return join(getPortableDataDir(), '.agents');
  }
  return join(homedir(), '.agents');
}

/**
 * Get OpenClaw skills directory
 */
export function getOpenClawSkillsDir(): string {
  return join(getOpenClawConfigDir(), 'skills');
}

/**
 * Get ClawX config directory
 */
export function getClawXConfigDir(): string {
  if (isPortableMode()) {
    return join(getPortableDataDir(), '.clawx');
  }
  return join(homedir(), '.clawx');
}

/**
 * Get ClawX logs directory
 */
export function getLogsDir(): string {
  return isPortableMode()
    ? getPortableHostLogsDir()
    : join(getElectronApp().getPath('userData'), 'logs');
}

/**
 * Get ClawX data directory
 */
export function getDataDir(): string {
  if (isPortableMode()) {
    return join(getPortableDataDir(), 'clawx-state');
  }
  return getElectronApp().getPath('userData');
}

/**
 * 宿主机的应用数据根。便携模式也刻意不改这个路径：只用于只读发现旧版
 * `%APPDATA%/clawx` 钱包，绝不能作为便携版的新写入位置。
 */
export function getHostAppDataDir(): string {
  return getElectronApp().getPath('appData');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get resources directory (for bundled assets)
 */
export function getResourcesDir(): string {
  if (getElectronApp().isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(__dirname, '../../resources');
}

/**
 * Get preload script path
 */
export function getPreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/**
 * Get OpenClaw package directory
 * - Production (packaged): from resources/openclaw (copied by electron-builder extraResources)
 * - Development: from node_modules/openclaw
 */
export function getOpenClawDir(): string {
  if (getElectronApp().isPackaged) {
    return join(process.resourcesPath, 'openclaw');
  }
  // Development: use node_modules/openclaw
  return join(__dirname, '../../node_modules/openclaw');
}

/**
 * Get OpenClaw package directory resolved to a real path.
 * Useful when consumers need deterministic module resolution under pnpm symlinks.
 */
export function getOpenClawResolvedDir(): string {
  const dir = getOpenClawDir();
  if (!existsSync(dir)) {
    return dir;
  }
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Get OpenClaw entry script path (openclaw.mjs)
 */
export function getOpenClawEntryPath(): string {
  return join(getOpenClawDir(), 'openclaw.mjs');
}

/**
 * Get ClawHub CLI entry script path (clawdhub.js)
 */
export function getClawHubCliEntryPath(): string {
  return join(getElectronApp().getAppPath(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js');
}

/**
 * Get ClawHub CLI binary path (node_modules/.bin)
 */
export function getClawHubCliBinPath(): string {
  const binName = process.platform === 'win32' ? 'clawhub.cmd' : 'clawhub';
  return join(getElectronApp().getAppPath(), 'node_modules', '.bin', binName);
}

/**
 * Check if OpenClaw package exists
 */
export function isOpenClawPresent(): boolean {
  const dir = getOpenClawDir();
  const pkgJsonPath = join(dir, 'package.json');
  return existsSync(dir) && existsSync(pkgJsonPath);
}

/**
 * Check if OpenClaw is built (has dist folder)
 * For the npm package, this should always be true since npm publishes the built dist.
 */
export function isOpenClawBuilt(): boolean {
  const dir = getOpenClawDir();
  const distDir = join(dir, 'dist');
  const hasDist = existsSync(distDir);
  return hasDist;
}

/**
 * Get OpenClaw status for environment check
 */
export interface OpenClawStatus {
  packageExists: boolean;
  isBuilt: boolean;
  entryPath: string;
  dir: string;
  version?: string;
}

export function getOpenClawStatus(): OpenClawStatus {
  const dir = getOpenClawDir();
  let version: string | undefined;

  // Try to read version from package.json
  try {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version;
    }
  } catch {
    // Ignore version read errors
  }

  const status: OpenClawStatus = {
    packageExists: isOpenClawPresent(),
    isBuilt: isOpenClawBuilt(),
    entryPath: getOpenClawEntryPath(),
    dir,
    version,
  };

  try {
    const { logger } = require('./logger') as typeof import('./logger');
    logger.info('OpenClaw status:', status);
  } catch {
    // Ignore logger bootstrap issues in non-Electron contexts such as unit tests.
  }
  return status;
}
