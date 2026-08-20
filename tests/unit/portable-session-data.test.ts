import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getPortableSystemSessionDataPath,
  resolvePortableSessionDataDecision,
} from '@electron/utils/portable-session-data';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('portable Chromium session data', () => {
  it('uses the system cache when the portable setting is absent', async () => {
    const portableStateDir = await createTempDir('uclaw-portable-state-');

    const decision = resolvePortableSessionDataDecision({
      appRoot: 'D:\\U-Claw',
      portableStateDir,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    });

    expect(decision.enabled).toBe(true);
    expect(decision.path).toContain('C:\\Users\\alice\\AppData\\Local\\U-Claw\\portable-chromium-session');
  });

  it('stays on the portable drive when the setting is explicitly disabled', async () => {
    const portableStateDir = await createTempDir('uclaw-portable-state-');
    await writeFile(join(portableStateDir, 'settings.json'), JSON.stringify({
      portableUseSystemChromiumCache: false,
    }), 'utf8');

    expect(resolvePortableSessionDataDecision({
      appRoot: 'D:\\U-Claw',
      portableStateDir,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    })).toEqual({
      enabled: false,
      path: null,
    });
  });

  it('resolves a local system cache path when enabled', async () => {
    const portableStateDir = await createTempDir('uclaw-portable-state-');
    await writeFile(join(portableStateDir, 'settings.json'), JSON.stringify({
      portableUseSystemChromiumCache: true,
    }), 'utf8');

    const decision = resolvePortableSessionDataDecision({
      appRoot: 'D:\\U-Claw',
      portableStateDir,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    });

    expect(decision.enabled).toBe(true);
    expect(decision.path).toContain('C:\\Users\\alice\\AppData\\Local\\U-Claw\\portable-chromium-session');
    expect(decision.path).not.toContain('D:\\U-Claw');
  });

  it('uses a stable path for the same app root', () => {
    const first = getPortableSystemSessionDataPath('D:\\U-Claw', 'win32', {
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    });
    const second = getPortableSystemSessionDataPath('d:\\u-claw', 'win32', {
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    });

    expect(first).toBe(second);
  });

  it('uses the same system cache path when the portable drive letter changes', async () => {
    const portableStateDir = await createTempDir('uclaw-portable-state-');
    const env = { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' };

    const first = getPortableSystemSessionDataPath('D:\\U-Claw', 'win32', env, portableStateDir);
    const second = getPortableSystemSessionDataPath('E:\\U-Claw', 'win32', env, portableStateDir);

    expect(first).toBe(second);
  });

  it('uses different system cache paths for different portable state directories', async () => {
    const firstStateDir = await createTempDir('uclaw-portable-state-a-');
    const secondStateDir = await createTempDir('uclaw-portable-state-b-');
    const env = { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' };

    const first = getPortableSystemSessionDataPath('D:\\U-Claw', 'win32', env, firstStateDir);
    const second = getPortableSystemSessionDataPath('D:\\U-Claw', 'win32', env, secondStateDir);

    expect(first).not.toBe(second);
  });

  it('persists one cache id and reuses it for repeated decisions in the same portable state dir', async () => {
    const portableStateDir = await createTempDir('uclaw-portable-state-');
    const env = { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' };

    const first = resolvePortableSessionDataDecision({
      appRoot: 'D:\\U-Claw',
      portableStateDir,
      platform: 'win32',
      env,
    });
    const firstId = await readFile(join(portableStateDir, 'portable-session-cache-id'), 'utf8');

    const second = resolvePortableSessionDataDecision({
      appRoot: 'E:\\U-Claw',
      portableStateDir,
      platform: 'win32',
      env,
    });
    const secondId = await readFile(join(portableStateDir, 'portable-session-cache-id'), 'utf8');

    expect(second.path).toBe(first.path);
    expect(secondId).toBe(firstId);
  });
});
