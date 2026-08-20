import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PACKAGE_DOWNLOAD_CACHE_ENV = 'CLAWX_PACKAGE_DOWNLOAD_CACHE_DIR';
export const PACKAGE_DOWNLOAD_CACHE_REFRESH_ENV = 'CLAWX_REFRESH_DOWNLOAD_CACHE';

export function resolvePackageDownloadCacheDir(rootDir, env = process.env) {
  const configured = env[PACKAGE_DOWNLOAD_CACHE_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(rootDir, '.cache', 'package-downloads');
}

export function shouldRefreshPackageDownloadCache(env = process.env) {
  const value = env[PACKAGE_DOWNLOAD_CACHE_REFRESH_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'force';
}

export function sanitizeCachePathPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || 'unnamed';
}

export function createPackageCacheKey(input, length = 16) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, length);
}

export function resolvePackageCachePath({ rootDir, namespace, version, filename, env = process.env }) {
  return path.join(
    resolvePackageDownloadCacheDir(rootDir, env),
    sanitizeCachePathPart(namespace),
    sanitizeCachePathPart(version),
    sanitizeCachePathPart(filename),
  );
}

export async function isUsableCacheFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function getOrDownloadCachedFile({
  url,
  rootDir,
  namespace,
  version,
  filename,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!fetchImpl) {
    throw new Error('fetch is not available in this Node.js runtime');
  }

  const cachePath = resolvePackageCachePath({ rootDir, namespace, version, filename, env });
  const refresh = shouldRefreshPackageDownloadCache(env);

  if (!refresh && await isUsableCacheFile(cachePath)) {
    return { path: cachePath, source: 'cache' };
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.download-${process.pid}-${Date.now()}`;

  try {
    const response = await fetchImpl(url);
    if (!response?.ok) {
      throw new Error(`Failed to download ${url}: ${response?.statusText || response?.status || 'unknown error'}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error(`Downloaded empty response: ${url}`);
    }

    await writeFile(tempPath, buffer);
    await rename(tempPath, cachePath);
    return { path: cachePath, source: 'network' };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    if (await isUsableCacheFile(cachePath)) {
      return {
        path: cachePath,
        source: 'stale-cache',
        warning: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

export function resolveElectronCacheEnv(rootDir, env = process.env) {
  return {
    ...env,
    ELECTRON_CACHE: env.ELECTRON_CACHE || path.join(rootDir, '.cache', 'electron'),
    ELECTRON_BUILDER_CACHE: env.ELECTRON_BUILDER_CACHE || path.join(rootDir, '.cache', 'electron-builder'),
  };
}

export function ensureElectronCacheDirs(env) {
  for (const key of ['ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE']) {
    const value = env[key];
    if (value && !existsSync(value)) {
      mkdirSync(value, { recursive: true });
    }
  }
}
