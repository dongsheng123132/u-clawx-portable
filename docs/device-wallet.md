# Device wallet / 设备钱包

U-Claw does not use a hardware fingerprint, license gate, registration, or login. On first online start, the server issues a random API key for a zero-balance wallet. The portable build stores that wallet under its own `data/clawx-state` directory.

U-Claw 不使用硬件指纹、授权门禁、注册或登录。首次联网启动时，服务端为一个零余额钱包随机签发 API Key；便携版把钱包保存在自身的 `data/clawx-state` 目录。

## Security model / 安全模型

- The API key is the wallet credential. Anyone holding it can spend the wallet's entire available balance; adopting a key on another computer does **not** split or limit the balance.
- If the key may have leaked, use **Rotate key / 换一把**. Rotation moves the wallet to a newly issued key, keeps the balance, and makes the old key invalid.
- Removing a key only from one computer would not revoke it on the server. It is therefore not a leak-response action.
- A user who adopted somebody else's key will receive `401` after the wallet owner rotates it and must obtain the new key to continue.
- Back up the key before reinstalling or moving to another computer. U-Claw has no account recovery flow because the key itself is the credential.

- API Key 就是钱包凭证。谁拿着它，谁就能使用该钱包的**全部可用余额**；在另一台电脑填入 Key，不会只分到一部分额度。
- 怀疑泄露时必须使用 **换一把**。轮换后余额留在原钱包，新 Key 生效，旧 Key 立即失效。
- 只从某台电脑删除本地 Key，不会吊销服务端凭证，因此不能用来处置泄露。
- 如果别人填入了你的 Key，你轮换后，对方仍使用旧 Key 的请求会返回 `401`；除非你再把新 Key 给他。
- 重装或换机前请备份 Key。设备钱包没有注册/找回流程，因为 Key 本身就是凭证。

## Open-source boundary / 开源边界

The client state machine, API routes, UI, and tests are public. Real `sk-` credentials, administrator tokens, payment signing keys, production `.env` files, databases, and the removed hardware-fingerprint derivation algorithm must never be committed or bundled.

客户端状态机、接口路径、界面和测试可以公开；真实 `sk-` 凭证、管理员 Token、支付签名私钥、生产 `.env`、数据库，以及已经删除的硬件指纹派生算法，不得进入仓库或分发产物。
