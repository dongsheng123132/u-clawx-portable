// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getOrDownloadCachedFile,
  resolveElectronCacheEnv,
  resolvePackageCachePath,
} from '../../scripts/package-resource-cache.mjs';

const tempDirs: string[] = [];

async function makeTempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'package-resource-cache-'));
  tempDirs.push(dir);
  return dir;
}

function responseWithBody(body: string) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('package resource cache', () => {
  it('uses an existing local archive before trying the network', async () => {
    const rootDir = await makeTempRoot();
    const cachePath = resolvePackageCachePath({
      rootDir,
      namespace: 'uv',
      version: 'v-test',
      filename: 'uv-test.zip',
      env: {},
    });
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, 'cached archive');

    const fetchImpl = vi.fn(async () => {
      throw new Error('network should not be used');
    });

    const result = await getOrDownloadCachedFile({
      url: 'https://example.test/uv-test.zip',
      rootDir,
      namespace: 'uv',
      version: 'v-test',
      filename: 'uv-test.zip',
      env: {},
      fetchImpl,
    });

    expect(result).toEqual({ path: cachePath, source: 'cache' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('cached archive');
  });

  it('downloads and stores a missing archive in the local cache', async () => {
    const rootDir = await makeTempRoot();
    const fetchImpl = vi.fn(async () => responseWithBody('downloaded archive'));

    const result = await getOrDownloadCachedFile({
      url: 'https://example.test/node-test.zip',
      rootDir,
      namespace: 'node',
      version: 'v-test',
      filename: 'node-test.zip',
      env: {},
      fetchImpl,
    });

    expect(result.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(readFile(result.path, 'utf8')).resolves.toBe('downloaded archive');
  });

  it('refreshes an existing cache file when explicitly requested', async () => {
    const rootDir = await makeTempRoot();
    const cachePath = resolvePackageCachePath({
      rootDir,
      namespace: 'uv',
      version: 'v-test',
      filename: 'uv-test.zip',
      env: {},
    });
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, 'old archive');

    const fetchImpl = vi.fn(async () => responseWithBody('fresh archive'));

    const result = await getOrDownloadCachedFile({
      url: 'https://example.test/uv-test.zip',
      rootDir,
      namespace: 'uv',
      version: 'v-test',
      filename: 'uv-test.zip',
      env: { CLAWX_REFRESH_DOWNLOAD_CACHE: '1' },
      fetchImpl,
    });

    expect(result).toEqual({ path: cachePath, source: 'network' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('fresh archive');
  });

  it('keeps electron-builder cache directories inside the repo by default', async () => {
    const rootDir = await makeTempRoot();
    const env = resolveElectronCacheEnv(rootDir, {});

    expect(env.ELECTRON_CACHE).toBe(join(rootDir, '.cache', 'electron'));
    expect(env.ELECTRON_BUILDER_CACHE).toBe(join(rootDir, '.cache', 'electron-builder'));

    const custom = resolveElectronCacheEnv(rootDir, {
      ELECTRON_CACHE: 'C:/custom/electron',
      ELECTRON_BUILDER_CACHE: 'C:/custom/builder',
    });
    expect(custom.ELECTRON_CACHE).toBe('C:/custom/electron');
    expect(custom.ELECTRON_BUILDER_CACHE).toBe('C:/custom/builder');
  });
});
