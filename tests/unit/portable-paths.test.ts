import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalUserDataDir = process.env.CLAWX_USER_DATA_DIR;
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importPathsFrom(root: string, userDataDir?: string) {
  vi.resetModules();
  process.chdir(root);
  if (userDataDir) {
    process.env.CLAWX_USER_DATA_DIR = userDataDir;
  } else {
    delete process.env.CLAWX_USER_DATA_DIR;
  }
  return await import('@electron/utils/paths');
}

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalUserDataDir === undefined) {
    delete process.env.CLAWX_USER_DATA_DIR;
  } else {
    process.env.CLAWX_USER_DATA_DIR = originalUserDataDir;
  }
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalOpenClawConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalOpenClawConfigPath;
  }
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('portable path resolution', () => {
  it('uses normal user directories when no portable marker exists', async () => {
    const appRoot = await createTempDir('uclaw-normal-root-');
    const userDataDir = join(await createTempDir('uclaw-user-data-'), 'userData');

    const paths = await importPathsFrom(appRoot, userDataDir);

    expect(paths.getAppRoot()).toBe(appRoot);
    expect(paths.isPortableMode()).toBe(false);
    expect(paths.getOpenClawConfigDir()).toBe(join(homedir(), '.openclaw'));
    expect(paths.getClawXConfigDir()).toBe(join(homedir(), '.clawx'));
    expect(paths.getDataDir()).toBe(userDataDir);
    expect(paths.expandPath('~/.openclaw/workspace')).toBe(join(homedir(), '.openclaw', 'workspace'));
    expect(paths.getOpenClawPortableEnv()).toEqual({});
  });

  it('enables portable mode from portable.flag', async () => {
    const appRoot = await createTempDir('uclaw-portable-flag-');
    await writeFile(join(appRoot, 'portable.flag'), 'portable\n', 'utf8');

    const paths = await importPathsFrom(appRoot);

    expect(paths.isPortableMode()).toBe(true);
    expect(paths.getPortableDataDir()).toBe(join(appRoot, 'data'));
    expect(paths.getOpenClawConfigDir()).toBe(join(appRoot, 'data', '.openclaw'));
    expect(paths.getClawXConfigDir()).toBe(join(appRoot, 'data', '.clawx'));
    expect(paths.getDataDir()).toBe(join(appRoot, 'data', 'clawx-state'));
    expect(paths.expandPath('~/.openclaw/workspace')).toBe(join(appRoot, 'data', '.openclaw', 'workspace'));
    expect(paths.getOpenClawPortableEnv()).toEqual({
      OPENCLAW_HOME: join(appRoot, 'data'),
      OPENCLAW_STATE_DIR: join(appRoot, 'data', '.openclaw'),
      OPENCLAW_CONFIG_PATH: join(appRoot, 'data', '.openclaw', 'openclaw.json'),
    });
  });

  it('ignores host OpenClaw env overrides in portable mode', async () => {
    const appRoot = await createTempDir('uclaw-portable-host-env-');
    await writeFile(join(appRoot, 'portable.flag'), 'portable\n', 'utf8');
    process.env.OPENCLAW_STATE_DIR = resolve(appRoot, '..', 'host-openclaw-state');
    process.env.OPENCLAW_CONFIG_PATH = resolve(appRoot, '..', 'host-openclaw.json');

    const paths = await importPathsFrom(appRoot);
    const portableStateDir = join(appRoot, 'data', '.openclaw');

    expect(paths.resolveOpenClawStateDir()).toBe(portableStateDir);
    expect(paths.resolveOpenClawConfigPath()).toBe(join(portableStateDir, 'openclaw.json'));
    expect(paths.resolveOpenClawConfigDir()).toBe(portableStateDir);
  });

  it('enables portable mode from an existing data directory', async () => {
    const appRoot = await createTempDir('uclaw-portable-data-');
    await mkdir(join(appRoot, 'data'), { recursive: true });

    const paths = await importPathsFrom(appRoot);

    expect(paths.isPortableMode()).toBe(true);
    expect(paths.getPortableDataDir()).toBe(join(appRoot, 'data'));
    expect(paths.getOpenClawConfigDir()).toBe(join(appRoot, 'data', '.openclaw'));
    expect(paths.getClawXConfigDir()).toBe(join(appRoot, 'data', '.clawx'));
    expect(paths.getDataDir()).toBe(join(appRoot, 'data', 'clawx-state'));
  });
});

/**
 * 便携层的 helper 齐全 ≠ 便携生效 —— 得有人真的调它。
 *
 * 这一类漏法已经中过两次：
 *   1. getOpenClawPortableEnv() 写好了但零调用方 → Gateway 子进程读宿主机 ~/.openclaw，
 *      界面里冒出别的项目的历史会话。
 *   2. getDataDir() 便携分支写好了但没人 app.setPath('userData') → ClawX 自己的状态，
 *      **包括带 API key 的 uclaw-device.json**，落进 %APPDATA%/ClawX。
 *
 * 单测跑不到 Electron 主进程的启动顺序，所以这里做源码级断言：
 * 只证明「调用点还在」。删掉任何一处，这个测试红。
 */
describe('便携层的调用点（源码级）', () => {
  const repoRoot = join(__dirname, '..', '..');
  const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

  it("主进程在 whenReady 之前把 userData 改道到便携目录", () => {
    // 注释里也会提到这两个调用（就在改道那段的说明里），比位置前必须先剥掉，
    // 否则量的是注释而不是代码。
    const source = read('electron', 'main', 'index.ts')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(source).toContain("app.setPath('userData', getDataDir())");

    // 顺序才是关键：electron-store / logs / Chromium 数据都在 whenReady 之后才落盘，
    // 晚一步就写到宿主机去了。
    const redirectAt = source.indexOf("app.setPath('userData', getDataDir())");
    const readyAt = source.indexOf('app.whenReady()');
    expect(redirectAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeLessThan(readyAt);
  });

  it("主进程在 whenReady 之前把可丢弃的 Chromium sessionData 放到本机缓存", () => {
    const source = read('electron', 'main', 'index.ts')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(source).toContain('resolvePortableSessionDataDecision({');
    expect(source).toContain("app.setPath('sessionData', sessionData.path)");

    const redirectAt = source.indexOf("app.setPath('sessionData', sessionData.path)");
    const readyAt = source.indexOf('app.whenReady()');
    expect(redirectAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeLessThan(readyAt);
  });

  it('每个拉起 OpenClaw 子进程的地方都注入便携 env', () => {
    for (const file of [
      ['electron', 'gateway', 'process-launcher.ts'],
      ['electron', 'gateway', 'supervisor.ts'],
      ['electron', 'utils', 'openclaw-cli.ts'],
      ['electron', 'utils', 'control-ui-device-pairing.ts'],
    ]) {
      expect(read(...file), file.join('/')).toContain('getOpenClawPortableEnv()');
    }
  });
});
