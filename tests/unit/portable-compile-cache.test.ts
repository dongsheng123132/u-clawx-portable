import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePortableNodeCompileCache,
  getPortableNodeCompileCachePath,
} from '../../electron/utils/portable-compile-cache';

/**
 * 本机编译缓存（NODE_COMPILE_CACHE）路径解析。
 *
 * 设计对齐 portable-session-data.ts：UUID 盘符隔离 + 本机缓存根 + 失败静默。
 * pc-8308 实测背景见 portable-compile-cache.ts 头注释。
 */

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-compile-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WIN_ENV = { LOCALAPPDATA: 'C:\\host-cache' };
const MAC_ENV = { HOME: '/Users/tester' };
const LINUX_ENV = { XDG_CACHE_HOME: '/host/xdg-cache' };

describe('getPortableNodeCompileCachePath', () => {
  it('落在宿主机平台缓存根下，且按盘符身份哈希隔离', () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, 'portable-compile-cache-id'), `${randomUUID()}\n`, 'utf8');

    const winPath = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDir);
    expect(winPath?.startsWith('C:\\host-cache')).toBe(true);
    expect(winPath).toContain(join('U-Claw', 'node-compile-cache'));

    const macPath = getPortableNodeCompileCachePath('darwin', MAC_ENV, stateDir);
    expect(macPath?.startsWith(join('/Users/tester', 'Library', 'Caches'))).toBe(true);
    expect(macPath).toContain(join('U-Claw', 'node-compile-cache'));

    const linuxPath = getPortableNodeCompileCachePath('linux', LINUX_ENV, stateDir);
    // 测试机可能是 Windows：path.join 会按 win32 规范化前缀，这里只认段。
    expect(linuxPath).toContain('xdg-cache');
    expect(linuxPath).toContain(join('U-Claw', 'node-compile-cache'));
  });

  it('同一 UUID 身份 → 同一路径；不同身份 → 不同路径', () => {
    const stateDirA = makeStateDir();
    const id = randomUUID();
    writeFileSync(join(stateDirA, 'portable-compile-cache-id'), `${id}\n`, 'utf8');

    const a1 = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDirA);
    const a2 = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDirA);
    expect(a1).toBe(a2);

    const stateDirB = makeStateDir();
    writeFileSync(join(stateDirB, 'portable-compile-cache-id'), `${randomUUID()}\n`, 'utf8');
    const b = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDirB);
    expect(b).not.toBe(a1);
  });

  it('没有身份文件且 U 盘可写时会自建身份；身份不可用时禁用（返回 null）', () => {
    // 无 stateDir → 拿不到身份 → 必须禁用而不是退化到共享固定身份。
    const p1 = getPortableNodeCompileCachePath('win32', WIN_ENV, undefined);
    expect(p1).toBeNull();
  });

  it('损坏的身份文件被忽略：自愈成新身份且路径稳定，绝不把脏内容带进路径', () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, 'portable-compile-cache-id'), '../../../evil\n', 'utf8');
    const p1 = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDir);
    const p2 = getPortableNodeCompileCachePath('win32', WIN_ENV, stateDir);
    expect(p1).not.toContain('evil');
    // 脏文件触发重写后，后续调用命中新身份，路径保持稳定。
    expect(p1).toBe(p2);
  });
});

describe('ensurePortableNodeCompileCache', () => {
  it('创建目录并返回同一路径', () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, 'portable-compile-cache-id'), `${randomUUID()}\n`, 'utf8');

    const dir = ensurePortableNodeCompileCache('win32', WIN_ENV, stateDir);
    expect(dir).toBeTruthy();
    expect(existsSync(dir!)).toBe(true);
    expect(dir).toBe(getPortableNodeCompileCachePath('win32', WIN_ENV, stateDir));
  });

  it('本机缓存根不可写时返回 null，绝不抛异常', () => {
    // 指一个不可能存在的根（Windows 保留名设备路径），mkdir 必失败。
    const dir = ensurePortableNodeCompileCache('win32', { LOCALAPPDATA: '\\\\?\\globalroot\\impossible' }, undefined);
    expect(dir).toBeNull();
  });
});
