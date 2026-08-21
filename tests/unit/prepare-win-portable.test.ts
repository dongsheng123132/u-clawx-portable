import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { preparePortableOutput } from '../../scripts/prepare-win-portable-lib.mjs';

const tempDirs: string[] = [];

function visibleResetScriptLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^echo(?:\.|\s|$)/i.test(line));
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('prepare-win-portable script', () => {
  it('creates portable markers and reset helper without preserving activation files', async () => {
    const projectRootDir = await createTempDir('portable-project-');
    const sourceDir = await createTempDir('portable-source-');
    const licenseContent = 'Custom portable license text\n';
    const electronLicenseContent = 'Electron license text\n';
    const chromiumLicenseContent = '<html>Chromium licenses</html>\n';

    await mkdir(join(sourceDir, 'resources'), { recursive: true });
    await mkdir(join(projectRootDir, 'electron', 'shared', 'providers'), { recursive: true });
    await writeFile(join(sourceDir, 'U-Claw.exe'), '');
    await writeFile(join(projectRootDir, 'license.clawx.txt'), licenseContent, 'utf8');
    await writeFile(
      join(projectRootDir, 'electron', 'shared', 'providers', 'uclaw-cloud-endpoints.json'),
      '{"version":1,"endpoints":[]}',
      'utf8',
    );
    await writeFile(join(sourceDir, 'LICENSE.electron.txt'), electronLicenseContent, 'utf8');
    await writeFile(join(sourceDir, 'LICENSES.chromium.html'), chromiumLicenseContent, 'utf8');

    const result = await preparePortableOutput({
      sourceDir,
      desiredTargetDir: sourceDir,
      projectRootDir,
    });

    expect(result.targetDir).toBe(sourceDir);
    expect(result.thirdPartyLicensesDir).toBe(join(sourceDir, 'third-party-licenses'));
    expect(result.resetScriptPath).toBe(join(sourceDir, '一键重置.bat'));
    await expect(readFile(join(sourceDir, 'third-party-licenses', 'license.clawx.txt'), 'utf8')).resolves.toBe(licenseContent);
    await expect(readFile(join(sourceDir, 'third-party-licenses', 'LICENSE.electron.txt'), 'utf8')).resolves.toBe(electronLicenseContent);
    await expect(readFile(join(sourceDir, 'third-party-licenses', 'LICENSES.chromium.html'), 'utf8')).resolves.toBe(chromiumLicenseContent);
    await expect(readFile(join(sourceDir, 'portable.flag'), 'utf8')).resolves.toContain('Portable mode enabled.');
    await expect(readFile(join(sourceDir, 'uclaw-cloud-endpoints.json'), 'utf8')).resolves.toContain('"version":1');
    const resetScript = await readFile(result.resetScriptPath, 'utf8');
    expect(resetScript).toContain('Press any key to continue, or close this window to cancel.');
    expect(resetScript).toContain('taskkill /F /T /IM "U-Claw.exe"');
    expect(resetScript).toContain('set "CHROMIUM_CACHE_DIR=%LOCALAPPDATA%\\U-Claw\\portable-chromium-session"');
    expect(resetScript).toContain('rmdir /S /Q "%CHROMIUM_CACHE_DIR%"');
    expect(resetScript).not.toContain('%ERRORLEVEL%');
    expect(resetScript).toContain('if not errorlevel 1 (');
    expect(resetScript).not.toContain('Please close U-Claw before resetting');
    const visibleLines = visibleResetScriptLines(resetScript).join('\n');
    expect(visibleLines).not.toContain('%APP_ROOT%');
    expect(visibleLines).not.toContain('%CHROMIUM_CACHE_DIR%');
    expect(visibleLines).not.toContain('%LOCALAPPDATA%');
    expect(visibleLines).not.toContain('portable-chromium-session');
    expect(resetScript).toContain(
      [
        'echo [reset] Cleanup completed successfully.',
        'echo [reset] This window will close automatically in 3 seconds.',
        'timeout /T 3 /NOBREAK >nul',
        'exit /b 0',
        '',
        ':waitForUClawExit',
      ].join('\r\n'),
    );
    expect(resetScript).not.toContain('echo [reset] Portable environment was reset successfully.\r\npause\r\nexit /b 0');
    await expect(readFile(result.resetScriptPath, 'utf8')).resolves.not.toContain('.license');
    await expect(access(join(sourceDir, '添加Defender排除项.bat'))).rejects.toThrow();
    await expect(access(join(sourceDir, 'license.clawx.txt'))).rejects.toThrow();
    await expect(access(join(sourceDir, 'LICENSE.electron.txt'))).rejects.toThrow();
    await expect(access(join(sourceDir, 'LICENSES.chromium.html'))).rejects.toThrow();
  });

  it('seeds packaged portable data with built-in preset agents', async () => {
    const projectRootDir = process.cwd();
    const sourceDir = await createTempDir('portable-source-presets-');

    await writeFile(join(sourceDir, 'U-Claw.exe'), '');

    await preparePortableOutput({
      sourceDir,
      desiredTargetDir: sourceDir,
      projectRootDir,
    });

    const openclawDir = join(sourceDir, 'data', '.openclaw');
    const config = JSON.parse(await readFile(join(openclawDir, 'openclaw.json'), 'utf8')) as {
      agents?: {
        list?: Array<{
          id: string;
          name?: string;
          icon?: string;
          category?: string;
          categoryLabel?: string;
          source?: string;
          presetId?: string;
          workspace?: string;
          agentDir?: string;
          skillIds?: string[];
        }>;
      };
    };

    expect(config.agents?.list?.map((agent) => agent.id)).toEqual([
      'main',
      'stockexpert',
      'expense-tracker',
      'content-writer',
      'content-summarizer',
      'video-scripter',
      'brand-designer',
      'lesson-planner',
      'journal-prompter',
      'daily-planner',
      'travel-planner',
      'health-interpreter',
      'fitness-coach',
      'meal-planner',
      'wellness-coach',
      'medication-checker',
      'contract-reviewer',
      'pet-care',
    ]);
    expect(config.agents?.list?.find((agent) => agent.id === 'stockexpert')).toMatchObject({
      name: '股市研判师',
      workspace: '~/.openclaw/workspace-stockexpert',
      agentDir: '~/.openclaw/agents/stockexpert/agent',
    });
    const stockexpert = config.agents?.list?.find((agent) => agent.id === 'stockexpert');
    expect(stockexpert).not.toHaveProperty('icon');
    expect(stockexpert).not.toHaveProperty('category');
    expect(stockexpert).not.toHaveProperty('categoryLabel');
    expect(stockexpert).not.toHaveProperty('source');
    expect(stockexpert).not.toHaveProperty('presetId');
    expect(stockexpert).not.toHaveProperty('skillIds');

    await expect(readFile(join(openclawDir, 'workspace-stockexpert', 'SOUL.md'), 'utf8')).resolves.toContain('股市研判师');
    await expect(readFile(join(openclawDir, 'workspace-stockexpert', 'IDENTITY.md'), 'utf8')).resolves.toContain('# 股市研判师');
    await expect(readFile(join(openclawDir, 'workspace-stockexpert', 'TOOLS.md'), 'utf8')).resolves.toContain('stock-analyzer');
    await expect(readFile(join(openclawDir, 'workspace-medication-checker', 'SOUL.md'), 'utf8')).resolves.toContain('用药核对师');
    await expect(readFile(join(openclawDir, 'workspace-contract-reviewer', 'IDENTITY.md'), 'utf8')).resolves.toContain('法律合约');
    await expect(access(join(openclawDir, 'agents', 'stockexpert', 'agent'))).resolves.toBeUndefined();
    await expect(access(join(openclawDir, 'agents', 'contract-reviewer', 'sessions'))).resolves.toBeUndefined();
    await expect(access(join(openclawDir, 'agents', 'stockexpert', 'sessions'))).resolves.toBeUndefined();
    await expect(readFile(join(openclawDir, 'openclaw.json.last-good'), 'utf8')).resolves.toContain('stockexpert');
  });

  it('adds portable packaging scripts without updater publishing commands', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };

    expect(pkg.scripts['prep:win-binaries']).toContain('uv:download:win');
    expect(pkg.scripts['prep:win-binaries']).toContain('node:download:win');
    expect(pkg.scripts['uv:download:win']).toBeTruthy();
    expect(pkg.scripts['node:download:win']).toBeTruthy();
    expect(pkg.scripts['package:win:portable']).toContain('prepare-win-portable.mjs');
    expect(pkg.scripts['package:win:portable']).toContain('release/portable-staging');
    expect(pkg.scripts['package:win:portable']).toContain('patch-win-exe-icon.mjs release/portable-staging/win-unpacked');
    expect(pkg.scripts['package:win:portable']).toContain('prepare-win-portable.mjs release/portable-staging/win-unpacked release/win-unpacked');
    expect(pkg.scripts['generate-portable-manifest']).toBeUndefined();
    expect(pkg.scripts['package:win:portable:latest']).toBeUndefined();
    expect(pkg.scripts['publish:portable:oss']).toBeUndefined();
  });

  it('fails when the required ClawX license file is missing', async () => {
    const projectRootDir = await createTempDir('portable-project-no-license-');
    const sourceDir = await createTempDir('portable-source-no-license-');

    await writeFile(join(sourceDir, 'U-Claw.exe'), '');

    await expect(
      preparePortableOutput({
        sourceDir,
        desiredTargetDir: sourceDir,
        projectRootDir,
      }),
    ).rejects.toThrow('Required portable root file not found');
  });
});
