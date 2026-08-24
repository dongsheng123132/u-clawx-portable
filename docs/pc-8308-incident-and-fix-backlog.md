# pc-8308 客户机事故复盘 与 修复/需求台账

> 日期：2026-08-24 · 排查人：ox-alpha（Hermes）· 复现机：pc-8308（DESKTOP-PFDJHG7，Windows x64）
> 涉事介质：USB 便携版 `F:\U-Claw`（ClawX/U-Claw 壳 v0.5.5 + 内置 OpenClaw 2026.7.1）

## 一、事件时间线（来自 U 盘日志 clawx-2026-08-24.log）

| 本地时间 | 事件 |
|---|---|
| 14:21 | 客户首次启动。壳检测到捆绑内核需升级到 openclaw 2026.7.1，做 pre-migration 快照后开始状态目录迁移 |
| 14:21:37 | 图片插件装完触发 gateway-refresh，**把正在跑迁移的网关杀了** → SQLite `state_leases` 租约（TTL 5 分钟）变孤儿 |
| 14:21–14:34 | 之后每次重启网关都被拒："startup migrations are already running"；壳层恢复策略把该信号判为不可重试直接放弃 → 窗口躺死。客户反复双击无效（Second instance detected），期间 14:28 一次抢到锁又崩（退出码 4294930435），租约再续 5 分钟 |
| 14:34 | 租约过期后首次尝试跑完迁移 → 就绪。**从首次双击到能用 ≈13 分钟** |
| 15:30 | 客户重启 App 并换入新虾盘云 Key（尾号 f5ed）。本轮启动 50 秒就绪，未再踩锁 |
| 16:04 | 远程实测干净启动：41 秒就绪，窗口正常，网关 18789 监听 |

## 二、问题归主与状态

### ✅ Bug #1：首启迁移锁卡死 13 分钟 —— 归壳层（本仓库），已修
- 根因：① gateway-refresh 在首次迁移未完成时重启网关，留下孤儿租约；② 恢复策略把「迁移锁」当致命错误直接 fail，不重试
- 修复：`electron/gateway/startup-recovery.ts` 新增解析报错内嵌 retry-after 截止时间 + 有界等待计算；`startup-orchestrator.ts` 等锁到期自动重试（上限一个租约周期 6min × 最多 3 轮）
- 提交：`5210f61b`（含 pc-8308 实录 stderr 的回归测试）
- ⚠️ 遗留（根因侧另一半）：**迁移进行中应挂起 gateway-refresh**（单飞逻辑），本次未动，列入下版

### ✅ 需求①：便携版不要弹更新提示 —— 归壳层（本仓库），已修
- 背景：0.5.5 便携版反复弹「发现新版本 0.5.4」——OSS feed 的 latest.yml 停在旧版本；且便携副本无法走 NSIS 就地更新
- 修复：AppUpdater 四入口硬闸（构造跳过全部 electron-updater 接线；check/download/install 短路）；新增 `disabled` 状态贯通 contract 与渲染层；四语言 i18n 补文案
- 提交：`47ff0e72`（经 fable 两轮审查定稿）

### ❌ 运维侧：OSS 发版管线的 latest.yml 未随 0.5.5 发布更新 —— 待处理
- 即使有上面的硬闸，**installed 版**用户仍会被旧 feed 干扰；需把 `https://oss.intelli-spectrum.com/latest/latest.yml` 刷到当前版本，并把「发版必须同步 OSS feed」写进 release 流程检查单

### ❌ 客户侧：虾盘云设备钱包余额耗尽 —— 已由用户换 Key 解决
- 原钱包 `wal_8c59fc09eeb72156`（Key 尾 aa31）余额 ¥0.000002，所有模型调用 403
- 用户已远程给客户配置新 Key（尾 f5ed），API 实测补全通过
- 📌 产品改进项（归壳层+云侧）：403 quota 报错应在 UI 明确显示「余额不足，去充值」，而不是笼统的 auth failed / "Couldn't sign in"

