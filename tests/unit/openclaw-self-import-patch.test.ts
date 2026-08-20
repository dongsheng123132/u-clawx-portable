// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  patchExtensionOpenClawSelfImports,
  rewriteOpenClawPluginSdkSpecifiers,
  toImportSpecifier,
} from '../../scripts/openclaw-self-import-patch.mjs';

const tempRoots: string[] = [];

async function createTempOpenClawBundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'clawx-openclaw-self-import-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('openclaw self-import bundle patch', () => {
  it('converts OpenClaw plugin-sdk package specifiers to bundled relative paths', async () => {
    const root = await createTempOpenClawBundle();
    const distDir = path.join(root, 'dist');
    const pluginSdkDir = path.join(distDir, 'plugin-sdk');
    const extensionDir = path.join(distDir, 'extensions', 'codex');
    await mkdir(pluginSdkDir, { recursive: true });
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(pluginSdkDir, 'provider-model-shared.js'), 'export const ok = true;\n');

    const promptOverlayPath = path.join(extensionDir, 'prompt-overlay.js');
    await writeFile(
      promptOverlayPath,
      [
        'import { ok } from "openclaw/plugin-sdk/provider-model-shared";',
        "export { ok };",
        '',
      ].join('\n'),
    );

    const result = patchExtensionOpenClawSelfImports(root);

    expect(result).toMatchObject({
      filesPatched: 1,
      specifiersPatched: 1,
    });
    await expect(readFile(promptOverlayPath, 'utf8')).resolves.toContain(
      'from "../../plugin-sdk/provider-model-shared.js"',
    );
  });

  it('leaves extension files without OpenClaw self-imports untouched', async () => {
    const root = await createTempOpenClawBundle();
    const extensionDir = path.join(root, 'dist', 'extensions', 'telegram');
    await mkdir(extensionDir, { recursive: true });

    const filePath = path.join(extensionDir, 'runtime.js');
    const source = 'export const runtime = true;\n';
    await writeFile(filePath, source);

    const result = patchExtensionOpenClawSelfImports(root);

    expect(result.filesScanned).toBe(1);
    expect(result.filesPatched).toBe(0);
    expect(result.specifiersPatched).toBe(0);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(source);
  });

  it('throws when the bundled plugin-sdk target is missing', () => {
    const root = path.join(tmpdir(), 'missing-target-openclaw-bundle');
    const distDir = path.join(root, 'dist');
    const filePath = path.join(distDir, 'extensions', 'codex', 'prompt-overlay.js');

    expect(() => rewriteOpenClawPluginSdkSpecifiers(
      'import "openclaw/plugin-sdk/provider-model-shared";',
      { filePath, distDir },
    )).toThrow(/missing bundled SDK target/);
  });

  it('formats same-directory import paths with an explicit relative prefix', () => {
    expect(toImportSpecifier('provider-model-shared.js')).toBe('./provider-model-shared.js');
    expect(toImportSpecifier('../plugin-sdk/provider-model-shared.js')).toBe(
      '../plugin-sdk/provider-model-shared.js',
    );
  });

  it('returns an empty patch summary when the extensions directory is absent', async () => {
    const root = await createTempOpenClawBundle();
    await mkdir(path.join(root, 'dist', 'plugin-sdk'), { recursive: true });

    const result = patchExtensionOpenClawSelfImports(root);

    expect(existsSync(path.join(root, 'dist', 'extensions'))).toBe(false);
    expect(result).toEqual({
      filesScanned: 0,
      filesPatched: 0,
      specifiersPatched: 0,
    });
  });
});
