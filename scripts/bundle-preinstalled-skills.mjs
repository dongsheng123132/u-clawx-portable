#!/usr/bin/env zx

import 'zx/globals';
import { execFile } from 'node:child_process';
import { copyFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyDirSafe } from './copy-dir-safe.mjs';
import { join, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createPackageCacheKey,
  resolvePackageDownloadCacheDir,
  shouldRefreshPackageDownloadCache,
} from './package-resource-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'resources', 'skills', 'preinstalled-manifest.json');
const OUTPUT_ROOT = join(ROOT, 'build', 'preinstalled-skills');
const TMP_ROOT = join(ROOT, 'build', '.tmp-preinstalled-skills');
const execFileAsync = promisify(execFile);

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing manifest: ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.skills)) {
    throw new Error('Invalid preinstalled-skills manifest format');
  }
  for (const item of parsed.skills) {
    if (!item.slug || !item.repo || !item.repoPath) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(item)}`);
    }
  }
  return parsed.skills;
}

function groupByRepoRef(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const ref = entry.ref || 'main';
    const key = `${entry.repo}#${ref}`;
    if (!grouped.has(key)) grouped.set(key, { repo: entry.repo, ref, entries: [] });
    grouped.get(key).entries.push(entry);
  }
  return [...grouped.values()];
}

