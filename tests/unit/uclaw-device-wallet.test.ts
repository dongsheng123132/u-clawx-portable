import { describe, expect, it, vi } from 'vitest';

import {
  adoptDeviceKey,
  createMemoryDeviceWalletStore,
  ensureDeviceKey,
  KEY_KIND_RANDOM,
  resetLocalDeviceWallet,
  rotateDeviceKey,
} from '../../electron/services/uclaw-device-wallet';

// 端点探测会打真网。钉死成固定 base，测试才是确定性的。
vi.mock('../../electron/services/providers/uclaw-cloud-endpoint', () => ({
  detectBestEndpoint: async () => ({ apiBase: 'https://pay.test/v1', payBase: 'https://pay.test', origin: 'cn' }),
  UCLAW_CLOUD_DEFAULT_PAY_BASE: 'https://pay.test',
  UCLAW_CLOUD_FALLBACK_PAY_BASE: 'https://pay.test',
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}));

type Route = { status: number; body: Record<string, unknown> };

/** 按「路径 → 响应」编排一个假 pay-server，并记下调用顺序。 */
function fakeServer(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const next = routes[path];
    if (!next) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const alwaysValid = async () => true;
const neverValid = async () => false;
const unreachable = (async () => {
  throw new Error('ENETUNREACH');
}) as unknown as typeof fetch;

describe('ensureDeviceKey', () => {
  it('全新机器 → 绑一个钱包', async () => {
    const store = createMemoryDeviceWalletStore();
    const { fetchImpl, calls } = fakeServer({
      '/device/bind': { status: 200, body: { walletId: 'wal_1', apiKey: 'sk-new' } },
    });

    const r = await ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-new');
    expect(r.walletId).toBe('wal_1');
    expect(calls).toEqual(['/device/bind']);
    expect((await store.get()).keyKind).toBe(KEY_KIND_RANDOM);
  });

  it('已有钱包 → 一个网络请求都不发', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-existing', keyKind: KEY_KIND_RANDOM, walletId: 'wal_9' });
    const { fetchImpl, calls } = fakeServer({});

    const r = await ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-existing');
    expect(calls).toEqual([]);
  });

  it('并发首启只 bind 一次，不能让两次收敛互相覆盖', async () => {
    const store = createMemoryDeviceWalletStore();
    let bindCalls = 0;
    const fetchImpl = (async () => {
      bindCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 200,
        json: async () => ({ walletId: 'wal_once', apiKey: 'sk-only-once' }),
      } as Response;
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid }),
      ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid }),
    ]);

    expect(first).toEqual(second);
    expect(first.apiKey).toBe('sk-only-once');
    expect(bindCalls).toBe(1);
  });

  it('网络不通时**不抛异常** —— 一个联网抖动不该让 ClawX 起不来', async () => {
    const store = createMemoryDeviceWalletStore();

    const r = await ensureDeviceKey({ store, fetch: unreachable, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('');
  });

  it('存储自己开不起来时也不抛 —— 抛了会把启动链路带崩', async () => {
    const store = {
      get: async () => {
        throw new Error('EACCES: permission denied');
      },
      set: async () => {},
    };

    const r = await ensureDeviceKey({ store, fetch: unreachable, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('');
  });

  it('启动时把上次没走完的 rotate 收尾', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      pendingKey: 'sk-staged',
      pendingKind: 'rotate',
      pendingFrom: 'sk-old',
    });
    const { fetchImpl, calls } = fakeServer({
      '/device/rotate/commit': { status: 200, body: {} },
    });

    const r = await ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-staged');
    expect(calls).toEqual(['/device/rotate/commit']);
  });

  it('pendingKind 不认识时**不猜** —— 猜错会打到另一条链路上', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      pendingKey: 'sk-staged',
      pendingKind: '',
      pendingFrom: 'sk-old',
    });
    const { fetchImpl, calls } = fakeServer({ '/device/rotate/commit': { status: 200, body: {} } });

    const r = await ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-old');
    expect(calls).toEqual([]);
  });
});

describe('rotateDeviceKey', () => {
  it('mint → 验通 → commit，旧 key 换掉', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-old', keyKind: KEY_KIND_RANDOM });
    const { fetchImpl, calls } = fakeServer({
      '/device/rotate': { status: 200, body: { apiKey: 'sk-rotated' } },
      '/device/rotate/commit': { status: 200, body: {} },
    });

    const r = await rotateDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-rotated');
    expect(calls).toEqual(['/device/rotate', '/device/rotate/commit']);
  });

  it('新 key 验不过时抛错，且旧 key 原封不动', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-old', keyKind: KEY_KIND_RANDOM });
    const { fetchImpl, calls } = fakeServer({
      '/device/rotate': { status: 200, body: { apiKey: 'sk-rotated' } },
      '/device/rotate/commit': { status: 200, body: {} },
    });

    await expect(rotateDeviceKey({ store, fetch: fetchImpl, verifyKey: neverValid })).rejects.toThrow();
    expect(calls).not.toContain('/device/rotate/commit');
    expect((await store.get()).key).toBe('sk-old');
  });

  it('重试时不再 mint 第二把 —— 否则每失败一次就在服务端多留一把悬空 key', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      pendingKey: 'sk-staged',
      pendingKind: 'rotate',
      pendingFrom: 'sk-old',
    });
    const { fetchImpl, calls } = fakeServer({
      '/device/rotate': { status: 200, body: { apiKey: 'sk-should-not-be-used' } },
      '/device/rotate/commit': { status: 200, body: {} },
    });

    const r = await rotateDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-staged');
    expect(calls).not.toContain('/device/rotate');
  });

  it('还没有钱包的机器，拒绝轮换而不是假装成功', async () => {
    const store = createMemoryDeviceWalletStore();
    const { fetchImpl } = fakeServer({});

    await expect(rotateDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid })).rejects.toThrow();
  });
});

