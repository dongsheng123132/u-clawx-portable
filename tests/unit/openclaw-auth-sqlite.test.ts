// @vitest-environment node

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/clawx-auth-sqlite-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

async function writeJsonStore(agentId: string, store: Record<string, unknown>): Promise<void> {
  const dir = join(testHome, '.openclaw', 'agents', agentId, 'agent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth-profiles.json'), JSON.stringify(store, null, 2), 'utf8');
}

describe('openclaw-auth-sqlite', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
  });

  it('migrates auth-profiles.json into openclaw-agent.sqlite when sqlite is empty', async () => {
    await writeJsonStore('main', {
      version: 1,
      profiles: {
        'custom-customc7:default': {
          type: 'api_key',
          provider: 'custom-customc7',
          key: 'sk-test-key',
        },
      },
      order: { 'custom-customc7': ['custom-customc7:default'] },
      lastGood: { 'custom-customc7': 'custom-customc7:default' },
    });

    const {
      migrateAuthProfilesJsonToSqliteIfNeeded,
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    const migrated = await migrateAuthProfilesJsonToSqliteIfNeeded('main');
    expect(migrated).toBe(true);
    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);

    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-test-key',
    });
    expect(sqliteStore?.order?.['custom-customc7']).toEqual(['custom-customc7:default']);
    expect(sqliteStore?.lastGood?.['custom-customc7']).toBe('custom-customc7:default');
  });

  it('saveProviderKeyToOpenClaw writes credentials readable from sqlite', async () => {
    const { saveProviderKeyToOpenClaw } = await import('@electron/utils/openclaw-auth');
    const {
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    await saveProviderKeyToOpenClaw('custom-customc7', 'sk-runtime-key', 'main');

    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);
    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-runtime-key',
    });

    const json = JSON.parse(
      await readFile(join(testHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect((json.profiles as Record<string, unknown>)['custom-customc7:default']).toMatchObject({
      key: 'sk-runtime-key',
    });
  });

  it('便携模式下凭证不许落到宿主机 home —— SQLite 侧必须跟 JSON 侧同一个目录', async () => {
    // 这个文件是上游 bf038f5c 带进来的，原文 getAgentAuthDir 写死 homedir()。
    // 上游没有便携约束所以对他们没问题；对 U-ClawX 则意味着从 U 盘运行时
    // openclaw-agent.sqlite（**里面存着 API key**）写进宿主机用户目录，
    // 插到谁的电脑上就在谁硬盘里留一份凭证。
    // 而 JSON 侧走的是便携 helper —— 两边不一致时 readAuthProfiles 先读 SQLite，
    // 等于读宿主机、写 U 盘。
    const portableAgents = join(testHome, 'portable-drive', 'data', '.openclaw', 'agents');
    vi.resetModules();
    vi.doMock('@electron/utils/paths', async () => {
      const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
      return { ...actual, getOpenClawAgentsDir: () => portableAgents };
    });

    const { getAuthProfilesSqlitePath, getAuthProfilesJsonPath } =
      await import('@electron/utils/openclaw-auth-sqlite');

    for (const p of [getAuthProfilesSqlitePath('main'), getAuthProfilesJsonPath('main')]) {
      expect(p.startsWith(portableAgents)).toBe(true);
      expect(p.startsWith(join(testHome, '.openclaw'))).toBe(false);
    }

    vi.doUnmock('@electron/utils/paths');
  });
});