function createRepoDirName(repo, ref) {
  return `${repo.replace(/[\\/]/g, '__')}__${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function toGitPath(inputPath) {
  if (process.platform !== 'win32') return inputPath;
  // Git on Windows accepts forward slashes and avoids backslash escape quirks.
  return inputPath.replace(/\\/g, '/');
}

function normalizeRepoPath(repoPath) {
  return repoPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function shouldCopySkillFile(srcPath) {
  const base = basename(srcPath);
  if (base === '.git') return false;
  if (base === '.subset.tar') return false;
  return true;
}

async function extractArchive(archiveFileName, cwd) {
  try {
    await execFileAsync('tar', ['-xf', archiveFileName], { cwd });
    return;
  } catch (tarError) {
    if (process.platform === 'win32') {
      // Some Windows images expose bsdtar instead of tar; Git Bash GNU tar
      // also chokes on absolute C:\ paths, so fall back to the System32
      // bsdtar which handles Windows paths natively.
      try {
        await execFileAsync('bsdtar', ['-xf', archiveFileName], { cwd });
        return;
      } catch {
        await execFileAsync('C:\\Windows\\System32\\tar.exe', ['-xf', archiveFileName], { cwd });
        return;
      }
    }
    throw tarError;
  }
}

function isFileWithContent(filePath) {
  try {
    const info = statSync(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function createSparseCachePaths(repo, ref, archivePaths) {
  const cacheRoot = resolvePackageDownloadCacheDir(ROOT);
  const key = createPackageCacheKey(JSON.stringify(archivePaths));
  const dir = join(cacheRoot, 'preinstalled-skills', createRepoDirName(repo, ref), key);
  return {
    dir,
    archivePath: join(dir, 'subset.tar'),
    metadataPath: join(dir, 'metadata.json'),
  };
}

function readSparseCacheMetadata(metadataPath, repo, ref, archivePaths) {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (
      metadata?.repo === repo
      && metadata?.ref === ref
      && Array.isArray(metadata?.archivePaths)
      && JSON.stringify(metadata.archivePaths) === JSON.stringify(archivePaths)
      && typeof metadata?.commit === 'string'
      && metadata.commit
    ) {
      return metadata;
    }
  } catch {
    // Ignore invalid cache metadata and fetch again.
  }
  return null;
}

async function restoreSparseRepoFromCache(cache, repo, ref, archivePaths, checkoutDir) {
  if (shouldRefreshPackageDownloadCache()) return null;
  if (!isFileWithContent(cache.archivePath) || !isFileWithContent(cache.metadataPath)) {
    return null;
  }

  const metadata = readSparseCacheMetadata(cache.metadataPath, repo, ref, archivePaths);
  if (!metadata) return null;

  try {
    mkdirSync(checkoutDir, { recursive: true });
    await extractArchive(cache.archivePath, checkoutDir);
    echo(chalk.cyan`📦 Using cached preinstalled skills archive: ${cache.archivePath}`);
    return metadata.commit;
  } catch (error) {
    echo(chalk.yellow`⚠️  Failed to restore cached skills archive, fetching again: ${error instanceof Error ? error.message : String(error)}`);
    rmSync(checkoutDir, { recursive: true, force: true });
    return null;
  }
}

function writeSparseRepoCache(cache, archivePath, repo, ref, archivePaths, commit) {
  try {
    mkdirSync(cache.dir, { recursive: true });
    copyFileSync(archivePath, cache.archivePath);
    writeFileSync(cache.metadataPath, `${JSON.stringify({
      repo,
      ref,
      archivePaths,
      commit,
      cachedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    echo(chalk.green`⬇️ Cached preinstalled skills archive: ${cache.archivePath}`);
  } catch (error) {
    echo(chalk.yellow`⚠️  Failed to write preinstalled skills cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function fetchSparseRepo(repo, ref, paths, checkoutDir) {
  const remote = `https://github.com/${repo}.git`;
  mkdirSync(checkoutDir, { recursive: true });
  const gitCheckoutDir = toGitPath(checkoutDir);
  const archiveFileName = '.subset.tar';
  const archivePath = join(checkoutDir, archiveFileName);
  const archivePaths = [...new Set(paths.map(normalizeRepoPath))].sort();
  const cache = createSparseCachePaths(repo, ref, archivePaths);

  const cachedCommit = await restoreSparseRepoFromCache(cache, repo, ref, archivePaths, checkoutDir);
  if (cachedCommit) {
    return cachedCommit;
  }

  await runGit(['init', gitCheckoutDir]);
  await runGit(['-C', gitCheckoutDir, 'remote', 'add', 'origin', remote]);
  // Proxy connections to GitHub reset transiently on this network; retry the
  // fetch a few times before failing the whole packaging run.
  let fetched = false;
  for (let attempt = 1; attempt <= 3 && !fetched; attempt += 1) {
    try {
      await runGit(['-C', gitCheckoutDir, 'fetch', '--depth', '1', 'origin', ref]);
      fetched = true;
    } catch (error) {
      if (attempt === 3) throw error;
      echo(chalk.yellow(`⚠️  git fetch ${repo} failed (attempt ${attempt}/3), retrying in 5s...`));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  // Do not checkout working tree on Windows: upstream repos may contain
  // Windows-invalid paths. Export only requested directories via git archive.
  await runGit(['-C', gitCheckoutDir, 'archive', '--format=tar', '--output', archiveFileName, 'FETCH_HEAD', ...archivePaths]);
  const commit = await runGit(['-C', gitCheckoutDir, 'rev-parse', 'FETCH_HEAD']);
  writeSparseRepoCache(cache, archivePath, repo, ref, archivePaths, commit);
  await extractArchive(archiveFileName, checkoutDir);
  rmSync(archivePath, { force: true });

  return commit;
}

echo`Bundling preinstalled skills...`;

if (process.env.SKIP_PREINSTALLED_SKILLS === '1') {
  echo`⏭  SKIP_PREINSTALLED_SKILLS=1 set, skipping skills fetch.`;
  process.exit(0);
}

const manifestSkills = loadManifest();

rmSync(OUTPUT_ROOT, { recursive: true, force: true });
mkdirSync(OUTPUT_ROOT, { recursive: true });
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const lock = {
  generatedAt: new Date().toISOString(),
  skills: [],
};

const groups = groupByRepoRef(manifestSkills);
for (const group of groups) {
  const repoDir = join(TMP_ROOT, createRepoDirName(group.repo, group.ref));
  const sparsePaths = [...new Set(group.entries.map((entry) => entry.repoPath))];

  echo`Fetching ${group.repo} @ ${group.ref}`;
  const commit = await fetchSparseRepo(group.repo, group.ref, sparsePaths, repoDir);
  echo`   commit ${commit}`;

  for (const entry of group.entries) {
    const sourceDir = join(repoDir, entry.repoPath);
    const targetDir = join(OUTPUT_ROOT, entry.slug);

    if (!existsSync(sourceDir)) {
      throw new Error(`Missing source path in repo checkout: ${entry.repoPath}`);
    }

    rmSync(targetDir, { recursive: true, force: true });
    copyDirSafe(sourceDir, targetDir, true, shouldCopySkillFile);

    const skillManifest = join(targetDir, 'SKILL.md');
    if (!existsSync(skillManifest)) {
      throw new Error(`Skill ${entry.slug} is missing SKILL.md after copy`);
    }

    const requestedVersion = (entry.version || '').trim();
    const resolvedVersion = !requestedVersion || requestedVersion === 'main'
      ? commit
      : requestedVersion;
    lock.skills.push({
      slug: entry.slug,
      version: resolvedVersion,
      repo: entry.repo,
      repoPath: entry.repoPath,
      ref: group.ref,
      commit,
    });

    echo`   OK ${entry.slug}`;
  }
}

writeFileSync(join(OUTPUT_ROOT, '.preinstalled-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
rmSync(TMP_ROOT, { recursive: true, force: true });
echo`Preinstalled skills ready: ${OUTPUT_ROOT}`;
