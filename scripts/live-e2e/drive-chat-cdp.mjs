/**
 * 最后一环：钱包配好之后，真的发一条消息，看模型答不答、余额扣不扣。
 * 前提：应用已经在跑，且 9222 上开着 remote debugging（先跑 drive-wallet-cdp.mjs）。
 *
 * 用法：node drive-chat-cdp.mjs [key]
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 9222;
const key = process.argv[2] ?? '';

const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
const { webSocketDebuggerUrl } = await res.json();
const browser = await chromium.connectOverCDP(webSocketDebuggerUrl);

let page = null;
for (const context of browser.contexts()) {
  for (const p of context.pages()) {
    if (p.url().startsWith('devtools://')) continue;
    if ((await p.locator('[data-testid="sidebar-nav-models"]').count().catch(() => 0)) > 0) page = p;
  }
}
if (!page) {
  console.error('[chat] ❌ 没找到主界面，先跑 drive-wallet-cdp.mjs');
  process.exit(1);
}

/** 直接问服务端要余额 —— 界面数字可能是缓存，判据要取自账本。 */
async function ledgerBalance() {
  if (!key) return null;
  try {
    const r = await fetch('https://api.u-claw.org/api/usage/token/', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const j = await r.json();
    return j?.data?.total_available ?? null;
  } catch {
    return null;
  }
}

const before = await ledgerBalance();
console.log('[chat] 发消息前账本余额:', before);

// 聊天是默认页，侧边栏没有 nav-chat，只有「新建对话」。
const newChat = page.getByTestId('sidebar-new-chat');
if ((await newChat.count()) > 0) await newChat.click().catch(() => {});
await sleep(3000);
const input = page.getByTestId('chat-composer-input');
await input.waitFor({ state: 'visible', timeout: 60_000 });
console.log('[chat] 聊天页就绪');

await input.fill('用一句话回答：1+1 等于几？');
await page.getByTestId('chat-composer-send').click();
console.log('[chat] 已发送，等回复…');

// 等到页面上出现「1+1」之外的新文本，或最多 3 分钟。
let replied = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(3000);
  const body = await page.getByTestId('chat-page').innerText().catch(() => '');
  if (/\b2\b|二/.test(body.replace('1+1', ''))) { replied = true; break; }
}
console.log(replied ? '[chat] ✅ 收到了模型回复' : '[chat] ⚠️ 3 分钟内没等到可识别的回复');

await sleep(8000);
const after = await ledgerBalance();
console.log('[chat] 发消息后账本余额:', after);
if (before != null && after != null) {
  const spent = before - after;
  console.log(spent > 0 ? `[chat] ✅ 确实扣费了：${spent} 虾粮` : '[chat] ⚠️ 余额没变，可能没走云端模型');
}

await browser.close().catch(() => {});
process.exit(replied ? 0 : 3);
