# Device wallet / 设备钱包

U-Claw does not use a hardware fingerprint, license gate, registration, or login. On first online start, the device-wallet service issues a random API key with one technical verification token (the minimum required for new-api to recognize the key, not a usable trial grant). Cloud calls prefer `https://api.u-claw.org.cn` and fall back to `https://api.u-claw.org` on network, server, or route-level failure. Authentication and rate-limit responses never trigger domain switching. Operators can change this trusted order in `uclaw-cloud-endpoints.json` next to `U-Claw.exe`; invalid or missing files fall back to the bundled list. The portable build stores its wallet under `data/clawx-state`; only disposable Chromium session caches use the host system cache.

U-Claw 不使用硬件指纹、授权门禁、注册或登录。首次联网启动时，设备钱包服务随机签发 API Key，并附带 1 个技术验证 token（只是 new-api 识别 Key 所需的最低值，不是可用的试用赠额）；云端请求优先使用 `https://api.u-claw.org.cn`，网络、服务端或具体接口路径失败时自动切到 `https://api.u-claw.org`，但鉴权失败和限流判决不会靠换域名绕过。运营方以后可以直接修改 `U-Claw.exe` 旁的 `uclaw-cloud-endpoints.json` 调整受信任域名顺序；文件缺失或无效时自动退回内置清单。便携版把钱包保存在自身的 `data/clawx-state` 目录，仅把可丢弃的 Chromium 会话缓存放到宿主机系统缓存。

## Legacy portable migration / 旧版便携迁移

Older builds accidentally stored the wallet under the host `%APPDATA%/clawx` directory. When a wallet-less portable build finds that file, it pauses automatic bind and shows only the masked key plus a read-only balance. The user must explicitly choose **Import previous wallet** or **Create new wallet**. Import uses the normal adopt/provider-application path; create-new leaves the old file, key, and server balance untouched. A plaintext legacy key is never returned to Renderer or bundled into a release.

旧版本曾把钱包误写到宿主机 `%APPDATA%/clawx`。无钱包的便携版发现该文件后会暂停自动 bind，只向界面显示脱敏 Key 和只读余额，由用户明确选择**导入旧钱包**或**创建新钱包**。导入仍走标准 adopt/provider 应用入口；创建新钱包也不会删除旧文件、旧 Key 或服务端余额。旧钱包明文 Key 永远不会返回渲染层，更不能进入发布包。

If the managed Gateway is already running when a wallet is imported or changed, U-Claw briefly stops it, persists the wallet, provider, and OpenClaw runtime configuration while offline, then restarts the Gateway in the background. This avoids a chain of live `config.get`/`config.set` timeouts and lets the wallet and provider UI converge immediately. A Gateway that the user intentionally stopped is not started.

如果导入或更换钱包时受管 Gateway 已在运行，U-Claw 会短暂停止它，离线原子写入钱包、Provider 与 OpenClaw 运行时配置，再在后台重新启动。这样不会串行等待多次 `config.get`/`config.set` 超时，钱包区与 Provider 区也能立即同步。用户原本主动停止的 Gateway 不会被自动唤醒。

## Security model / 安全模型

- The API key is the wallet credential. Anyone holding it can spend the wallet's entire available balance; adopting a key on another computer does **not** split or limit the balance.
- If the key may have leaked, use **Rotate key / 换一把**. Rotation moves the wallet to a newly issued key, keeps the balance, and makes the old key invalid.
- Removing a key only from one computer would not revoke it on the server. It is therefore not a leak-response action.
- **Remove wallet from this device** clears only ClawX-managed local consumers and wallet state. The old server wallet, key, and balance remain valid; the next online convergence creates a separate wallet carrying only the one-token verification minimum.
- A user who adopted somebody else's key will receive `401` after the wallet owner rotates it and must obtain the new key to continue.
- Back up the key before reinstalling or moving to another computer. U-Claw has no account recovery flow because the key itself is the credential.

- API Key 就是钱包凭证。谁拿着它，谁就能使用该钱包的**全部可用余额**；在另一台电脑填入 Key，不会只分到一部分额度。
- 怀疑泄露时必须使用 **换一把**。轮换后余额留在原钱包，新 Key 生效，旧 Key 立即失效。
- 只从某台电脑删除本地 Key，不会吊销服务端凭证，因此不能用来处置泄露。
- **移除本机钱包**只清理 ClawX 管理的本机消费者和钱包状态。旧服务端钱包、Key 与余额仍然有效；下次联网收敛会创建一个只含 1 个技术验证 token 的独立新钱包。
- 如果别人填入了你的 Key，你轮换后，对方仍使用旧 Key 的请求会返回 `401`；除非你再把新 Key 给他。
- 重装或换机前请备份 Key。设备钱包没有注册/找回流程，因为 Key 本身就是凭证。

## Local removal / 移除本机

ClawX copies the current key before showing the destructive confirmation. It then clears the managed chat provider and image relay before clearing the five local wallet fields. It never calls a server-side wallet or balance deletion endpoint. Unknown pending operations are preserved; a pending rotation is settled first and requires a new confirmation against the resulting key.

ClawX 会先复制当前 Key，再显示危险操作确认。执行时先清除受管理的聊天 Provider 和图像 Relay，随后才清空五个本地钱包字段；不会调用任何服务端钱包或余额删除接口。未知 pending 状态会原样保留；未完成的轮换会先收尾，并要求用户针对新 Key 再确认一次。

## Open-source boundary / 开源边界

The client state machine, API routes, UI, and tests are public. Real `sk-` credentials, administrator tokens, payment signing keys, production `.env` files, databases, and the removed hardware-fingerprint derivation algorithm must never be committed or bundled.

客户端状态机、接口路径、界面和测试可以公开；真实 `sk-` 凭证、管理员 Token、支付签名私钥、生产 `.env`、数据库，以及已经删除的硬件指纹派生算法，不得进入仓库或分发产物。
