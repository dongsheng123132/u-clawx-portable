import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import {
  adoptKey,
  getApiKey,
  getBalance,
  getRechargeUrl,
  getWalletInfo,
  rotateKey,
} from './uclaw-cloud-account';

/**
 * 虾粮中心 / 一键充值 / 设备钱包 的 typed IPC 服务。
 *
 * 挂在上游的 host:invoke 契约上，不复活旧的 Host API HTTP 服务器。
 *
 * 换 / 填密钥的失败原因是**写给用户看的**（「这把密钥用不了，没有保存」
 * 这类），所以用 `{ success:false, error }` 回而不抛 —— 抛出去经过 IPC
 * 序列化和错误归一化之后就不是原话了。
 */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUclawApi(): CompleteHostServiceRegistry['uclaw'] {
  return {
    wallet: () => getWalletInfo(),
    balance: () => getBalance(),
    rechargeUrl: () => getRechargeUrl(),
    apiKey: () => getApiKey(),
    rotateKey: async () => {
      try {
        return { success: true, ...(await rotateKey()) };
      } catch (error) {
        return { success: false, error: toMessage(error) };
      }
    },
    adoptKey: async (payload) => {
      try {
        return { success: true, ...(await adoptKey(payload?.key ?? '')) };
      } catch (error) {
        return { success: false, error: toMessage(error) };
      }
    },
  };
}
