import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { copyDirSafe } from './copy-dir-safe.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..');
export const releaseDir = path.join(projectRoot, 'release');
export const finalTargetDir = path.join(releaseDir, 'win-unpacked');
export const portableRootFiles = ['license.clawx.txt'];
export const portableLicenseFileNames = [
  'license.clawx.txt',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
];
export const portableLicenseDirName = 'third-party-licenses';
export const portableCloudEndpointConfigFileName = 'uclaw-cloud-endpoints.json';

const resetScriptFileName = '一键重置.bat';
const presetAgentModuleCache = new Map();

function buildPortableResetScript() {
  return [
    '@echo off',
    'setlocal',
    'set "APP_ROOT=%~dp0"',
    'set "CHROMIUM_CACHE_DIR=%LOCALAPPDATA%\\U-ClawX\\portable-chromium-session"',
    'if not exist "%APP_ROOT%U-ClawX.exe" (',
    '  echo [reset] U-ClawX.exe was not found next to this script.',
    '  echo [reset] Move the script back into the packaged portable directory and try again.',
    '  pause',
    '  exit /b 1',
    ')',
    'if not exist "%APP_ROOT%portable.flag" if not exist "%APP_ROOT%data" (',
    '  echo [reset] Portable mode markers were not found in this directory.',
    '  echo [reset] This reset script only works for packaged portable builds.',
    '  pause',
    '  exit /b 1',
    ')',
    'tasklist /FI "IMAGENAME eq U-ClawX.exe" | find /I "U-ClawX.exe" >nul',
    'if not errorlevel 1 (',
    '  echo [reset] U-ClawX is running; closing it before reset...',
    '  taskkill /F /T /IM "U-ClawX.exe" >nul 2>&1',
    '  call :waitForUClawExit',
    '  if errorlevel 1 (',
    '    echo [reset] Failed to close U-ClawX. Please close it manually and try again.',
    '    pause',
    '    exit /b 1',
    '  )',
    ')',
    'echo This will clear U-ClawX portable user data and browser session data.',
    'echo.',
    'echo Press any key to continue, or close this window to cancel.',
    'pause >nul',
    'if exist "%CHROMIUM_CACHE_DIR%" (',
    '  rmdir /S /Q "%CHROMIUM_CACHE_DIR%"',
    '  if exist "%CHROMIUM_CACHE_DIR%" (',
    '    echo [reset] Failed to clear browser session data.',
    '    pause',
    '    exit /b 1',
    '  )',
    ')',
    'if exist "%APP_ROOT%data" (',
    '  rmdir /S /Q "%APP_ROOT%data"',
    '  if exist "%APP_ROOT%data" (',
    '    echo [reset] Failed to clear portable user data.',
    '    pause',
    '    exit /b 1',
    '  )',
    ')',
    'mkdir "%APP_ROOT%data" >nul 2>&1',
    'if not exist "%APP_ROOT%data" (',
    '  echo [reset] Failed to prepare portable user data.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [reset] Cleanup completed successfully.',
    'echo [reset] This window will close automatically in 3 seconds.',
    'timeout /T 3 /NOBREAK >nul',
    'exit /b 0',
    '',
    ':waitForUClawExit',
    'for /L %%I in (1,1,10) do (',
    '  tasklist /FI "IMAGENAME eq U-ClawX.exe" | find /I "U-ClawX.exe" >nul',
    '  if errorlevel 1 exit /b 0',
    '  timeout /T 1 /NOBREAK >nul',
    ')',
    'exit /b 1',
    '',
  ].join('\r\n');
}

export function resolvePathArgument(input) {
  return path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
}

export function resolveDefaultSourceDir() {
  const directCandidate = finalTargetDir;
  if (existsSync(path.join(directCandidate, 'U-ClawX.exe'))) {
    return directCandidate;
  }
  if (!existsSync(releaseDir)) {
    return directCandidate;
  }
  const discovered = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(releaseDir, entry.name))
    .find((candidate) => existsSync(path.join(candidate, 'U-ClawX.exe')));
  return discovered ?? directCandidate;
}

export function resolveDefaultFinalTarget() {
  return finalTargetDir;
}

