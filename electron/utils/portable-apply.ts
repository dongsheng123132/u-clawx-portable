import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface PortableFileMapping {
  /** Path of the downloaded file relative to stagingDir */
  stagingRelPath: string;
  /** Destination path relative to appRoot */
  targetRelPath: string;
  /** Expected sha256 after copy, required for atomic U-ClawX commit files */
  expectedSha256?: string | null;
}

export interface PortableApplyOptions {
  appRoot: string;
  stagingDir: string;
  executableName: string;
  processId: number;
  stateFilePath: string;
  /** Per-file copy mappings for U-ClawX files (staging -> appRoot) */
  fileMappings: PortableFileMapping[];
  /** Absolute path of the prepared OpenClaw directory, or null */
  preparedOpenClawDir: string | null;
  /** Absolute path of the live OpenClaw directory, or null */
  openClawDir: string | null;
  /** Absolute path of the rollback OpenClaw directory, or null */
  openClawPrevDir: string | null;
}

function escapeBatchValue(value: string): string {
  return value.replace(/%/g, '%%').replace(/"/g, '""');
}

function escapeVbsValue(value: string): string {
  return value.replace(/"/g, '""');
}

function getPortableUpdateLauncherPath(scriptPath: string): string {
  return join(dirname(scriptPath), 'apply-portable-update.vbs');
}

function getPortableUpdateWorkerPath(scriptPath: string): string {
  return join(dirname(scriptPath), 'apply-portable-update.ps1');
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function toPowerShellNullableString(value: string | null | undefined): string {
  return value ? `'${escapePowerShellSingleQuoted(value)}'` : '$null';
}

export async function generatePortableUpdateScript(options: PortableApplyOptions): Promise<string> {
  const scriptDir = dirname(options.stagingDir);
  const scriptPath = join(scriptDir, 'apply-portable-update.bat');
  const workerPath = getPortableUpdateWorkerPath(scriptPath);

  await mkdir(scriptDir, { recursive: true });

  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${escapeBatchValue(workerPath)}"`,
  ];

  const psLines = [
    "$ErrorActionPreference = 'Stop'",
    `$appRoot = '${escapePowerShellSingleQuoted(options.appRoot)}'`,
    `$stagingDir = '${escapePowerShellSingleQuoted(options.stagingDir)}'`,
    `$appExe = '${escapePowerShellSingleQuoted(options.executableName)}'`,
    '$appProcessName = [IO.Path]::GetFileNameWithoutExtension($appExe)',
    '$appExePath = Join-Path $appRoot $appExe',
    '$appAsarPath = Join-Path $appRoot "resources\\app.asar"',
    '$backupRoot = Join-Path $stagingDir "backups"',
    `$appPid = ${options.processId}`,
    `$stateFile = '${escapePowerShellSingleQuoted(options.stateFilePath)}'`,
    `$preparedOpenClawDir = ${toPowerShellNullableString(options.preparedOpenClawDir)}`,
    `$openClawDir = ${toPowerShellNullableString(options.openClawDir)}`,
    `$openClawPrevDir = ${toPowerShellNullableString(options.openClawPrevDir)}`,
    '$fileMappings = @(',
    ...options.fileMappings.map((mapping) => (
      `  @{ Source = Join-Path $stagingDir '${escapePowerShellSingleQuoted(mapping.stagingRelPath.replace(/\//g, '\\'))}'; Target = Join-Path $appRoot '${escapePowerShellSingleQuoted(mapping.targetRelPath.replace(/\//g, '\\'))}'; ExpectedSha256 = ${toPowerShellNullableString(mapping.expectedSha256)} }`
    )),
    ')',
    '',
    'function Write-State([string]$phase, [bool]$hasCommittedSwitch = $false, [string]$error = $null, [bool]$clawxCommitted = $false, [bool]$openClawCommitted = $false) {',
    '  if (-not (Test-Path -LiteralPath $stateFile)) { return }',
    '  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json',
    '  $state.phase = $phase',
    '  $state.hasCommittedSwitch = $hasCommittedSwitch',
    '  $state.updatedAt = [DateTime]::UtcNow.ToString("o")',
    '  $state.error = $error',
    '  if ($null -eq $state.committed) { $state | Add-Member -NotePropertyName committed -NotePropertyValue ([pscustomobject]@{}) -Force }',
    '  $state.committed.clawx = $clawxCommitted',
    '  $state.committed.openclaw = $openClawCommitted',
    '  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $stateFile -Encoding UTF8',
    '}',
    '',
    'function Set-BackupPath([string]$name, [string]$path) {',
    '  if (-not (Test-Path -LiteralPath $stateFile)) { return }',
    '  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json',
    '  if ($null -eq $state.backups) { $state | Add-Member -NotePropertyName backups -NotePropertyValue ([pscustomobject]@{}) -Force }',
    '  $state.backups.$name = $path',
    '  $state.updatedAt = [DateTime]::UtcNow.ToString("o")',
    '  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $stateFile -Encoding UTF8',
    '}',
    '',
    'function Test-CancelRequested() {',
    '  if (-not (Test-Path -LiteralPath $stateFile)) { return $false }',
    '  try {',
    '    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json',
    '    return $state.cancelRequested -eq $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    '',
    'function Get-AppProcesses() {',
    '  return @(Get-Process -Name $appProcessName -ErrorAction SilentlyContinue | Where-Object {',
    '    try {',
    '      return $_.Path -eq $appExePath',
    '    } catch {',
    '      return $true',
    '    }',
    '  })',
    '}',
    '',
    'function Stop-AppProcessesForCommit() {',
    '  $attempts = 20',
    '  while ($attempts -gt 0) {',
    '    $targets = Get-AppProcesses',
    '    if ($targets.Count -eq 0) { return }',
    '    foreach ($target in $targets) {',
    '      try { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue } catch { }',
    '    }',
    '    Start-Sleep -Milliseconds 500',
    '    $attempts -= 1',
    '  }',
    '  $remaining = Get-AppProcesses',
    '  if ($remaining.Count -gt 0) {',
    '    throw "Timed out waiting for installer process to release app executable"',
    '  }',
    '}',
    '',
    'function Ensure-ParentDir([string]$path) {',
    '  $targetDir = Split-Path -Parent $path',
    '  if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }',
    '}',
    '',
    'function Copy-WithParents([string]$source, [string]$target) {',
    '  Ensure-ParentDir $target',
    '  Copy-Item -LiteralPath $source -Destination $target -Force',
    '}',
    '',
    'function Backup-LiveFile([hashtable]$mapping) {',
    '  $relativeTarget = $mapping.Target.Substring($appRoot.Length).TrimStart("\\")',
    '  $backupPath = Join-Path $backupRoot $relativeTarget',
    '  if (Test-Path -LiteralPath $mapping.Target) {',
    '    Copy-WithParents $mapping.Target $backupPath',
    '  }',
    '  if ($mapping.Target -eq $appExePath) { Set-BackupPath "clawxExe" $backupPath }',
    '  if ($mapping.Target -eq $appAsarPath) { Set-BackupPath "clawxAsar" $backupPath }',
    '}',
    '',
    'function Get-Sha256([string]$path) {',
    '  # Use the .NET API directly: Get-FileHash depends on PowerShell module',
    '  # auto-loading, which is broken on machines with a polluted PSModulePath.',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  try {',
    '    $stream = [System.IO.File]::OpenRead($path)',
    '    try { $hashBytes = $sha.ComputeHash($stream) } finally { $stream.Dispose() }',
    '  } finally { $sha.Dispose() }',
    "  return ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()",
    '}',
    '',
    'function Verify-CommitMapping([hashtable]$mapping) {',
    '  if (-not (Test-Path -LiteralPath $mapping.Target)) {',
    '    throw "Committed file missing after copy: $($mapping.Target)"',
    '  }',
    '  if (-not $mapping.ExpectedSha256) {',
    '    throw "Missing expected sha256 for committed file: $($mapping.Target)"',
    '  }',
    '  $actualHash = Get-Sha256 $mapping.Target',
    '  if ($actualHash -ne $mapping.ExpectedSha256.ToLowerInvariant()) {',
    '    throw "Checksum mismatch for committed file: $($mapping.Target)"',
    '  }',
    '}',
    '',
    'function Restore-CommitBackups($mappings) {',
    '  foreach ($mapping in $mappings) {',
    '    $relativeTarget = $mapping.Target.Substring($appRoot.Length).TrimStart("\\")',
    '    $backupPath = Join-Path $backupRoot $relativeTarget',
    '    if (Test-Path -LiteralPath $backupPath) {',
    '      Copy-WithParents $backupPath $mapping.Target',
    '    }',
    '  }',
    '}',
    '',
    'function Test-OpenClawRuntimeDir([string]$rootDir) {',
    '  if (-not $rootDir -or -not (Test-Path -LiteralPath $rootDir)) { return $false }',
    '  $packageJsonPath = Join-Path $rootDir "package.json"',
    '  $entryPath = Join-Path $rootDir "openclaw.mjs"',
    '  if (-not (Test-Path -LiteralPath $packageJsonPath) -or -not (Test-Path -LiteralPath $entryPath)) { return $false }',
    '  try {',
    '    $pkg = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json',
    '  } catch {',
    '    return $false',
    '  }',
    '  $deps = $pkg.dependencies',
    '  if ($null -eq $deps) { return $true }',
    '  foreach ($dep in $deps.PSObject.Properties.Name) {',
    '    $parts = $dep -split "/"',
    '    $depPackageJson = Join-Path $rootDir "node_modules"',
    '    foreach ($part in $parts) {',
    '      $depPackageJson = Join-Path $depPackageJson $part',
    '    }',
    '    $depPackageJson = Join-Path $depPackageJson "package.json"',
    '    if (-not (Test-Path -LiteralPath $depPackageJson)) {',
    '      throw "OpenClaw dependency missing after switch: $dep"',
    '    }',
    '  }',
    '  return $true',
    '}',
    '',
    'try {',
    '  $waitAttempts = 15',
    '  $forceKilled = $false',
    '  $commitMappings = @()',
    '  $regularMappings = @()',
    '  $openClawSwitched = $false',
    '  Write-State "waiting-for-exit"',
    '  while ($true) {',
    '    $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue',
    '    if ($null -eq $proc) { break }',
    '    if ($waitAttempts -gt 0) { Start-Sleep -Seconds 1; $waitAttempts -= 1; continue }',
    '    if (-not $forceKilled) { Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue; $forceKilled = $true; Start-Sleep -Seconds 1; continue }',
    '    throw "Timed out waiting for app process to exit"',
    '  }',
    '  if (Test-CancelRequested) { Write-State "cancelled"; Start-Process -FilePath $appExePath -WorkingDirectory $appRoot; exit 0 }',
    '',
    '  Write-State "applying-clawx-files"',
    '  foreach ($mapping in $fileMappings) {',
    '    if ($mapping.Target -eq $appExePath -or $mapping.Target -eq $appAsarPath) {',
    '      $commitMappings += $mapping',
    '    } else {',
    '      $regularMappings += $mapping',
    '    }',
    '  }',
    '  foreach ($mapping in $regularMappings) {',
    '    if (Test-CancelRequested) { Write-State "cancelled"; Start-Process -FilePath $appExePath -WorkingDirectory $appRoot; exit 0 }',
    '    if (Test-Path -LiteralPath $mapping.Source) {',
    '      Copy-WithParents $mapping.Source $mapping.Target',
    '    }',
    '  }',
    '  if ($commitMappings.Count -gt 0) {',
    '    Write-State "switching-version"',
    '    Stop-AppProcessesForCommit',
    '    foreach ($mapping in $commitMappings) {',
    '      Backup-LiveFile $mapping',
    '    }',
    '    Write-State "clawx-backed-up" $false $null $false $false',
    '    foreach ($mapping in $commitMappings) {',
    '      if (Test-Path -LiteralPath $mapping.Source) {',
    '        Copy-WithParents $mapping.Source $mapping.Target',
    '      }',
    '    }',
    '    Write-State "clawx-switched" $false $null $false $false',
    '    foreach ($mapping in $commitMappings) {',
    '      Verify-CommitMapping $mapping',
    '    }',
    '    Write-State "clawx-verified" $true $null $true $false',
    '  }',
    '',
    '  if ($preparedOpenClawDir -and (Test-Path -LiteralPath $preparedOpenClawDir)) {',
    '    if (Test-CancelRequested) { Write-State "cancelled" $false $null $($commitMappings.Count -gt 0) $false; Start-Process -FilePath $appExePath -WorkingDirectory $appRoot; exit 0 }',
    '    Write-State "switching-version" $true $null $($commitMappings.Count -gt 0) $false',
    '    if ($openClawPrevDir -and (Test-Path -LiteralPath $openClawPrevDir)) { Remove-Item -LiteralPath $openClawPrevDir -Recurse -Force -ErrorAction SilentlyContinue }',
    '    if ($openClawDir -and (Test-Path -LiteralPath $openClawDir)) { Rename-Item -LiteralPath $openClawDir -NewName ([IO.Path]::GetFileName($openClawPrevDir)) }',
    '    Move-Item -LiteralPath $preparedOpenClawDir -Destination $openClawDir',
    '    $openClawSwitched = $true',
    '    if (-not (Test-OpenClawRuntimeDir $openClawDir)) {',
    '      throw "Prepared OpenClaw directory failed runtime verification after switch"',
    '    }',
    '    Write-State "openclaw-switched" $true $null $($commitMappings.Count -gt 0) $true',
    '  }',
    '',
    '  Write-State "cleanup" $true $null $($commitMappings.Count -gt 0) $($preparedOpenClawDir -and -not (Test-Path -LiteralPath $preparedOpenClawDir))',
    '  if ($openClawPrevDir -and (Test-Path -LiteralPath $openClawPrevDir)) { Remove-Item -LiteralPath $openClawPrevDir -Recurse -Force -ErrorAction SilentlyContinue }',
    '  Write-State "relaunching" $true $null $($commitMappings.Count -gt 0) $($preparedOpenClawDir -and -not (Test-Path -LiteralPath $preparedOpenClawDir))',
    '  Start-Process -FilePath $appExePath -WorkingDirectory $appRoot',
    '  Write-State "completed" $true $null $($commitMappings.Count -gt 0) $($preparedOpenClawDir -and -not (Test-Path -LiteralPath $preparedOpenClawDir))',
    '} catch {',
    '  $message = $_.Exception.Message',
    '  try {',
    '    if ($openClawSwitched -and $openClawPrevDir -and (Test-Path -LiteralPath $openClawPrevDir)) {',
    '      if ($openClawDir -and (Test-Path -LiteralPath $openClawDir)) {',
    '        Remove-Item -LiteralPath $openClawDir -Recurse -Force -ErrorAction SilentlyContinue',
    '      }',
    '      Rename-Item -LiteralPath $openClawPrevDir -NewName ([IO.Path]::GetFileName($openClawDir))',
    '    }',
    '    if ($commitMappings.Count -gt 0) {',
    '      Restore-CommitBackups $commitMappings',
    '    }',
    '    if ((-not $openClawSwitched) -and $openClawPrevDir -and (Test-Path -LiteralPath $openClawPrevDir) -and (-not (Test-Path -LiteralPath $openClawDir))) {',
    '      Rename-Item -LiteralPath $openClawPrevDir -NewName ([IO.Path]::GetFileName($openClawDir))',
    '    }',
    '  } catch { }',
    '  Write-State "failed" $false $message $false $false',
    '  Start-Process -FilePath $appExePath -WorkingDirectory $appRoot',
    '} finally {',
    `  Remove-Item -LiteralPath '${escapePowerShellSingleQuoted(workerPath)}' -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath '${escapePowerShellSingleQuoted(getPortableUpdateLauncherPath(scriptPath))}' -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath '${escapePowerShellSingleQuoted(scriptPath)}' -Force -ErrorAction SilentlyContinue`,
    '}',
  ];

  await writeFile(scriptPath, lines.join('\r\n'), 'utf8');
  await writeFile(workerPath, psLines.join('\r\n'), 'utf8');
  return scriptPath;
}

export async function spawnPortableUpdateScript(scriptPath: string): Promise<void> {
  const launcherPath = getPortableUpdateLauncherPath(scriptPath);
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const cmdPath = join(systemRoot, 'System32', 'cmd.exe');
  const wscriptPath = join(systemRoot, 'System32', 'wscript.exe');
  const launcherCommand = `"${cmdPath}" /d /c ""${scriptPath}""`;

  await writeFile(
    launcherPath,
    [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run "${escapeVbsValue(launcherCommand)}", 0, False`,
    ].join('\r\n'),
    'utf8',
  );

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(wscriptPath, ['//B', '//Nologo', launcherPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}
