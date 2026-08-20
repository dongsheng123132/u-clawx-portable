import { describe, expect, it, vi } from 'vitest';

import {
  fallbackCuratedModels,
  fetchCuratedModels,
  resolveOfferedModelIds,
  UCLAW_CLOUD_FALLBACK_CURATION,
  UCLAW_CLOUD_FALLBACK_IMAGE_MODEL,
} from '../../electron/services/providers/uclaw-cloud-curation';

/**
 * 规范（虾盘云《系统不变量与开发规范》三之二）：
 *   真相源是注册表；推荐看 featured；能调什么问 /v1/models；
 *   价格问 /api/pricing，查不到就不显示。
 */
describe('模型策展', () => {
  it('兜底清单只存 id —— 不存 label / 价格 / 上下文长度', () => {
    for (const entry of UCLAW_CLOUD_FALLBACK_CURATION) {
      expect(typeof entry).toBe('string');
    }
    expect(typeof UCLAW_CLOUD_FALLBACK_IMAGE_MODEL).toBe('string');
  });

  it('能拉到注册表时按 featured 排序，text 和 image 分开', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        models: [
          { id: 'b-text', kind: 'text', status: 'active', featured: 2 },
          { id: 'the-image', kind: 'image', status: 'active', featured: 8 },
          { id: 'a-text', kind: 'text', status: 'active', featured: 1 },
          { id: 'not-featured', kind: 'text', status: 'active', featured: null },
        ],
      }),
    })) as unknown as typeof fetch);

    const curated = await fetchCuratedModels('https://pay.test');

    expect(curated?.chat).toEqual(['a-text', 'b-text']);
    expect(curated?.image).toBe('the-image');
    vi.unstubAllGlobals();
  });

  it('下架的（status != active）不进清单 —— 契约模型只重新指向，不该再推', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        models: [
          { id: 'alive', kind: 'text', status: 'active', featured: 1 },
          { id: 'gone', kind: 'text', status: 'missing', featured: 2 },
        ],
      }),
    })) as unknown as typeof fetch);

    expect((await fetchCuratedModels('https://pay.test'))?.chat).toEqual(['alive']);
    vi.unstubAllGlobals();
  });

  it('假 200 要认出来 —— SPA catch-all 会用 200 + text/html 回一切未知路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      json: async () => {
        throw new Error('不该走到这里');
      },
    })) as unknown as typeof fetch);

    expect(await fetchCuratedModels('https://pay.test')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('拉不到就返回 null，让调用方走兜底', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch);

    expect(await fetchCuratedModels('https://pay.test')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('策展 ∩ 目录，保持策展顺序（不是目录顺序）', () => {
    const curated = ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen-plus'];
    const available = ['qwen-plus', 'gpt-4o', 'deepseek-v4-flash'];

    const offered = resolveOfferedModelIds(curated, available);

    expect(offered).toEqual(['deepseek-v4-flash', 'qwen-plus']);
    // 目录里有但没被策展的不进下拉 —— 服务端 200 多个模型全塞进去没法用
    expect(offered).not.toContain('gpt-4o');
  });

  it('目录问不到时原样返回策展 —— 一次网络抖动不该抹掉用户买过的模型', () => {
    const curated = fallbackCuratedModels().chat;
    expect(resolveOfferedModelIds(curated, null)).toEqual(curated);
    expect(resolveOfferedModelIds(curated, [])).toEqual(curated);
    expect(resolveOfferedModelIds(curated, ['完全没听过的'])).toEqual(curated);
  });
});
