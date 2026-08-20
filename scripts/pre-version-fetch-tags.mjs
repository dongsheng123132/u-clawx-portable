#!/usr/bin/env node
/**
 * npm/pnpm `preversion`: fetch tags from origin so local state matches remote
 * before SemVer bump + assert-release-version remote checks.
 */
import { execFileSync } from 'node:child_process';

const skip = process.env.SKIP_RELEASE_FETCH === '1';
if (skip) {
  console.log('[pre-version-fetch-tags] Skip: SKIP_RELEASE_FETCH=1');
  process.exit(0);
}

try {
  execFileSync('git', ['fetch', 'origin', '--tags', '--prune'], {
    stdio: 'inherit',
  });
} catch {
  console.error(`
[pre-version-fetch-tags] git fetch origin --tags failed.

Fix your network/remotes, or retry. To bypass (not recommended), run with
SKIP_RELEASE_FETCH=1 — assert-release-version may still block on remote tags
unless SKIP_RELEASE_REMOTE_CHECK=1.
`);
  process.exit(1);
}
