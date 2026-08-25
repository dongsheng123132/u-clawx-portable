import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectBestEndpoint,
  fetchUclawCloudApiWithFailover,
  loadUclawCloudEndpointCandidates,
  resetEndpointCache,
  UCLAW_CLOUD_FALLBACK_API_BASE,
  UCLAW_CLOUD_FALLBACK_PAY_BASE,
  UCLAW_CLOUD_PRIMARY_API_BASE,
  UCLAW_CLOUD_PRIMARY_PAY_BASE,
} from '@electron/services/providers/uclaw-cloud-endpoint';

vi.mock('@electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_FETCH = globalThis.fetch;

describe('U-ClawX cloud endpoint failover', () => {
  beforeEach(() => resetEndpointCache());
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('uses api.u-claw.org.cn when the primary path answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 } as Response);
    globalThis.fetch = fetchMock;

    expect(await detectBestEndpoint()).toEqual({
      apiBase: UCLAW_CLOUD_PRIMARY_API_BASE,
      payBase: UCLAW_CLOUD_PRIMARY_PAY_BASE,
      origin: 'primary',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('switches to api.u-claw.org only after a primary network/5xx failure', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ status: 503 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response);

    expect(await detectBestEndpoint()).toEqual({
      apiBase: UCLAW_CLOUD_FALLBACK_API_BASE,
      payBase: UCLAW_CLOUD_FALLBACK_PAY_BASE,
      origin: 'fallback',
    });
  });

  it('keeps the primary unverified and retries later when both paths fail', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    globalThis.fetch = fetchMock;

    expect((await detectBestEndpoint()).origin).toBe('primary-unverified');
    expect((await detectBestEndpoint()).origin).toBe('primary-unverified');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caches a verified choice for the rest of the process', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock;

    await detectBestEndpoint();
    await detectBestEndpoint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the concrete API route on fallback when the healthy primary edge returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200 } as Response) // primary /models probe
      .mockResolvedValueOnce({ status: 404 } as Response) // primary usage route
      .mockResolvedValueOnce({ status: 200 } as Response); // fallback usage route
    globalThis.fetch = fetchMock;

    const response = await fetchUclawCloudApiWithFailover('/api/usage/token/', {
      headers: { Authorization: 'Bearer sk-test-only' },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${UCLAW_CLOUD_PRIMARY_API_BASE}/models`,
      `${UCLAW_CLOUD_PRIMARY_PAY_BASE}/api/usage/token/`,
      `${UCLAW_CLOUD_FALLBACK_PAY_BASE}/api/usage/token/`,
    ]);
  });

  it('does not evade an authentication or rate-limit decision through fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200 } as Response)
      .mockResolvedValueOnce({ status: 401 } as Response);
    globalThis.fetch = fetchMock;

    expect((await fetchUclawCloudApiWithFailover('/api/usage/token/')).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads an operator-editable HTTPS A/B list and rejects an invalid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uclaw-endpoints-'));
    const configPath = join(dir, 'uclaw-cloud-endpoints.json');
    try {
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        endpoints: [
          { id: 'a', apiBase: 'https://a.example.com/v1/', payBase: 'https://a.example.com/' },
          { id: 'b', apiBase: 'https://b.example.com/v1', payBase: 'https://b.example.com' },
        ],
      }));
      expect(loadUclawCloudEndpointCandidates(configPath)).toEqual([
        { id: 'a', apiBase: 'https://a.example.com/v1', payBase: 'https://a.example.com' },
        { id: 'b', apiBase: 'https://b.example.com/v1', payBase: 'https://b.example.com' },
      ]);

      writeFileSync(configPath, JSON.stringify({
        version: 1,
        endpoints: [{ apiBase: 'http://unsafe.example.com/v1', payBase: 'https://safe.example.com' }],
      }));
      expect(loadUclawCloudEndpointCandidates(configPath)[0].apiBase).toBe(UCLAW_CLOUD_PRIMARY_API_BASE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
