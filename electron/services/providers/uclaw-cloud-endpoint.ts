import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger';
import { getAppRoot } from '../../utils/paths';
import {
  UCLAW_CLOUD_ENDPOINTS,
  UCLAW_CLOUD_FALLBACK_ENDPOINT,
  UCLAW_CLOUD_PRIMARY_ENDPOINT,
  type UclawCloudEndpointCandidate,
} from '../../shared/providers/uclaw-cloud-config';

export const UCLAW_CLOUD_PRIMARY_API_BASE = UCLAW_CLOUD_PRIMARY_ENDPOINT.apiBase;
export const UCLAW_CLOUD_PRIMARY_PAY_BASE = UCLAW_CLOUD_PRIMARY_ENDPOINT.payBase;
export const UCLAW_CLOUD_FALLBACK_API_BASE = UCLAW_CLOUD_FALLBACK_ENDPOINT.apiBase;
export const UCLAW_CLOUD_FALLBACK_PAY_BASE = UCLAW_CLOUD_FALLBACK_ENDPOINT.payBase;

const PROBE_TIMEOUT_MS = 3000;
export const UCLAW_CLOUD_ENDPOINT_CONFIG_FILE = 'uclaw-cloud-endpoints.json';

export type UclawCloudEndpoint = {
  apiBase: string;
  payBase: string;
  origin: 'primary' | 'fallback' | 'primary-unverified';
};

let cachedPromise: Promise<UclawCloudEndpoint> | null = null;

function validHttpsBase(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return value.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function loadUclawCloudEndpointCandidates(
  configPath = join(getAppRoot(), UCLAW_CLOUD_ENDPOINT_CONFIG_FILE),
): UclawCloudEndpointCandidate[] {
  if (!existsSync(configPath)) return [...UCLAW_CLOUD_ENDPOINTS];
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      version?: unknown;
      endpoints?: Array<{ id?: unknown; apiBase?: unknown; payBase?: unknown }>;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.endpoints)) {
      throw new Error('unsupported config shape');
    }
    const candidates = parsed.endpoints.slice(0, 4).flatMap((entry, index) => {
      const apiBase = validHttpsBase(entry.apiBase);
      const payBase = validHttpsBase(entry.payBase);
      if (!apiBase || !payBase) return [];
      return [{
        id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `endpoint-${index + 1}`,
        apiBase,
        payBase,
      }];
    });
    if (candidates.length === 0) throw new Error('no valid HTTPS endpoint');
    return candidates.filter((candidate, index) => (
      candidates.findIndex((item) => item.apiBase === candidate.apiBase && item.payBase === candidate.payBase) === index
    ));
  } catch (error) {
    logger.warn('[uclaw-cloud-endpoint] Ignoring invalid portable endpoint config:', error);
    return [...UCLAW_CLOUD_ENDPOINTS];
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function probeBaseUrl(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(joinUrl(baseUrl, '/models'), {
      method: 'HEAD',
      signal: controller.signal,
    });
    // 4xx means the route and network path answered. Only network failures and
    // 5xx justify switching domains.
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEndpoint(): Promise<UclawCloudEndpoint> {
  const candidates = loadUclawCloudEndpointCandidates();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (await probeBaseUrl(candidate.apiBase)) {
      return {
        apiBase: candidate.apiBase,
        payBase: candidate.payBase,
        origin: index === 0 ? 'primary' : 'fallback',
      };
    }
    if (index < candidates.length - 1) {
      logger.warn(`[uclaw-cloud-endpoint] ${candidate.id} unavailable, trying next endpoint`);
    }
  }

  // Keep startup fail-soft. Consumers will surface their own network error and
  // the cache is reset after a rejected resolver, so a later refresh can retry.
  logger.warn('[uclaw-cloud-endpoint] Both endpoints unavailable; keeping primary as unverified');
  return {
    apiBase: candidates[0].apiBase,
    payBase: candidates[0].payBase,
    origin: 'primary-unverified',
  };
}

export function detectBestEndpoint(): Promise<UclawCloudEndpoint> {
  if (!cachedPromise) {
    cachedPromise = resolveEndpoint()
      .then((endpoint) => {
        if (endpoint.origin === 'primary-unverified') cachedPromise = null;
        return endpoint;
      })
      .catch((error) => {
        cachedPromise = null;
        throw error;
      });
  }
  return cachedPromise;
}

export function resetEndpointCache(): void {
  cachedPromise = null;
}
