import { logger } from '../../utils/logger';

export const UCLAW_CLOUD_DEFAULT_API_BASE = 'https://api.u-claw.org/v1';
export const UCLAW_CLOUD_DEFAULT_PAY_BASE = 'https://api.u-claw.org';
export const UCLAW_CLOUD_FALLBACK_API_BASE = 'https://api.u-claw.org.cn/v1';
export const UCLAW_CLOUD_FALLBACK_PAY_BASE = 'https://api.u-claw.org.cn';

const ENV_API_BASE_URL = 'UCLAW_API_BASE_URL';
const ENV_PAY_BASE_URL = 'UCLAW_PAY_BASE_URL';
const PROBE_TIMEOUT_MS = 3000;

export type UclawCloudEndpoint = {
  apiBase: string;
  payBase: string;
  origin: 'env' | 'oversea' | 'cn' | 'default-fallback';
};

let cachedPromise: Promise<UclawCloudEndpoint> | null = null;

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function derivePayBaseFromApiBase(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  if (trimmed.toLowerCase().endsWith('/v1')) {
    return trimmed.slice(0, -3).replace(/\/+$/, '');
  }
  return trimmed;
}

async function probeBaseUrl(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(joinUrl(baseUrl, '/models'), {
      method: 'HEAD',
      signal: controller.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEndpointInner(): Promise<UclawCloudEndpoint> {
  const envApi = process.env[ENV_API_BASE_URL]?.trim();
  const envPay = process.env[ENV_PAY_BASE_URL]?.trim();
  if (envApi) {
    const apiBase = envApi;
    const payBase = envPay || derivePayBaseFromApiBase(envApi);
    logger.info(`[uclaw-cloud-endpoint] Using env override: api=${apiBase} pay=${payBase}`);
    return { apiBase, payBase, origin: 'env' };
  }

  if (await probeBaseUrl(UCLAW_CLOUD_DEFAULT_API_BASE, PROBE_TIMEOUT_MS)) {
    return {
      apiBase: UCLAW_CLOUD_DEFAULT_API_BASE,
      payBase: UCLAW_CLOUD_DEFAULT_PAY_BASE,
      origin: 'oversea',
    };
  }

  logger.warn('[uclaw-cloud-endpoint] Main endpoint unreachable, probing CN fallback');

  if (await probeBaseUrl(UCLAW_CLOUD_FALLBACK_API_BASE, PROBE_TIMEOUT_MS)) {
    logger.info('[uclaw-cloud-endpoint] CN fallback reachable, using api.u-claw.org.cn');
    return {
      apiBase: UCLAW_CLOUD_FALLBACK_API_BASE,
      payBase: UCLAW_CLOUD_FALLBACK_PAY_BASE,
      origin: 'cn',
    };
  }

  logger.warn('[uclaw-cloud-endpoint] Both endpoints unreachable, falling back to defaults');
  return {
    apiBase: UCLAW_CLOUD_DEFAULT_API_BASE,
    payBase: UCLAW_CLOUD_DEFAULT_PAY_BASE,
    origin: 'default-fallback',
  };
}

export function detectBestEndpoint(): Promise<UclawCloudEndpoint> {
  if (!cachedPromise) {
    cachedPromise = resolveEndpointInner().catch((error) => {
      logger.warn('[uclaw-cloud-endpoint] Resolver crashed, returning defaults:', error);
      cachedPromise = null;
      return {
        apiBase: UCLAW_CLOUD_DEFAULT_API_BASE,
        payBase: UCLAW_CLOUD_DEFAULT_PAY_BASE,
        origin: 'default-fallback' as const,
      };
    });
  }
  return cachedPromise;
}

export function resetEndpointCache(): void {
  cachedPromise = null;
}
