#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  preparePortableOutput,
  resolveDefaultFinalTarget,
  resolveDefaultSourceDir,
  resolvePathArgument,
} from './prepare-win-portable-lib.mjs';

async function main() {
  const sourceDir = process.argv[2]
    ? resolvePathArgument(process.argv[2])
    : resolveDefaultSourceDir();
  const desiredTargetDir = process.argv[3]
    ? resolvePathArgument(process.argv[3])
    : resolveDefaultFinalTarget(sourceDir);
  const result = await preparePortableOutput({ sourceDir, desiredTargetDir });

  console.log(`[portable] prepared ${result.targetDir}`);
  console.log(`[portable] ensured ${result.dataDir}`);
  console.log(`[portable] wrote ${result.portableFlagPath}`);
  console.log(`[portable] wrote ${result.resetScriptPath}`);
  for (const copiedFile of result.copiedRootFiles) {
    console.log(`[portable] copied ${copiedFile}`);
  }
  if (result.thirdPartyLicensesDir) {
    console.log(`[portable] organized licenses into ${result.thirdPartyLicensesDir}`);
  }
  for (const movedFile of result.organizedLicenseFiles) {
    console.log(`[portable] moved ${movedFile}`);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error('[portable] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
