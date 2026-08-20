# 任务：把 24 个失败的单测修绿

## 背景

这是 ClawX 的**薄壳分支**：从上游 `v0.5.4` 干净重建，只加三样东西 ——
便携模式、虾盘云一键充值、设备钱包。上游原有的**硬件指纹和授权系统被整个删掉了**
（不是禁用，是删除）。

所以失败大概率分两类，**必须先分类再动手**：

- **A 类：我们改动引起的** —— 测试断言的是被删掉的旧接口（`uclaw-auth`、指纹、license），
  或者我们新加的注入点破坏了原有 mock。→ **改测试**去匹配新架构。
- **B 类：上游自带 / 环境缺产物** —— 需要先 `pnpm run build:vite` 或需要下载的二进制。
  → **不要改测试**，补前置或标记 skip 并写明原因。

## 第一步（不要跳过）

在动任何代码之前，先确认基线：

```bash
git stash list           # 应为空
git log --oneline -1
git worktree list
```

然后**对照上游**判断每个失败属于 A 还是 B：

```bash
# 上游 v0.5.4 的同一个测试文件长什么样
git show v0.5.4:tests/unit/<name>.test.ts | head -60
git diff v0.5.4 -- tests/unit/<name>.test.ts
git diff v0.5.4 --stat -- electron/ | head -40
```

把分类结果写进 `TASK-fix-tests-report.md`，一行一个文件：
`文件 | A/B | 根因一句话 | 处置`。

## 失败清单（24 个）

```
tests/unit/acp-chat-service.test.ts
tests/unit/agent-config.test.ts
tests/unit/channel-config.test.ts
tests/unit/chat-acp-inline-timeline.test.tsx
tests/unit/chat-store-session-label-fetch.test.ts
tests/unit/clawx-openai-image-plugin.test.ts
tests/unit/control-ui-device-pairing.test.ts
tests/unit/gateway-supervisor.test.ts
tests/unit/harness-runner.test.ts
tests/unit/harness-specs.test.ts
tests/unit/host-api-facade.test.ts
tests/unit/host-services.test.ts
tests/unit/local-skill-service.test.ts
tests/unit/openclaw-auth.test.ts
tests/unit/openclaw-bundle-config.test.ts
tests/unit/openclaw-cli.test.ts
tests/unit/openclaw-image-generation.test.ts
tests/unit/openclaw-restart-recovery-patch.test.ts
tests/unit/openclaw-upgrade-snapshot.test.ts
tests/unit/patch-nsis-extract.test.ts
tests/unit/patch-nsis-install-section.test.ts
tests/unit/plugin-install.test.ts
tests/unit/preinstalled-skill.test.ts
tests/unit/whatsapp-login.test.ts
```

## 已知的改动面（判 A/B 时先看这里）

| 我们改了什么 | 可能牵连 |
|---|---|
| 删掉 `electron/utils/uclaw-device-fingerprint.ts`、`openclaw-auth*.ts` 的授权部分 | `openclaw-auth.test.ts` |
| 新增 `electron/services/uclaw-api.ts` 并注册进 typed IPC contract | `host-api-facade`、`host-services` |
| 8 处注入 `getOpenClawPortableEnv()` | `gateway-supervisor`、`openclaw-cli`、`control-ui-device-pairing` |
| `electron/main/index.ts` 便携 `app.setPath('userData', getDataDir())` | 任何 mock 了 `app.getPath` 的 |
| 新增 `uclaw-cloud` provider（**故意不带 `models` 数组**，清单走服务端） | provider 相关 |
| 图像生成走独立 OpenAI-Images 兼容端点 | `openclaw-image-generation`、`clawx-openai-image-plugin` |

## 红线（违反了这次改动就作废）

1. **不许为了让测试变绿而把指纹 / 授权系统加回来。** 那是产品决策，不是 bug。
2. **不许硬编码模型 ID、价格、倍率。** 规范：能调什么问 `/v1/models`，多贵问 `/api/pricing`，
   查不到就不显示价格 —— 不许估、不许写死。策展清单只存 id。
3. **不许在代码或测试里写任何真实 `sk-` 凭证。**
4. **不许改 `tests/unit/portable-paths.test.ts` 里「便携层的调用点（源码级）」那两条。**
   它们是防回归的，红了说明便携改道被删了，要修的是代码不是测试。
5. 改不动的就**留红并写清楚为什么**，不要 `it.skip` 了事而不给理由。

## 完成标准

- `pnpm test` 退出码 0，或者剩余失败全部在报告里有 B 类归因
- `pnpm run lint:check` 退出码 0（warning 可以有，error 不行）
- `pnpm run typecheck` 退出码 0
- 产出 `TASK-fix-tests-report.md`
- **每修一类就 commit 一次**，commit message 用中文说清「修的是 A 还是 B」

## 注意

- Windows + Git Bash，路径含空格要加引号
- Node 必须用系统的 `/c/Program Files/nodejs`（`~/.uking` 里那个 v22.20.0 跑 `fs.cpSync` 会崩，
  退出码 3221226505）。命令前加 `PATH="/c/Program Files/nodejs:$PATH"`
- 判断命令真实退出码：**不要** `cmd | tail`（`$?` 会变成 tail 的）。
  用 `cmd > /tmp/x.log 2>&1; echo "退出码=$?"`
