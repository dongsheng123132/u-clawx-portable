import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..');
export const releaseDir = path.join(projectRoot, 'release');
export const RCEDIT_VERSION = '2.0.0';
export const RCEDIT_EXE_NAME = 'rcedit-x64.exe';
export const RCEDIT_SHA512 = 'wT5//WAWnDSOFqPqWaFxwXd6zbJB+VDBGm6baclVo6TrNDIYKu5/SJqHpVXQvVH947WXgm98HmSI8fUJc1mrTQ==';
export const RCEDIT_URL = `https://github.com/electron/rcedit/releases/download/v${RCEDIT_VERSION}/${RCEDIT_EXE_NAME}`;

export function resolveTargetDirArgument(input, rootDir = projectRoot) {
  return path.isAbsolute(input) ? input : path.resolve(rootDir, input);
}

export function resolveDefaultTargetDir(options = {}) {
  const rootReleaseDir = options.releaseDir ?? releaseDir;
  const portableStageDir = path.join(rootReleaseDir, 'portable-staging');
  const directCandidates = [
    path.join(portableStageDir, 'win-unpacked'),
    path.join(rootReleaseDir, 'win-unpacked'),
    path.join(rootReleaseDir, 'u-claw'),
  ];

  for (const candidate of directCandidates) {
    if (existsSync(path.join(candidate, 'U-Claw.exe'))) {
      return candidate;
    }
  }

  if (!existsSync(rootReleaseDir)) {
    return directCandidates[0];
  }

  const discovered = readdirSync(rootReleaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootReleaseDir, entry.name))
    .find((candidate) => existsSync(path.join(candidate, 'U-Claw.exe')));

  return discovered ?? directCandidates[0];
}

export function buildRceditIconArgs(exePath, iconPath) {
  return [exePath, '--set-icon', iconPath];
}

/**
 * Read the brand identity out of the files that already own it, rather than
 * hardcoding it here — electron-builder.yml is the single source of truth for
 * productName/copyright, package.json for the version.
 */
export function resolveBrand(rootDir = projectRoot) {
  const builder = parseYaml(readFileSync(path.join(rootDir, 'electron-builder.yml'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  return {
    productName: builder.productName,
    displayName: builder.nsis?.shortcutName ?? builder.productName,
    copyright: builder.copyright ?? '',
    version: pkg.version,
  };
}

/**
 * Version-resource strings for the packaged exe.
 *
 * The portable build passes `--config.win.signAndEditExecutable=false` to
 * electron-builder (it has no signing certificate), and that flag disables
 * electron-builder's *own* rcedit pass — which is what would normally stamp
 * these strings. So without this, the shipped U-Claw.exe reports
 * ProductName=Electron, CompanyName=GitHub, Inc., version 40.8.4: that is what
 * a customer sees in right-click → Properties, in Task Manager, and in the
 * SmartScreen prompt on first launch. An app that introduces itself as someone
 * else's is not a finished customization.
 */
export function buildRceditBrandArgs(exePath, brand) {
  const strings = {
    ProductName: brand.productName,
    FileDescription: brand.displayName,
    CompanyName: brand.displayName,
    LegalCopyright: brand.copyright,
    InternalName: brand.productName,
    OriginalFilename: `${brand.productName}.exe`,
  };

  const args = [exePath];
  for (const [key, value] of Object.entries(strings)) {
    if (value) args.push('--set-version-string', key, value);
  }
  if (brand.version) {
    args.push('--set-file-version', brand.version, '--set-product-version', brand.version);
  }
  return args;
}

function getCacheCandidates(rootDir = projectRoot) {
  const electronBuilderCacheDir = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
  );

  const candidates = [];
  if (existsSync(electronBuilderCacheDir)) {
    for (const entry of readdirSync(electronBuilderCacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(electronBuilderCacheDir, entry.name);
      if (existsSync(path.join(candidate, RCEDIT_EXE_NAME))) {
        candidates.push(candidate);
      }
    }
  }

  const localCache = path.join(rootDir, 'build', '.cache', 'rcedit');
  if (existsSync(path.join(localCache, RCEDIT_EXE_NAME))) {
    candidates.push(localCache);
  }

  return candidates;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha512').update(buffer).digest('base64');
  if (digest !== RCEDIT_SHA512) {
    throw new Error(`Checksum mismatch for ${RCEDIT_EXE_NAME}`);
  }

  await writeFile(destination, buffer);
}

async function ensureRceditDir(rootDir = projectRoot) {
  for (const candidate of getCacheCandidates(rootDir)) {
    if (existsSync(path.join(candidate, RCEDIT_EXE_NAME))) {
      return candidate;
    }
  }

  const localCache = path.join(rootDir, 'build', '.cache', 'rcedit');
  const exePath = path.join(localCache, RCEDIT_EXE_NAME);
  await mkdir(localCache, { recursive: true });

  if (!existsSync(exePath)) {
    console.log(`[icon] downloading ${RCEDIT_EXE_NAME}`);
    await downloadFile(RCEDIT_URL, exePath);
  }

  if (!existsSync(exePath)) {
    throw new Error(`${RCEDIT_EXE_NAME} not found after downloading ${RCEDIT_URL}`);
  }

  return localCache;
}

async function runRcedit(rceditPath, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(rceditPath, args, { stdio: 'inherit' });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`rcedit exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function patchWinExeIcon(options = {}) {
  const rootDir = options.projectRootDir ?? projectRoot;
  const targetDir = options.targetDir ?? resolveDefaultTargetDir({ releaseDir: path.join(rootDir, 'release') });
  const exePath = path.join(targetDir, 'U-Claw.exe');
  const iconPath = path.join(rootDir, 'resources', 'icons', 'icon.ico');

  if (!existsSync(exePath)) {
    throw new Error(`Target exe not found: ${exePath}`);
  }

  if (!existsSync(iconPath)) {
    throw new Error(`Icon not found: ${iconPath}`);
  }

  const rceditDir = options.rceditDir ?? await ensureRceditDir(rootDir);
  const rceditPath = path.join(rceditDir, RCEDIT_EXE_NAME);

  await runRcedit(rceditPath, buildRceditIconArgs(exePath, iconPath));

  // Separate rcedit invocation on purpose: an icon that landed but a brand
  // string that failed should not read as "the whole patch failed", and the
  // reverse is the defect that actually shipped for months.
  const brand = resolveBrand(rootDir);
  await runRcedit(rceditPath, buildRceditBrandArgs(exePath, brand));

  return exePath;
}

async function main() {
  const targetDir = process.argv[2]
    ? resolveTargetDirArgument(process.argv[2])
    : resolveDefaultTargetDir();
  const exePath = await patchWinExeIcon({ targetDir });
  const brand = resolveBrand();
  console.log(`[icon] patched ${exePath}`);
  console.log(`[brand] ${brand.productName} / ${brand.displayName} / v${brand.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error('[icon] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