### ✅ 需求②：启动图标蓝龙虾 → 红龙虾 —— 已查清，代码无需改动
- **排查结论**：仓库内全部图标资源（icon-uclaw.png 主图、icon.ico、前端 logo、exe 内嵌图标）自 `2844de78`（08-20「恢复旧版 U-Claw 红虾图标」）起**均为红色**；客户 U 盘上文件逐一比对一致
- **蓝龙虾的真身**：客户 C 盘 `AppData\Local\Programs\ClawX\ClawX.exe` 是 **ClawX 官方安装版 0.5.4**（官方品牌即蓝龙虾），由旧 feed 弹「更新」诱导安装（08-24）；桌面快捷方式 `ClawX.lnk` 指向它——客户看到的蓝色图标其实是**另一个产品**
- **现场处置（08-24）**：从 clawx-updater 缓存包静默装回 ClawX 0.5.4；桌面保留双快捷方式并存：`ClawX.lnk`→C 盘安装版、新增 `U-Claw.lnk`→F 盘便携版；并把 U 盘版 `settings.json` 的 autoCheckUpdate 改为 false 止血（0.5.6 发布后可改回）
- ⚠️ 教训：U 盘便携版与 ClawX 安装版**共存不冲突**，但更新通道独立；便携版的更新引导绝不能指向 NSIS 安装流程

## 三、发布注意

- 以上两个修复只在开发分支 `publish/exfat-wallet-fixes`，**客户的 U 盘还是旧 0.5.5**——需要打下一版（建议 0.5.6）并重新分发才能生效
- 客户现有数据（U 盘 data/ 目录）与新版本兼容，无需迁移；升级方式＝新版解包覆盖程序文件、保留 data/
- 发版前 checklist：OSS latest.yml 同步 ✅｜迁移锁测试 ✅｜便携更新闸测试 ✅｜启动提速三项实测 ⬇️

### 0.5.6 追加：启动反馈与提速三项（2026-08-24 晚）

「还是打不开」工单的另一半根因是**冷启动 40~60 秒且前 20 秒零反馈**。三项改动（同分支）：

| 改动 | 文件 | 说明 |
|---|---|---|
| ① 启动首屏 | `electron/utils/splash-window.ts` | 便携模式双击即见「正在启动」窗；主窗 ready-to-show 自动关；120s 保险丝防孤儿窗；E2E 不启用；initialize 失败弹错误框后退出（不再静默变砖） |
| ② 编译缓存落本机 | `electron/utils/portable-compile-cache.ts` + paths 注入 | `NODE_COMPILE_CACHE` → `%LOCALAPPDATA%\U-Claw\node-compile-cache\<hash>`；UUID 盘符隔离；身份不可用时禁用（不共享固定身份）；解析结果 memo 化 |
| ③ 网关模型预热 | `electron/utils/prewarm.ts` | running 后进程级去重打一轮 `/v1/models`，焐热模型子系统；8s 超时、fire-and-forget |

- 审查记录：fable 把关时序（z-order 无竞争、第二实例不会闪 splash、utilityProcess 支持 NODE_COMPILE_CACHE 且绕开 NODE_OPTIONS 封杀）；pi 代码审查 4 条已全部修复（身份契约/loadURL rejection/预热去重/E2E 守卫）
- **发版前必测两个数字**（fable 要求）：打包版在真 U 盘连启两次——① `%LOCALAPPDATA%\U-Claw\node-compile-cache\` 下长出缓存文件 ② 第二次网关就绪时间下降。没长文件 = ESM 未命中缓存，需排查
- 已知边界：splash 只盖住前 ~20s 死区；主窗出现后等网关的 ~40s 由渲染层 gateway:status-changed 表达，真机验证时确认这个等待态不是空白
- 测试：`pnpm vitest run tests/unit/portable-compile-cache.test.ts tests/unit/portable-paths.test.ts tests/unit/startup-feedback-wiring.test.ts`

## 四、复现与验证入口

- 单测：`pnpm vitest run tests/unit/gateway-startup-recovery.test.ts tests/unit/gateway-startup-orchestrator.test.ts tests/unit/updater-portable-gate.test.ts`
- 迁移锁机制：openclaw dist/startup-migration-checkpoint-*.js，SQLite 表 `state_leases`，TTL=5min，报错文案内嵌 ISO 截止时间可解析
