# 真机端到端（打真网、打真账本）

`tests/e2e/` 里的 Playwright 用例把 IPC mock 掉了 —— 它测的是界面接线，**不能**回答
「这个 U 盘插到客户机上到底能不能用」。这两个脚本补的就是那一段：驱动**打包好的、
U 盘上的**应用，走真实网络和真实计费账本。

发版前至少跑一次。

```bash
# 1. 钱包：首启引导 → 旧钱包决策 → 填入已有密钥 → 余额
node scripts/live-e2e/drive-wallet-cdp.mjs "E:\U-Claw" "sk-你的key"

# 2. 花钱：接着上面那个还开着的应用，发一条消息，比对账本前后余额
node scripts/live-e2e/drive-chat-cdp.mjs "sk-你的key"
```

判据是 DOM 文本和账本数字，**不截图** —— 截图既贵又不是判据。

## 注意

- **密钥从命令行传，别写进文件。** 脚本不落盘、不打印完整 key。
- **跑完必须整盘重铺再出货。** 应用会把生效的 key 写进 `data/.openclaw` 下每个 agent 的
  `auth-profiles.json` 和 sqlite（实测 37 个文件），只删 `data/clawx-state` **清不干净**。
  判据：`grep -rl "sk-" <盘>/U-Claw/data` 必须为空。
- 连的是 Electron 自己的 DevTools 端口（`--remote-debugging-port=9222`）。
  `connectOverCDP` 传 `http://` 会去请求 `/json/version/`（带尾斜杠）而被回 400，
  所以脚本自己取 `webSocketDebuggerUrl` 再连 ws。
- 确认框按 `data-testid`（`confirm-dialog-confirm-button`）点，**别按文案猜**。猜错的话
  Radix 模态一直开着，后续 `fill()` 打不进输入框，「启用」会因为输入为空而永远禁用 ——
  看起来像产品卡死，其实是自动化写错了。这个坑吃过一次。

## 2026-08-22 的一次完整结果（v0.5.4 + exFAT U 盘 + 生产账本）

```
首启引导页 → 跳过
发现旧钱包 sk-495e…（余额 0）→ 创建新钱包 → 确认「仍然创建」
新钱包绑定成功 sk-9fe5…，1 虾粮
填入已有 sk-de7d… → 启用 → 467,658 虾粮
发一条消息 → 收到回复 → 账本 467658 → 444568，真扣费 23090 虾粮
```
