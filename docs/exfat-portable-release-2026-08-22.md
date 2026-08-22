# 便携版 exFAT 启动 + 设备钱包 · 交接（2026-08-22）

给下一版接手的人。**先读这一页再动便携启动、设备钱包或云端点相关的代码。**

## 一句话

「U 盘插 A 电脑能用、插 B 电脑打不开」的根因**不是 exFAT 兼容性**，是宿主机环境里的
provider 凭证变量；「密钥用不了」的根因**不是 key 坏了**，是验证只打了一个端点。
两件事都已修，但**都还没有真机端到端验收**（见「没做的事」）。

## 四个已定位的根因

| # | 症状 | 根因 | 修复 |
|---|------|------|------|
| 1 | 双击弹原生错误框 `Cannot find module 'ms'`，无日志无窗口 | `ms` 只声明在 devDependencies，却是 debug→electron-updater 的运行时依赖，electron-builder 只打 production 树 | `ms` 移进 dependencies；加 `pnpm run check:asar-deps` |
| 2 | gateway 永远不 ready，`refusing to report the gateway ready` | 宿主机有 `DASHSCOPE_API_KEY` 之类的变量 → OpenClaw 认为该外部 provider 已配置 → 启动迁移去装插件 → 装插件要建 `node_modules/openclaw` junction → exFAT 建不了 | `buildGatewayRuntimeEnv` 剥离 27 个变量；加 `pnpm run check:provider-env` 对账 |
| 3 | 同上，用户在界面里配了 qwen 时 | 同 #2，但走的是配置而非环境变量 | after-pack 把 `@openclaw/qwen-provider` 装进运行时的 `dist/extensions/`，当内置插件，永不触发安装 |
| 4 | 填入已有密钥 → 「这把密钥用不了，没有保存」 | `defaultVerifyKey` 只朝 `detectBestEndpoint()` 选中的**一个**端点打一次，没有故障切换。那台抖一下或被 SNI reset，好 key 当场被拒 | 改走 `fetchUclawCloudApiWithFailover` |

### #2 是怎么锁定的（方法比结论重要）

单变量实验：同一份产物、同一个 exFAT U 盘、同一台机器，**只把 `DASHSCOPE_API_KEY`
清空**，其余完全不动 → `Gateway auto-start succeeded`、18789 LISTENING。

在此之前我走了两条弯路，都是因为**没在 exFAT 上真跑就下结论**：
- 把 qwen 捆进 `resources/openclaw-plugins/` —— 那是 ClawX 自己的插件镜像，OpenClaw 根本不看它
- 给 ClawX 的 `repairPluginOpenClawPeerLink` 写了 150 行 exFAT shim —— 报错来自 OpenClaw
  **内部**的安装器，走不到那条路（shim 本身没错，ClawX 自己装插件时仍会用到，保留）

## 两个新的发货前自检

```bash
pnpm run check:asar-deps      # 解开 app.asar，查每个包的 dependencies 能不能解析
pnpm run check:provider-env   # 从捆绑运行时重新解析 provider 目录，对账环境变量清单
```

**`check:provider-env` 每次 upstream 同步后必跑。** 那份变量清单必须是字面量（启动路径上
读，早于任何 OpenClaw 模块加载），字面量抄上游就会漂，而且漂了不报错 —— 要等某个客户的
机器上恰好有那个变量才炸。

`check:asar-deps` 目前有 4 条已核过的噪音（`cross-spawn` 的 3 个依赖 + `type-fest`）：
前者只被 `@posthog/core/dist/process/spawn-local.js` require，而 `dist/index.js` 的
require 链里没有它；后者是纯类型包，asar 里没有一行运行时 JS。它不做可达性分析，
宁可多叫两声也别漏掉下一个 `ms`。

## 云端点：两台机器不是一回事

出厂 `uclaw-cloud-endpoints.json` 里 **primary 是 `api.u-claw.org.cn`**（国内可达），
**记账的是 `api.u-claw.org`**（新加坡）。实测：

```
api.u-claw.org      /api/usage/token/  → 200，真实余额
api.u-claw.org.cn   /api/usage/token/  → 404
```

余额路径靠 `fetchUclawCloudApiWithFailover`（404/5xx 才切）自动落到 SG，所以是对的。
**任何新增的云调用都必须走这个 failover，不要自己 `detectBestEndpoint()` 打一次** ——
#4 就是这么来的。

