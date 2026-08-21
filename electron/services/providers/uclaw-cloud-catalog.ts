import { logger } from '../../utils/logger';
import {
  detectBestEndpoint,
  UCLAW_CLOUD_PRIMARY_API_BASE,
} from './uclaw-cloud-endpoint';

/**
 * 虾盘云模型目录与价格 —— 唯一真相源在服务端，客户端不攒清单。
 *
 * 规范（三件事、三个源，别混）：
 *
 *   这把 key 能调什么   →  /v1/models          谁都别自己攒清单
 *   多贵                →  /api/pricing        查不到就不显示价格，不许估、不许写死
 *   推荐哪几个、什么顺序 →  产品策展清单（只存 id）  不存 label/价格/上下文长度
 *
 * 本模块负责前两件。第三件在 uclaw-cloud-curation.ts。
 *
 * 全部 fail-soft：拿不到就返回 null，调用方退回「不显示」而不是编一个。
 */

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export type ModelPricing = {
  /** new-api 的倍率。语义以服务端为准，客户端只做展示，不参与计费。 */
  modelRatio?: number;
  completionRatio?: number;
  cacheRatio?: number;
};

async function apiOrigin(): Promise<string> {
  const endpoint = await detectBestEndpoint().catch(() => ({
    apiBase: UCLAW_CLOUD_PRIMARY_API_BASE,
  }));
  return endpoint.apiBase.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

type Cached<T> = { value: T; at: number };
let modelsCache: Cached<string[]> | null = null;
let pricingCache: Cached<Map<string, ModelPricing>> | null = null;

function fresh<T>(cache: Cached<T> | null): T | null {
  if (!cache) return null;
  return Date.now() - cache.at < CACHE_TTL_MS ? cache.value : null;
}

/**
 * 这把 key 到底能调哪些模型。**只认 `/v1/models`。**
 *
 * 返回 null = 没问到（离线 / 服务端抖动）。调用方这时别自作主张，
 * 退回策展清单原样展示即可 —— 宁可多列一个调不通的，也别少列用户买过的。
 */
export async function fetchAvailableModelIds(apiKey: string): Promise<string[] | null> {
  const cached = fresh(modelsCache);
  if (cached) return cached;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${await apiOrigin()}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeoutSignal(),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (payload?.data ?? [])
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
      .filter(Boolean);
    if (ids.length === 0) return null;
    modelsCache = { value: ids, at: Date.now() };
    return ids;
  } catch (error) {
    logger.warn('[uclaw-cloud] 拉模型目录失败:', error);
    return null;
  }
}

/**
 * 价格倍率。**只认 `/api/pricing`（免鉴权）。**
 *
 * 返回 null 或缺某个模型 = 查不到 → 界面就**不显示价格**。
 * 不许估、不许写死一个「大概」的数字：用户看到的数要么是真的，要么没有。
 */
export async function fetchPricing(): Promise<Map<string, ModelPricing> | null> {
  const cached = fresh(pricingCache);
  if (cached) return cached;

  try {
    const res = await fetch(`${await apiOrigin()}/api/pricing`, { signal: timeoutSignal() });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      data?: Array<{
        model_name?: unknown;
        model_ratio?: unknown;
        completion_ratio?: unknown;
        cache_ratio?: unknown;
      }>;
    };
    const map = new Map<string, ModelPricing>();
    for (const row of payload?.data ?? []) {
      if (typeof row?.model_name !== 'string' || !row.model_name) continue;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      map.set(row.model_name, {
        modelRatio: num(row.model_ratio),
        completionRatio: num(row.completion_ratio),
        cacheRatio: num(row.cache_ratio),
      });
    }
    if (map.size === 0) return null;
    pricingCache = { value: map, at: Date.now() };
    return map;
  } catch (error) {
    logger.warn('[uclaw-cloud] 拉价格表失败:', error);
    return null;
  }
}
