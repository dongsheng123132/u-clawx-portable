/**
 * 余额/额度不足类错误（虾盘云 new-api 的 403）：识别后把后端 raw 英文换成
 * 「余额不足 + 去充值」的友好引导，其余错误原样展示。
 *
 * 从 u-claw 主线 f2c536fb 移植；正则覆盖 new-api quota 中间件与 openclaw
 * 包装层的已知文案，命中面宁窄勿宽 —— 误伤普通报错比漏掉一次提示更糟。
 */
export function isQuotaRunError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /quota is not enough|insufficient[_\s-]*user[_\s-]*quota|insufficient.*quota|预扣费额度|额度已用尽|剩余额度|TokenStatusExhausted|余额不足/i.test(message);
}
