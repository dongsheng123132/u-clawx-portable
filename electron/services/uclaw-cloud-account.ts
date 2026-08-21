import type { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { getProviderDefinition } from '../shared/providers/registry';
import type { ProviderAccount } from '../shared/providers/types';
import { getProviderService } from './providers/provider-service';
import { syncDefaultProviderToRuntime } from './providers/provider-runtime-sync';
import {
  detectBestEndpoint,
  UCLAW_CLOUD_PRIMARY_API_BASE,
  UCLAW_CLOUD_PRIMARY_PAY_BASE,
} from './providers/uclaw-cloud-endpoint';
import { fetchAvailableModelIds } from './providers/uclaw-cloud-catalog';
import { ensureUclawCloudImageDefaults } from './providers/uclaw-cloud-image-defaults';
import { applyOpenAiImageRelaySettings } from '../utils/openclaw-image-generation';
import {
  fallbackCuratedModels,
  fetchCuratedModels,
  resolveOfferedModelIds,
} from './providers/uclaw-cloud-curation';
import { providerAccountToConfig } from './providers/provider-store';
import { syncDeletedProviderApiKeyToRuntime } from './providers/provider-runtime-sync';
import {
  adoptDeviceKey,
  ensureDeviceKey,
  resetLocalDeviceWallet,
  rotateDeviceKey,
} from './uclaw-device-wallet';

/**
 * 虾盘云账户 —— 把设备钱包的凭证接到 provider 上，并提供余额 / 充值链接。
 *
 * **没有授权系统**：不登录、不校验、没有 session/license/dealer，也没有
 * 硬件指纹。这台机器有没有钱包只决定「能不能自动配好模型」，不决定
 * 「能不能进应用」—— 进不去是门禁，我们不做门禁。
 *
 * 凭证的真相源只有一个：设备钱包（uclaw-device-wallet.ts）。这里不再另存
 * 一份 session，避免两份 key 漂移。
 */

const UCLAW_CLOUD_PROVIDER_ID = 'uclaw-cloud';
const UCLAW_CLOUD_DEFAULT_MODEL = 'deepseek-v4-flash';
const UCLAW_CLOUD_DEFAULT_FALLBACKS = ['deepseek-chat', 'qwen-plus', 'qwen-turbo'];

/**
 * 聊天框里能选哪些模型 = **策展 ∩ 服务端目录**，保持策展顺序。
 *
 *   推荐哪几个 →  虾盘云注册表的 featured（拉不到用内置兜底）
 *   能调什么   →  /v1/models —— 不自己攒清单
 *
 * 两处都拉不到时退回兜底清单原样展示：宁可多列一个暂时调不通的，
 * 也别因为一次网络抖动把用户买过的模型从界面上抹掉。
 */
async function offeredModelIds(apiKey: string, curatedChat: string[]): Promise<string[]> {
  const available = await fetchAvailableModelIds(apiKey);
  return resolveOfferedModelIds(curatedChat, available);
}

const NETWORK_TIMEOUT_MS = 10_000;

export type UclawBalance = {
  available: boolean;
  remainTokens?: number;
  usedTokens?: number;
  quotaTokens?: number;
  apiKeyMasked?: string;
  updatedAt?: number;
  error?: string;
};

export type UclawWalletInfo = {
  /** 有没有可用凭证。没有时界面提示「联网后自动获取」，而不是拦住用户。 */
  ready: boolean;
  apiKeyMasked?: string;
  walletId?: string;
};

function maskApiKey(apiKey?: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 13) return `${apiKey.slice(0, 4)}...`;
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-6)}`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(NETWORK_TIMEOUT_MS) : undefined;
}

function apiOrigin(apiBase: string): string {
  return apiBase.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function tokenCount(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.round(numeric));
}

function buildUclawCloudAccount(offered: string[], baseUrl: string): ProviderAccount {
  const definition = getProviderDefinition(UCLAW_CLOUD_PROVIDER_ID);
  const now = new Date().toISOString();
  return {
    id: UCLAW_CLOUD_PROVIDER_ID,
    vendorId: UCLAW_CLOUD_PROVIDER_ID,
    label: definition?.name ?? '虾盘云',
    authMode: definition?.defaultAuthMode ?? 'api_key',
    baseUrl,
    model: UCLAW_CLOUD_DEFAULT_MODEL,
    fallbackModels: [...UCLAW_CLOUD_DEFAULT_FALLBACKS],
    metadata: { customModels: offered },
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 把一把凭证配到 uclaw-cloud provider 上；null 是同一入口的清除形态。 */
async function applyKeyToProvider(apiKey: string | null, gatewayManager?: GatewayManager): Promise<void> {
  const providerService = getProviderService();
  const existing = await providerService.getAccount(UCLAW_CLOUD_PROVIDER_ID);
  if (!apiKey) {
    // 先清运行时，再清本地凭证。任何一步失败都让钱包状态保持原样，避免假成功。
    if (existing) {
      await syncDeletedProviderApiKeyToRuntime(
        providerAccountToConfig(existing),
        UCLAW_CLOUD_PROVIDER_ID,
      );
    }
    await providerService._deleteProviderApiKeyInternal(UCLAW_CLOUD_PROVIDER_ID);
    // 图像生成使用独立的 ClawX-owned provider，也持有同一把钱包 key。
    await applyOpenAiImageRelaySettings({ enabled: false });
    return;
  }
  const endpoint = await detectBestEndpoint().catch(() => ({
    apiBase: UCLAW_CLOUD_PRIMARY_API_BASE,
    payBase: UCLAW_CLOUD_PRIMARY_PAY_BASE,
    origin: 'primary-unverified' as const,
  }));
  const curated = (await fetchCuratedModels(apiOrigin(endpoint.apiBase))) ?? fallbackCuratedModels();
  const account = buildUclawCloudAccount(await offeredModelIds(apiKey, curated.chat), endpoint.apiBase);

  if (existing) {
    // 用户在虾粮中心里换过模型的话要保住，不能每次启动给他改回默认。
    account.model = existing.model || account.model;
    if (existing.fallbackModels?.length) {
      account.fallbackModels = [...existing.fallbackModels];
    }
    // 清单每次按最新推荐重置（新增模型能随版本铺开），但用户当前选中的
    // 那个必须留在里面 —— 否则下拉里看不到它，选择就悬空了。
    if (account.model && !account.metadata?.customModels?.includes(account.model)) {
      account.metadata = {
        ...account.metadata,
        customModels: [account.model, ...(account.metadata?.customModels ?? [])],
      };
    }
    await providerService.updateAccount(UCLAW_CLOUD_PROVIDER_ID, account, apiKey);
  } else {
    await providerService.createAccount(account, apiKey);
  }

  // 只在没有别的可用默认账号时才占默认位。用户自己选的付费默认（比如
  // MiniMax）必须能扛过重启 —— 所有路径都汇到这个函数，漏一处就会被改掉。
  const defaultAccountId = await providerService.getDefaultAccountId();
  if (defaultAccountId && defaultAccountId !== UCLAW_CLOUD_PROVIDER_ID) {
    const defaultAccount = await providerService.getAccount(defaultAccountId);
    if (defaultAccount) {
      logger.info(`[uclaw-cloud] 保留用户默认 provider "${defaultAccountId}"，虾盘云作为备选账号`);
      return;
    }
  }

  await providerService.setDefaultAccount(UCLAW_CLOUD_PROVIDER_ID);
  await syncDefaultProviderToRuntime(UCLAW_CLOUD_PROVIDER_ID, gatewayManager);

  // image_generate 用独立的 OpenAI Images 兼容端点，和聊天 provider 无关。
  // best-effort：配不上不影响聊天。
  await ensureUclawCloudImageDefaults(apiKey, {
    apiBaseUrl: account.baseUrl,
    model: curated.image,
  });
}

/**
 * 启动时调一次：确保这台机器有钱包，并把凭证配到 provider 上。
 *
 * **绝不抛异常** —— 联网失败只意味着「这次没自动配上」，用户仍然可以进应用、
 * 手动配本地或局域网模型。
 */
export async function ensureUclawCloudAccount(gatewayManager?: GatewayManager): Promise<UclawWalletInfo> {
  const wallet = await ensureDeviceKey();
  if (!wallet.apiKey) {
    return { ready: false };
  }
  try {
    await applyKeyToProvider(wallet.apiKey, gatewayManager);
  } catch (error) {
    logger.warn('[uclaw-cloud] 配置 provider 失败:', error);
  }
  return { ready: true, apiKeyMasked: maskApiKey(wallet.apiKey), walletId: wallet.walletId };
}

/** 当前钱包信息（掩码，不含明文 key）。 */
export async function getWalletInfo(): Promise<UclawWalletInfo> {
  const wallet = await ensureDeviceKey();
  return wallet.apiKey
    ? { ready: true, apiKeyMasked: maskApiKey(wallet.apiKey), walletId: wallet.walletId }
    : { ready: false };
}

/** 虾粮余额。 */
export async function getBalance(): Promise<UclawBalance> {
  const wallet = await ensureDeviceKey();
  if (!wallet.apiKey) {
    return { available: false, error: 'no_wallet' };
  }
  const masked = maskApiKey(wallet.apiKey);
  try {
    const endpoint = await detectBestEndpoint();
    const res = await fetch(joinUrl(apiOrigin(endpoint.apiBase), '/api/usage/token/'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${wallet.apiKey}` },
      signal: timeoutSignal(),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const usage = (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload) as Record<string, unknown>;
    const remainTokens = tokenCount(usage.total_available);
    return {
      available: remainTokens !== undefined,
      remainTokens,
      usedTokens: tokenCount(usage.total_used),
      quotaTokens: tokenCount(usage.total_granted),
      apiKeyMasked: masked,
      updatedAt: Date.now(),
    };
  } catch (error) {
    logger.warn('[uclaw-cloud] 读取余额失败:', error);
    return {
      available: false,
      apiKeyMasked: masked,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 一键充值：带上本机钱包 key 的充值页地址。 */
export async function getRechargeUrl(): Promise<{ url: string }> {
  const wallet = await ensureDeviceKey();
  if (!wallet.apiKey) throw new Error('这台机器还没有钱包，先联网启动一次');
  const endpoint = await detectBestEndpoint().catch(() => ({
    payBase: UCLAW_CLOUD_PRIMARY_PAY_BASE,
  }));
  const url = new URL('/recharge', endpoint.payBase);
  url.searchParams.set('key', wallet.apiKey);
  return { url: url.toString() };
}

/** 明文 key —— 只在用户主动点「复制密钥」时取。 */
export async function getApiKey(): Promise<{ apiKey: string | null }> {
  const wallet = await ensureDeviceKey();
  return { apiKey: wallet.apiKey || null };
}

/** 换一把凭证，并同步到 provider。 */
export async function rotateKey(gatewayManager?: GatewayManager): Promise<{ apiKey: string; message: string }> {
  const result = await rotateDeviceKey();
  await applyKeyToProvider(result.apiKey, gatewayManager);
  return result;
}

/** 填入一把已有凭证，并同步到 provider。 */
export async function adoptKey(
  key: string,
  gatewayManager?: GatewayManager,
): Promise<{ apiKey: string; message: string }> {
  const result = await adoptDeviceKey(key);
  await applyKeyToProvider(result.apiKey, gatewayManager);
  return result;
}

/** 移除本机钱包；不调用任何服务端删除/清余额接口。 */
export async function resetLocalWallet(
  gatewayManager?: GatewayManager,
): Promise<{ message: string }> {
  return resetLocalDeviceWallet({
    beforeClear: () => applyKeyToProvider(null, gatewayManager),
  });
}