export async function finalizeTargetDir(sourceDir, desiredTargetDir) {
  const normalizedSource = path.resolve(sourceDir);
  const normalizedTarget = path.resolve(desiredTargetDir);
  if (!existsSync(normalizedSource)) {
    throw new Error(`Portable output directory not found: ${normalizedSource}`);
  }
  if (normalizedSource === normalizedTarget) {
    return normalizedTarget;
  }

  await mkdir(path.dirname(normalizedTarget), { recursive: true });
  await rm(normalizedTarget, { recursive: true, force: true });
  try {
    await rename(normalizedSource, normalizedTarget);
  } catch {
    // Node 22.20 cpSync 目录模式在非 ASCII 路径下进程级 abort，用手动递归兜底
    copyDirSafe(normalizedSource, normalizedTarget, false);
    await rm(normalizedSource, { recursive: true, force: true });
  }
  return normalizedTarget;
}

export async function copyPortableRootFiles(targetDir, options = {}) {
  const { projectRootDir = projectRoot } = options;
  const copiedFiles = [];
  for (const fileName of portableRootFiles) {
    const sourcePath = path.join(projectRootDir, fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required portable root file not found: ${sourcePath}`);
    }
    const destinationPath = path.join(targetDir, fileName);
    await copyFile(sourcePath, destinationPath);
    copiedFiles.push(destinationPath);
  }
  return copiedFiles;
}

export async function organizePortableLicenseFiles(targetDir) {
  const thirdPartyLicensesDir = path.join(targetDir, portableLicenseDirName);
  const organizedFiles = [];
  for (const fileName of portableLicenseFileNames) {
    const sourcePath = path.join(targetDir, fileName);
    if (!existsSync(sourcePath)) continue;
    await mkdir(thirdPartyLicensesDir, { recursive: true });
    const destinationPath = path.join(thirdPartyLicensesDir, fileName);
    await rm(destinationPath, { force: true });
    await rename(sourcePath, destinationPath);
    organizedFiles.push(destinationPath);
  }
  return {
    organizedFiles,
    thirdPartyLicensesDir: organizedFiles.length > 0 ? thirdPartyLicensesDir : null,
  };
}

export async function writePortableResetScript(targetDir) {
  const resetScriptPath = path.join(targetDir, resetScriptFileName);
  await writeFile(resetScriptPath, buildPortableResetScript(), 'utf8');
  return resetScriptPath;
}

export async function copyPortableCloudEndpointConfig(targetDir, options = {}) {
  const { projectRootDir = projectRoot } = options;
  const sourcePath = path.join(
    projectRootDir,
    'electron',
    'shared',
    'providers',
    'uclaw-cloud-endpoints.json',
  );
  if (!existsSync(sourcePath)) {
    throw new Error(`Required cloud endpoint config not found: ${sourcePath}`);
  }
  const destinationPath = path.join(targetDir, portableCloudEndpointConfigFileName);
  await copyFile(sourcePath, destinationPath);
  return destinationPath;
}

async function loadPresetAgentModule(projectRootDir) {
  const cacheKey = path.resolve(projectRootDir);
  const cached = presetAgentModuleCache.get(cacheKey);
  if (cached) return cached;

  const sourcePath = path.join(cacheKey, 'electron', 'utils', 'agent-presets.ts');
  const source = await readFile(sourcePath, 'utf8');
  const ts = await import('typescript');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled, 'utf8').toString('base64')}`;
  const modulePromise = import(moduleUrl);
  presetAgentModuleCache.set(cacheKey, modulePromise);
  return modulePromise;
}

function buildPresetIdentityFile(preset) {
  return [
    `# ${preset.name}`,
    '',
    `- **Icon:** ${preset.icon}`,
    `- **Preset ID:** ${preset.id}`,
    `- **Category:** ${preset.categoryLabel}`,
    `- **Description:** ${preset.description}`,
    '',
  ].join('\n');
}

function buildPresetToolsFile(preset) {
  return [
    '# Recommended Skills',
    '',
    'This preset works best with these OpenClaw skills:',
    '',
    ...preset.skillIds.map((skillId) => `- \`${skillId}\``),
    '',
  ].join('\n');
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function createMainAgentEntry() {
  return {
    id: 'main',
    name: 'Main Agent',
    default: true,
    workspace: '~/.openclaw/workspace',
    agentDir: '~/.openclaw/agents/main/agent',
  };
}

function createPresetAgentEntry(preset) {
  return {
    id: preset.id,
    name: preset.name,
    workspace: `~/.openclaw/workspace-${preset.id}`,
    agentDir: `~/.openclaw/agents/${preset.id}/agent`,
  };
}

function stripAgentUiMetadata(entry) {
  const sanitized = { ...entry };
  for (const key of ['description', 'icon', 'category', 'categoryLabel', 'source', 'presetId', 'skillIds']) {
    delete sanitized[key];
  }
  return sanitized;
}

async function seedAgentFilesystem(openclawDir, presetAgents) {
  await mkdir(path.join(openclawDir, 'workspace'), { recursive: true });
  await mkdir(path.join(openclawDir, 'agents', 'main', 'agent'), { recursive: true });
  await mkdir(path.join(openclawDir, 'agents', 'main', 'sessions'), { recursive: true });

  for (const preset of presetAgents) {
    const workspaceDir = path.join(openclawDir, `workspace-${preset.id}`);
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(path.join(openclawDir, 'agents', preset.id, 'agent'), { recursive: true });
    await mkdir(path.join(openclawDir, 'agents', preset.id, 'sessions'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'SOUL.md'), `${preset.systemPrompt.trimEnd()}\n`, 'utf8');
    await writeFile(path.join(workspaceDir, 'IDENTITY.md'), buildPresetIdentityFile(preset), 'utf8');
    await writeFile(path.join(workspaceDir, 'TOOLS.md'), buildPresetToolsFile(preset), 'utf8');
  }
}

export async function seedPortablePresetAgents(targetDir, options = {}) {
  const { presetSourceRootDir = projectRoot } = options;
  const openclawDir = path.join(targetDir, 'data', '.openclaw');
  const configPath = path.join(openclawDir, 'openclaw.json');
  const lastGoodPath = path.join(openclawDir, 'openclaw.json.last-good');
  const { PRESET_AGENTS, localizePresetAgent } = await loadPresetAgentModule(presetSourceRootDir);
  const presetAgents = PRESET_AGENTS.map((preset) => localizePresetAgent(preset, 'zh-CN'));

  await mkdir(openclawDir, { recursive: true });
  const config = await readJsonIfExists(configPath);
  const agentsConfig = config.agents && typeof config.agents === 'object' ? config.agents : {};
  const existingEntries = Array.isArray(agentsConfig.list)
    ? agentsConfig.list.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    : [];
  const nextEntries = existingEntries.map((entry) => stripAgentUiMetadata(entry));

  if (!nextEntries.some((entry) => entry.id === 'main')) {
    nextEntries.unshift(createMainAgentEntry());
  }

  for (const preset of presetAgents) {
    if (existingEntries.some((entry) => entry.id === preset.id || entry.presetId === preset.id)) {
      continue;
    }
    nextEntries.push(createPresetAgentEntry(preset));
  }

  config.agents = {
    ...agentsConfig,
    list: nextEntries,
  };

  await seedAgentFilesystem(openclawDir, presetAgents);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, serialized, 'utf8');
  await writeFile(lastGoodPath, serialized, 'utf8');
  return {
    configPath,
    lastGoodPath,
    presetAgentIds: presetAgents.map((preset) => preset.id),
  };
}

export async function preparePortableOutput(options = {}) {
  const {
    sourceDir = resolveDefaultSourceDir(),
    desiredTargetDir = resolveDefaultFinalTarget(sourceDir),
    projectRootDir = projectRoot,
  } = options;

  const targetDir = await finalizeTargetDir(sourceDir, desiredTargetDir);
  const dataDir = path.join(targetDir, 'data');
  const portableFlagPath = path.join(targetDir, 'portable.flag');

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    portableFlagPath,
    'Portable mode enabled. This file keeps U-ClawX data isolated to the app directory.\n',
    'utf8',
  );
  const copiedRootFiles = await copyPortableRootFiles(targetDir, { projectRootDir });
  const cloudEndpointConfigPath = await copyPortableCloudEndpointConfig(targetDir, { projectRootDir });
  await seedPortablePresetAgents(targetDir);
  const { organizedFiles, thirdPartyLicensesDir } = await organizePortableLicenseFiles(targetDir);
  const resetScriptPath = await writePortableResetScript(targetDir);

  return {
    copiedRootFiles,
    cloudEndpointConfigPath,
    dataDir,
    organizedLicenseFiles: organizedFiles,
    portableFlagPath,
    resetScriptPath,
    thirdPartyLicensesDir,
    targetDir,
  };
}