## 设备钱包：自动 vs 手工，已定的规矩

| 情况 | 做法 | 为什么 |
|---|---|---|
| 本机没有任何旧钱包 | 自动 bind 一把新的，产品立刻可用 | 可用性不该押在一次用户点击上 |
| 本机有一把**真**旧钱包 | 提示 + 用户点了才导入 | U 盘会插到别人电脑上；宿主机那把 key 可能是机器主人的，静默搬走等于拿别人的钱包花钱 |
| 本机旧文件是**没有 key 的空壳** | 按「没有旧钱包」处理，照常 bind | 跑过一次非便携版 ClawX 的电脑都会留下这种空壳；之前把它当「发现旧钱包」，便携版就永远停在等确认，既不绑新的又没东西可导入 |
| 换机 / 重装 / 换 key | **只能手工填一把** | 服务端签发的凭证和设备之间**故意**没有绑定关系（正是为了不走硬件指纹老路），客户端无从知道某把 key 属于本机。这是设计不是缺陷 |

排查钱包问题时注意：状态文件的 key 在 **`device` 子对象**里，不在顶层。我在这上面误判过一次。

## 已经验过的（2026-08-22 晚，exFAT U 盘 + 生产账本）

用 `scripts/live-e2e/` 那两个脚本跑的，出厂状态起步：

```
首启引导页 → 跳过
发现旧钱包 sk-495e…（余额 0）→ 创建新钱包 → 确认「仍然创建」
新钱包绑定成功 sk-9fe5…，1 虾粮
填入已有 sk-de7d… → 启用 → 467,658 虾粮（与 API 完全一致）
发一条消息 → 收到回复 → 账本 467658 → 444568，真扣费 23090 虾粮
```

#4（验证走故障切换）另外做了真网验证：把首选端点换成死地址后 `adoptDeviceKey` 仍然
验过并落盘；**反向验证**把修复退回旧的单端点写法，测试立刻报出用户当初看到的那句
「这把密钥用不了，没有保存」—— 等于在测试里复现了这个 bug。

## 没做的事（下一版接手要补）

1. **28 个存量单测失败**，是这次 upstream 同步遗留的，本次改动之前就红着（基线
   `0f0d171d` 28 红 / 本次 27 红，差异经单独重跑证明是并行乱序抖动）。涉及
   `openclaw-cli`、`patch-nsis`、`host-api-facade`、`models-page`、`plugin-install` 等。
   **`plugin-install` 那组和便携插件直接相关，红着不安全，建议优先清。**
2. **老版本为什么没暴露 #2**，没查清。已排除「老运行时没这机制」—— 2026.6.10 同样有
   外部 provider 目录、同样认 `DASHSCOPE_API_KEY`、同样有 `missing-configured-plugin-install`。
   剩两种可能：当初测试的机器没这批变量（幸存者偏差）／上游把迁移失败从警告升成致命。
   验法：拿老产物在设了 `DASHSCOPE_API_KEY` 的机器上从 exFAT 启一次。

## 踩过的坑，别再踩

- **构建前先看 C 盘余量。** 磁盘满时 after-pack 会「跳过」拷贝但**整体 exit 0**，产出
  一个 `canvas-win32-x64-msvc/` 是空目录的坏包。判据：文件数应为 37341 左右，
  日志里 `grep -c "not enough space"` 必须是 0。
- **7z 解压到 U 盘时，没等任务真正结束就改目录名**，7z 会重建目录继续写，产出半棵树。
  一定要等任务报完成。
- **别在 git worktree 里 junction 真实的 `node_modules`。** `git worktree remove --force`
  会顺着 junction 删进去（`.bin` 和部分 `.pnpm` 内容被清空，靠 `pnpm install --force` 修回）。
- **U 盘刚解压完，目录会被 Defender 扫描锁住几分钟**，改名报「拒绝访问」是正常的，等就行。

## 相关

- 根因 #2 的记忆卡：`clawx-exfat-gateway-env-trap`
- 计费不变量：虾盘云 `docs/虾盘云-系统不变量与开发规范.md`（动余额前必读）
- 设备钱包规范：虾盘云 `docs/设备钱包-客户端方案.md`；落地技能 `~/.claude/skills/device-wallet`
