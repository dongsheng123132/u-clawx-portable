import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 启动反馈三件套的接线断言（源码级，同 portable-paths.test.ts 的思路）。
 *
 * pc-8308 工单教训：双击后 ~20 秒无任何可见反馈 → 用户以为坏了反复连点。
 * 这三个机制都是「体验层旁路」，删掉不影响功能正确性——所以恰恰最容易在
 * 重构中被无声移除。这里锁住接线点：拆掉任何一个，测试红。
 */

const repoRoot = join(__dirname, '..', '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('启动首屏（splash）', () => {
  const main = stripComments(read('electron', 'main', 'index.ts'));

  it('whenReady 里最先创建首屏，早于 initialize()', () => {
    const splashAt = main.indexOf('showSplashWindow()');
    expect(splashAt).toBeGreaterThan(-1);
    const initAt = main.indexOf('await initialize()');
    expect(initAt).toBeGreaterThan(-1);
    expect(splashAt).toBeLessThan(initAt);
  });

  it('主窗显示后关闭首屏', () => {
    expect(main).toContain('closeSplashWindow();');
    const showAt = main.indexOf('win.show();');
    const closeAt = main.indexOf('closeSplashWindow();', showAt);
    expect(showAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(showAt);
  });

  it('E2E 模式不启用首屏（splash-window.ts 内部守卫）', () => {
    const splash = stripComments(read('electron', 'utils', 'splash-window.ts'));
    expect(splash).toContain('isPortableMode()');
  });
});

describe('网关模型预热线程', () => {
  const main = stripComments(read('electron', 'main', 'index.ts'));

  it('status=running 时触发且不阻塞事件流', () => {
    const at = main.indexOf("status.state === 'running'");
    expect(at).toBeGreaterThan(-1);
    const callAt = main.indexOf('prewarmGatewayModels(gatewayManager);');
    expect(callAt).toBeGreaterThan(at);
  });

  it('prewarm 实现是 fire-and-forget（内部 void 包裹，失败静默）', () => {
    const src = read('electron', 'utils', 'prewarm.ts');
    expect(src).toContain('void (async () => {');
    expect(src).toMatch(/catch[\s\S]*logger\.debug/);
  });
});
