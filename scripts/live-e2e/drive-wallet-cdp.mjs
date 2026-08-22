/**
 * 真机端到端：驱动 U 盘上打包好的 ClawX，走一遍设备钱包。
 *
 * 用法：node drive-wallet-cdp.mjs <U盘应用目录> <要填入的key>
 * 依赖仓库里的 playwright-core（用 connectOverCDP 附加到已启动的 Electron 渲染进程）。
 *
 * 不截图 —— 截图进上下文很贵，而且判据本来就是 DOM 文本，不是像素。
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const appDir = process.argv[2];
const keyToAdopt = process.argv[3];
if (!appDir || !keyToAdopt) {
  console.error('用法: node drive-wallet-cdp.mjs <U盘应用目录> <key>');
  process.exit(2);
}

const PORT = 9222;
const exe = path.join(appDir, 'U-Claw.exe');

console.log('[e2e] 启动', exe);
// 应用日志走 stdout —— 丢掉它就等于卡死时没有证据可查。
const logPath = process.env.E2E_APP_LOG ?? 'tmp/e2e-app.log';
const logFd = openSync(logPath, 'w');
const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  cwd: appDir,
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
console.log('[e2e] 应用日志 →', logPath);

async function connectWithRetry(deadlineMs) {
  const until = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < until) {
    try {
      // 自己取 ws 端点：connectOverCDP 传 http:// 会请求 `/json/version/`（带尾斜杠），
      // Electron 的 DevTools server 对这个形式回 400。
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const { webSocketDebuggerUrl } = await res.json();
      if (!webSocketDebuggerUrl) throw new Error('没有 webSocketDebuggerUrl');
      return await chromium.connectOverCDP(webSocketDebuggerUrl);
    } catch (error) {
      lastError = error;
      await sleep(3000);
    }
  }
  throw lastError;
}

/** 主窗口可能晚于 CDP 端口出现，而且 splash 也是一个 page。 */
async function findAppPage(browser, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url();
        if (url.startsWith('devtools://')) continue;
        // 首启会落在引导页 —— 客户第一次插盘看到的就是它。跳过它才到主界面。
        const skip = page.locator('[data-testid="setup-skip-button"]');
        if ((await skip.count().catch(() => 0)) > 0) {
          console.log('[e2e] 停在首启引导页 → 点跳过');
          await skip.click().catch(() => {});
          await sleep(4000);
        }
        const hasApp = await page.locator('[data-testid="sidebar-nav-models"]').count().catch(() => 0);
        if (hasApp > 0) return page;
      }
    }
    await sleep(3000);
  }
  return null;
}

const browser = await connectWithRetry(120_000);
console.log('[e2e] CDP 已连接');

const page = await findAppPage(browser, 180_000);
if (!page) {
  console.error('[e2e] ❌ 没找到主界面（可能停在 setup/splash）');
  for (const context of browser.contexts()) {
    for (const p of context.pages()) console.error('    page:', p.url());
  }
  process.exit(1);
}
console.log('[e2e] 主界面就绪:', page.url());

await page.getByTestId('sidebar-nav-models').click();
const panel = page.getByTestId('uclaw-cloud-panel');
await panel.waitFor({ state: 'visible', timeout: 60_000 });
console.log('[e2e] 设备钱包面板已显示');

const text = async (testId) => {
  const el = page.getByTestId(testId);
  return (await el.count()) > 0 ? (await el.innerText()).replace(/\s+/g, ' ').trim() : null;
};

console.log('[e2e] 初始状态:');
console.log('   旧钱包提示 :', await text('uclaw-cloud-legacy-wallet'));
console.log('   无钱包提示 :', await text('uclaw-cloud-no-wallet'));
console.log('   面板摘要   :', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 220));

// 先等面板状态收敛 —— 首启时钱包状态是异步拉的，太早操作会被随后的重渲染盖掉。
console.log('[e2e] 等待钱包状态收敛…');
for (let i = 0; i < 20; i += 1) {
  const settled = (await page.getByTestId('uclaw-cloud-legacy-wallet').count())
    + (await page.getByTestId('uclaw-cloud-no-wallet').count())
    + (await page.getByTestId('uclaw-cloud-copy-api-key').count());
  if (settled > 0 && !/不可用/.test(await panel.innerText())) break;
  await sleep(3000);
}
console.log('[e2e] 收敛后:', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 200));

// 有旧钱包提示就选「创建新钱包」——本机那把旧钱包余额是 0，不该导入。
const legacy = page.getByTestId('uclaw-cloud-create-fresh-wallet');
if ((await legacy.count()) > 0) {
  console.log('[e2e] 发现旧钱包提示 → 点「创建新钱包」');
  await legacy.click();
  // 弹的是 Radix 模态确认框（文案「不导入旧钱包，创建新的？」/「仍然创建」）。
  // 它有稳定的 testid，别按文案猜 —— 猜错的话弹窗一直开着，后面 fill 打不进
  // 输入框，「启用」就因为 adoptValue 为空而永远禁用，看起来像产品卡死。
  const confirmButton = page.getByTestId('confirm-dialog-confirm-button');
  await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
  await confirmButton.click();
  await sleep(12000);
  console.log('[e2e] 新建后:', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 200));
}

console.log('[e2e] 填入已有密钥并启用');
await page.getByTestId('uclaw-cloud-adopt-key-input').fill(keyToAdopt);
// 「启用」是 disabled={busy || 输入为空}。U 盘上前一步（bind/收敛）可能还没完，
// busy 挂着，直接点会超时 —— 等它自己放开。
const adoptButton = page.getByTestId('uclaw-cloud-adopt-key');
for (let i = 0; i < 40; i += 1) {
  if (await adoptButton.isEnabled()) break;
  await sleep(3000);
}
if (!(await adoptButton.isEnabled())) {
  console.error('[e2e] ❌ 「启用」一直是禁用状态，面板:', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(4);
}
await adoptButton.click();
await sleep(10000);

// 顺手把界面上的提示（成功或报错）抓出来 —— 判据不能只看余额数字。
const toasts = await page.locator('[data-sonner-toast], [role="status"], [role="alert"]').allInnerTexts().catch(() => []);
if (toasts.length > 0) console.log('[e2e] 界面提示:', toasts.join(' | ').replace(/\s+/g, ' ').slice(0, 200));

const refresh = page.getByTestId('uclaw-cloud-refresh-balance');
if ((await refresh.count()) > 0) {
  await refresh.click().catch(() => {});
} else {
  await page.getByRole('button', { name: /刷新|Refresh/i }).first().click().catch(() => {});
}
await sleep(8000);

const after = (await panel.innerText()).replace(/\s+/g, ' ');
console.log('[e2e] 启用后面板:', after.slice(0, 400));

const ok = /46\d{4}|4[0-9]{5}/.test(after) || /46\d,\d{3}/.test(after);
console.log(ok ? '[e2e] ✅ 面板出现了预期量级的余额' : '[e2e] ⚠️ 面板里没看到余额数字，需人工确认上面的文本');

await browser.close().catch(() => {});
process.exit(ok ? 0 : 3);