describe('adoptDeviceKey', () => {
  it('验通了才落盘', async () => {
    const store = createMemoryDeviceWalletStore();

    const r = await adoptDeviceKey('sk-someone-elses', { store, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-someone-elses');
    const saved = await store.get();
    expect(saved.key).toBe('sk-someone-elses');
    expect(saved.keyKind).toBe(KEY_KIND_RANDOM);
  });

  it('验不过时**绝不落盘** —— 否则客户得到一台「看着配好了、一发消息就报错」的机器', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-old', keyKind: KEY_KIND_RANDOM });

    await expect(adoptDeviceKey('sk-long-enough-but-invalid', { store, verifyKey: neverValid })).rejects.toThrow('没有保存');
    expect((await store.get()).key).toBe('sk-old');
  });

  it('形状明显不对的直接拒，不白跑一次网络', async () => {
    const store = createMemoryDeviceWalletStore();
    const verify = vi.fn(async () => true);

    await expect(adoptDeviceKey('not-a-key', { store, verifyKey: verify })).rejects.toThrow('sk-');
    await expect(adoptDeviceKey('sk-with space', { store, verifyKey: verify })).rejects.toThrow('空格');
    expect(verify).not.toHaveBeenCalled();
  });

  it('填进来的 key 之后还能被 rotate 换掉', async () => {
    const store = createMemoryDeviceWalletStore();
    await adoptDeviceKey('sk-adopted', { store, verifyKey: alwaysValid });

    const { fetchImpl } = fakeServer({
      '/device/rotate': { status: 200, body: { apiKey: 'sk-after' } },
      '/device/rotate/commit': { status: 200, body: {} },
    });
    const r = await rotateDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });

    expect(r.apiKey).toBe('sk-after');
  });
});

describe('resetLocalDeviceWallet', () => {
  it('先清实际消费者，再原子清空五字段；服务端不参与', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      walletId: 'wal_old',
    });
    const order: string[] = [];

    await resetLocalDeviceWallet({
      store,
      beforeClear: async () => {
        order.push(`consumer:${(await store.get()).key}`);
      },
    });

    const saved = await store.get();
    order.push(`wallet:${saved.key}`);
    expect(order).toEqual(['consumer:sk-old', 'wallet:']);
    expect(saved).toMatchObject({
      key: '',
      walletId: '',
      pendingKey: '',
      pendingKind: '',
      pendingFrom: '',
    });
  });

  it('消费者清除失败时本地钱包保持原样，不能假装已移除', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-old', keyKind: KEY_KIND_RANDOM });

    await expect(resetLocalDeviceWallet({
      store,
      beforeClear: async () => { throw new Error('provider clear failed'); },
    })).rejects.toThrow('provider clear failed');

    expect((await store.get()).key).toBe('sk-old');
  });

  it('未知 pending 按 C3 拒绝且一个字段都不改', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      pendingKey: 'sk-unknown',
      pendingKind: 'future-operation',
      pendingFrom: 'sk-old',
    });
    const beforeClear = vi.fn(async () => {});
    const before = await store.get();

    await expect(resetLocalDeviceWallet({ store, beforeClear }))
      .rejects.toThrow('DEVICE_WALLET_UNKNOWN_PENDING');

    expect(beforeClear).not.toHaveBeenCalled();
    expect(await store.get()).toEqual(before);
  });

  it('已知 rotate pending 先收尾，再要求用户针对新 key 重新确认', async () => {
    const store = createMemoryDeviceWalletStore({
      key: 'sk-old',
      keyKind: KEY_KIND_RANDOM,
      pendingKey: 'sk-new',
      pendingKind: 'rotate',
      pendingFrom: 'sk-old',
    });
    const { fetchImpl, calls } = fakeServer({
      '/device/rotate/commit': { status: 200, body: {} },
    });
    const beforeClear = vi.fn(async () => {});

    await expect(resetLocalDeviceWallet({
      store,
      fetch: fetchImpl,
      verifyKey: alwaysValid,
      beforeClear,
    })).rejects.toThrow('DEVICE_WALLET_PENDING_SETTLED');

    expect(calls).toEqual(['/device/rotate/commit']);
    expect(beforeClear).not.toHaveBeenCalled();
    expect((await store.get()).key).toBe('sk-new');

    await resetLocalDeviceWallet({ store, beforeClear });
    expect(beforeClear).toHaveBeenCalledOnce();
    expect((await store.get()).key).toBe('');
  });

  it('移除进行中触发的 ensure 必须等清完再 bind 新空钱包', async () => {
    const store = createMemoryDeviceWalletStore({ key: 'sk-old', keyKind: KEY_KIND_RANDOM });
    let releaseClear!: () => void;
    const clearing = new Promise<void>((resolve) => { releaseClear = resolve; });
    const reset = resetLocalDeviceWallet({ store, beforeClear: () => clearing });
    const { fetchImpl, calls } = fakeServer({
      '/device/bind': { status: 200, body: { walletId: 'wal_new', apiKey: 'sk-fresh' } },
    });

    const ensure = ensureDeviceKey({ store, fetch: fetchImpl, verifyKey: alwaysValid });
    await Promise.resolve();
    expect(calls).toEqual([]);
    releaseClear();

    await reset;
    expect((await ensure).apiKey).toBe('sk-fresh');
    expect(calls).toEqual(['/device/bind']);
  });
});
