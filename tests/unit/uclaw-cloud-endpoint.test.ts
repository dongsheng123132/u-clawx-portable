import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectBestEndpoint,
  resetEndpointCache,
  UCLAW_CLOUD_DEFAULT_API_BASE,
  UCLAW_CLOUD_DEFAULT_PAY_BASE,
  UCLAW_CLOUD_FALLBACK_API_BASE,
  UCLAW_CLOUD_FALLBACK_PAY_BASE,
} from '@electron/services/providers/uclaw-cloud-endpoint';

vi.mock('@electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_FETCH = globalThis.fetch;

describe('detectBestEndpoint', () => {
  beforeEach(() => {
    resetEndpointCache();
    delete process.env.UCLAW_API_BASE_URL;
    delete process.env.UCLAW_PAY_BASE_URL;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('returns the main endpoint when the primary HEAD probe succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock;

    const endpoint = await detectBestEndpoint();

    expect(endpoint).toEqual({
      apiBase: UCLAW_CLOUD_DEFAULT_API_BASE,
      payBase: UCLAW_CLOUD_DEFAULT_PAY_BASE,
      origin: 'oversea',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${UCLAW_CLOUD_DEFAULT_API_BASE}/models`,
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('treats 4xx as reachable because the network path answered', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 } as Response);

    const endpoint = await detectBestEndpoint();

    expect(endpoint.origin).toBe('oversea');
  });

  it('falls back to CN when the primary probe rejects', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError('fetch failed: ECONNRESET');
      }
      return { status: 200 } as Response;
    });

    const endpoint = await detectBestEndpoint();

    expect(endpoint).toEqual({
      apiBase: UCLAW_CLOUD_FALLBACK_API_BASE,
      payBase: UCLAW_CLOUD_FALLBACK_PAY_BASE,
      origin: 'cn',
    });
  });

  it('falls back to defaults when both endpoints are unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const endpoint = await detectBestEndpoint();

    expect(endpoint).toEqual({
      apiBase: UCLAW_CLOUD_DEFAULT_API_BASE,
      payBase: UCLAW_CLOUD_DEFAULT_PAY_BASE,
      origin: 'default-fallback',
    });
  });

  it('honors env overrides and skips the network probe entirely', async () => {
    process.env.UCLAW_API_BASE_URL = 'https://mirror.example.com/v1';
    process.env.UCLAW_PAY_BASE_URL = 'https://pay.example.com';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const endpoint = await detectBestEndpoint();

    expect(endpoint).toEqual({
      apiBase: 'https://mirror.example.com/v1',
      payBase: 'https://pay.example.com',
      origin: 'env',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches the resolved endpoint across calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock;

    await detectBestEndpoint();
    await detectBestEndpoint();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
