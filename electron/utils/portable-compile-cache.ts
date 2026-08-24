import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 便携模式：把 OpenClaw 内核的 V8 编译缓存（NODE_COMPILE_CACHE）落到本机硬盘。
 *
 * 背景（pc-8308 实测，2026-08-24）：便携版从 U 盘跑，内核每次冷启动都要重新解析
 * 全部 JS —— 海量随机读正是 U 盘最弱的地方。NODE_COMPILE_CACHE 让 Node 把编译产物
 * 缓存到磁盘，二次启动直接 mmap 命中；但缓存目录若留在 U 盘上，写缓存本身就慢，
 * 所以必须指到本机 SSD。
 *
 * 设计完全对齐 portable-session-data.ts 的既有约定：
 * - 盘符隔离用 UUID（portable-compile-cache-id），换 USB 口/盘符仍命中同一份缓存；
 * - 本机缓存根：win %LOCALAPPDATA%\U-Claw\ / mac ~/Library/Caches/U-Claw/
 *   / linux $XDG_CACHE_HOME/U-Claw；
 * - 任何一步失败都返回 null，启动流程照常（退化为现状：无编译缓存），绝不阻塞。
 */

const COMPILE_CACHE_ID_FILE = 'portable-compile-cache-id';
const COMPILE_CACHE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readOrCreateCompileCacheId(portableStateDir?: string): string | null {
  if (!portableStateDir) return null;

  const idPath = join(portableStateDir, COMPILE_CACHE_ID_FILE);
  try {
    if (existsSync(idPath)) {
      const existing = readFileSync(idPath, 'utf8').trim().toLowerCase();
      if (COMPILE_CACHE_ID_PATTERN.test(existing)) return existing;
    }

    const nextId = randomUUID();
    mkdirSync(portableStateDir, { recursive: true });
    // 原子写：U 盘热拔留下半截文件时，下次校验失败会自愈重建，
    // 但 renameSync 能把「读到半截」的窗口压到最小。
    const tmpPath = `${idPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${nextId}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, idPath);
    return nextId;
  } catch {
    // U 盘只读 / 拔出等场景：拿不到稳定身份就禁用本机编译缓存。
    return null;
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

/**
 * 返回本机编译缓存目录（不保证已创建）。
 * 拿不出稳定盘符身份（U 盘只读/热拔/克隆盘无身份文件且写不进）时返回 null，
 * 调用方必须跳过 NODE_COMPILE_CACHE——绝不允许退化到所有 U 盘共享同一份
 * 固定身份的缓存目录，那会击穿「换盘不串缓存」的隔离。
 */
export function getPortableNodeCompileCachePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  portableStateDir?: string,
): string | null {
  const cacheId = readOrCreateCompileCacheId(portableStateDir);
  if (!cacheId) return null;
  const rootHash = createHash('sha256').update(cacheId).digest('hex').slice(0, 16);
  return join(getSystemCacheRoot(platform, env), 'U-Claw', 'node-compile-cache', rootHash);
}

/**
 * 解析并确保本机编译缓存目录存在；失败返回 null（调用方直接跳过该变量）。
 * 结果按 (platform, 缓存根, 身份) memo 化：调用点有约 9 处、每次子进程 spawn
 * 都会进来，没必要每次都对 U 盘重复 existsSync/readFileSync + 本机 mkdir。
 */
let memoizedEnsure: { key: string; dir: string | null } | null = null;

export function ensurePortableNodeCompileCache(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  portableStateDir?: string,
): string | null {
  const cacheRoot = getSystemCacheRoot(platform, env);
  const stateKey = portableStateDir ?? '';
  const key = `${platform}\u0000${cacheRoot}\u0000${stateKey}`;
  if (memoizedEnsure?.key === key) return memoizedEnsure.dir;
  try {
    const dir = getPortableNodeCompileCachePath(platform, env, portableStateDir);
    if (!dir) {
      memoizedEnsure = { key, dir: null };
      return null;
    }
    mkdirSync(dir, { recursive: true });
    memoizedEnsure = { key, dir };
    return dir;
  } catch {
    memoizedEnsure = { key, dir: null };
    return null;
  }
}
