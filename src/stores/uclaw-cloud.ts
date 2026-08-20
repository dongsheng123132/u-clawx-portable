import { create } from 'zustand';
import { hostApi } from '@/lib/host-api';
import type { UclawBalanceSnapshot, UclawWalletSnapshot } from '@shared/host-api/contract';

/**
 * 虾粮中心的状态：钱包（掩码）+ 余额。
 *
 * 没有登录态、没有 authenticated —— 钱包没就绪只是「还没自动配上模型」，
 * 不拦用户进应用。
 */
type UclawCloudState = {
  wallet: UclawWalletSnapshot | null;
  balance: UclawBalanceSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  getRechargeUrl: () => Promise<string>;
  getApiKey: () => Promise<string | null>;
  /** 换一把凭证，旧的当场作废。失败时抛错，错误信息是给用户看的原话。 */
  rotateKey: () => Promise<string>;
  /** 填入一把已有凭证（换电脑 / 重装 / 找回老钱包）。 */
  adoptKey: (key: string) => Promise<string>;
};

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useUclawCloudStore = create<UclawCloudState>((set, get) => ({
  wallet: null,
  balance: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const wallet = await hostApi.uclaw.wallet();
      set({ wallet });
      if (wallet.ready) void get().refreshBalance();
    } catch (error) {
      set({ error: toMessage(error) });
    } finally {
      set({ loading: false });
    }
  },

  refreshBalance: async () => {
    try {
      set({ balance: await hostApi.uclaw.balance() });
    } catch (error) {
      set({
        balance: {
          available: false,
          apiKeyMasked: get().wallet?.apiKeyMasked,
          error: toMessage(error),
        },
      });
    }
  },

  getRechargeUrl: async () => (await hostApi.uclaw.rechargeUrl()).url,

  getApiKey: async () => (await hostApi.uclaw.apiKey()).apiKey ?? null,

  rotateKey: async () => {
    const result = await hostApi.uclaw.rotateKey();
    if (!result.success) throw new Error(result.error || '换密钥失败');
    // 换完余额还在同一个钱包上，但掩码变了 —— 刷一次让界面对上。
    await get().refresh();
    return result.message || '';
  },

  adoptKey: async (key: string) => {
    const result = await hostApi.uclaw.adoptKey({ key });
    if (!result.success) throw new Error(result.error || '密钥保存失败');
    // 换的是另一个钱包，余额整个不一样，必须重新拉。
    await get().refresh();
    return result.message || '';
  },
}));
