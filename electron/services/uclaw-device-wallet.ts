import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { getHostAppDataDir, isPortableMode } from '../utils/paths';
import {
  detectBestEndpoint,
  loadUclawCloudEndpointCandidates,
} from './providers/uclaw-cloud-endpoint';

/**
 * 设备钱包 —— 这台机器的虾盘云凭证。
 *
 * 凭证由服务端随机签发（pay-server `/device/bind`），存在 electron-store 里。
 * **不涉及任何硬件指纹**：没有「从硬件算出 key」这回事，所以也不存在
 * 「拿到 U 盘序列号就能算出别人的 key」这种问题。
 *
 * 三个动作：
 *   bind    首次运行 → 拿一个新钱包
 *   rotate  怀疑泄露 → 换一把，旧的当场作废（余额记在钱包上，不记在 key 上）
 *   adopt   换电脑 / 重装 → 把已有 key 填回来
 *
 * rotate 是**两阶段提交**：mint → 只读验证（查订阅状态，不消耗额度）→ commit。
 * 崩在中途，下次启动会把 pending 收尾。
 *
 * 和 U-King 共用同一套服务端，语义与状态机必须一致 —— 服务端是唯一真相源。
 */

const STORE_NAME = 'uclaw-device';
const NETWORK_TIMEOUT_MS = 20_000;

export const KEY_KIND_RANDOM = 'random';
const PENDING_ROTATE = 'rotate';

export type DeviceWalletState = {
  /** 当前该拿去用的凭证。 */
  key: string;
  keyKind: string;
  walletId: string;
  /** 已 mint 但还没生效的新凭证（两阶段提交的中间态）。 */
  pendingKey: string;
  pendingKind: string;
  /**
   * 轮换的源 key。收尾 commit 要用它，**不能靠「当前 key」推** ——
   * 崩在转正之后、commit 之前时，当前 key 已经是新的了。
   */
  pendingFrom: string;
};

const EMPTY_STATE: DeviceWalletState = {
  key: '',
  keyKind: '',
  walletId: '',
  pendingKey: '',
  pendingKind: '',
  pendingFrom: '',
};

type StoreShape = { device?: Partial<DeviceWalletState> };

export interface DeviceWalletStore {
  get(): Promise<DeviceWalletState>;
  set(state: DeviceWalletState): Promise<void>;
}

export function createMemoryDeviceWalletStore(initial?: Partial<DeviceWalletState>): DeviceWalletStore {
  let state: DeviceWalletState = { ...EMPTY_STATE, ...initial };
  return {
    async get() {
      return { ...state };
    },
    async set(next) {
      state = { ...next };
    },
  };
}

let persistentStorePromise: Promise<DeviceWalletStore> | null = null;
let persistentEnsurePromise: Promise<WalletResult> | null = null;
const ensurePromisesByStore = new WeakMap<DeviceWalletStore, Promise<WalletResult>>();
let persistentResetPromise: Promise<{ message: string }> | null = null;
const resetPromisesByStore = new WeakMap<DeviceWalletStore, Promise<{ message: string }>>();

async function createPersistentDeviceWalletStore(): Promise<DeviceWalletStore> {
  const Store = (await import('electron-store')).default;
  // clearInvalidConfig：半截写坏的文件（U 盘拔早了）退化成「还没绑定」，
  // 而不是永远抛异常把启动卡死。
  const store = new Store<StoreShape>({ name: STORE_NAME, clearInvalidConfig: true });
  return {
    async get() {
      return { ...EMPTY_STATE, ...(store.get('device') ?? {}) };
    },
    async set(state) {
      store.set('device', state);
    },
  };
}

async function getPersistentStore(): Promise<DeviceWalletStore> {
  if (!persistentStorePromise) {
    persistentStorePromise = createPersistentDeviceWalletStore();
    // 别缓存一个已经 reject 的 promise：U 盘上文件被临时锁住是常事，
    // 缓存了就等于这次启动之后再也拿不到凭证。
    persistentStorePromise.catch(() => {
      persistentStorePromise = null;
    });
  }
  return persistentStorePromise;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type DeviceResponse = {
  status: number;
  body: { walletId?: string; apiKey?: string; balanceTokens?: number; error?: string; message?: string };
};

async function payBases(): Promise<string[]> {
  const detected = await detectBestEndpoint().catch(() => null);
  return Array.from(new Set([
    detected?.payBase,
    ...loadUclawCloudEndpointCandidates().map((endpoint) => endpoint.payBase),
  ].filter((base): base is string => !!base)));
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 打 pay-server 的设备端点，多个 host 依次试。
 *
 * 4xx 不换 host 重试：那是服务端明确的判决，换个域名再问一遍只会得到同一个
 * 答案。只有网络失败和 5xx 才退到下一个 host。
 */
async function devicePost(
  path: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceResponse> {
  let lastError = 'no endpoint';
  for (const base of await payBases()) {
    try {
      const response = await fetchImpl(joinUrl(base, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as DeviceResponse['body'];
      if (response.status < 500) {
        return { status: response.status, body: body ?? {} };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(`${path} 请求失败：${lastError}`);
}

// ---------------------------------------------------------------------------

export type WalletResult = {
  /** 该拿去配 provider 的凭证。拿不到时是空串（调用方照旧放行）。 */
  apiKey: string;
  walletId: string;
};

export type LegacyWalletDiscovery =
  | { status: 'none' }
  | { status: 'candidate'; key: string; walletId: string }
  | { status: 'blocked'; reason: 'invalid' | 'pending' };

export type WalletDeps = {
  store?: DeviceWalletStore;
  fetch?: typeof fetch;
  /** 只读校验一把 key 是否真的可用。默认查订阅状态 —— **不消耗额度**。 */
  verifyKey?: (apiKey: string) => Promise<boolean>;
  /** 测试注入；生产默认只读检查宿主机旧版 `%APPDATA%/clawx` 钱包。 */
  discoverLegacyWallet?: () => Promise<LegacyWalletDiscovery>;
  /** 仅供用户明确点“创建新钱包”后绕过旧钱包保护。 */
  allowFreshBind?: boolean;
};

/** 导出仅为可测：判定「这个旧文件算不算发现了旧钱包」是纯函数，但结论决定
 *  首启到底绑不绑钱包，值得单独锁住。 */
export function parseLegacyWallet(raw: string): LegacyWalletDiscovery {
  try {
    const parsed = JSON.parse(raw) as StoreShape;
    const state = { ...EMPTY_STATE, ...(parsed.device ?? {}) };
    if (state.pendingKey) return { status: 'blocked', reason: 'pending' };
    const key = String(state.key ?? '').trim();
    // 文件在、但一把凭证都没有 —— 没东西可导入，也没有余额会被抢走，所以按
    // “没有旧钱包”处理，让首启照常绑一把新的。
    //
    // 这不是吹毛求疵：任何跑过一次非便携版 ClawX 的电脑，都会在
    // `%APPDATA%/clawx/uclaw-device.json` 留下一个只有 `device` 空壳、没有 key
    // 的文件。之前把它也算作“发现旧钱包”，便携版就永远停在等用户确认的状态 ——
    // 既不绑新的，又根本没有东西可导入，用户看到的就是“密钥用不了”。
    if (!key) return { status: 'none' };
    // 有 key 但形状不对：可能是一把被写坏的真凭证，背后挂着真余额。这种情况
    // 继续挡住自动 bind —— 宁可让用户手工处置，也不要在旁边悄悄开一个竞争钱包。
    if (!key.startsWith('sk-') || key.length < 8 || /\s/.test(key)) {
      return { status: 'blocked', reason: 'invalid' };
    }
    return { status: 'candidate', key, walletId: String(state.walletId ?? '') };
  } catch {
    return { status: 'blocked', reason: 'invalid' };
  }
}

/**
 * 只读发现旧版宿主机钱包。只在便携模式启用；不会复制、改写或删除旧文件。
 * 文件存在但损坏/有 pending 时也要暂停自动 bind，避免悄悄创建竞争钱包。
 */
export async function discoverLegacyDeviceWallet(): Promise<LegacyWalletDiscovery> {
  if (!isPortableMode()) return { status: 'none' };
  const legacyPath = join(getHostAppDataDir(), 'clawx', `${STORE_NAME}.json`);
  try {
    return parseLegacyWallet(await readFile(legacyPath, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      logger.warn('[uclaw-device] 读取旧钱包失败，暂停自动创建新钱包:', code || 'unknown');
      return { status: 'blocked', reason: 'invalid' };
    }
    return { status: 'none' };
  }
}

async function discoverLegacyForEnsure(deps: WalletDeps): Promise<LegacyWalletDiscovery> {
  if (deps.discoverLegacyWallet) return deps.discoverLegacyWallet();
  // 显式 store 是单测/隔离调用，不应意外读取开发机真实 AppData。
  if (deps.store) return { status: 'none' };
  return discoverLegacyDeviceWallet();
}

/**
 * 首启收敛：有钱包就用，没有就绑一个；顺带把上次没走完的 rotate 收尾。
 *
 * **绝不抛异常**：拿不到凭证时返回空串，调用方照旧放行（用户还能手动配模型）。
 * 一个联网抖动不该让 ClawX 起不来。
 */
export function ensureDeviceKey(deps: WalletDeps = {}): Promise<WalletResult> {
  // C4：首启可能被状态页、模型页和 Gateway 启动链并发触发。它们必须共用
  // 同一次收敛，否则会同时 bind：成功的那次可能被后到的失败/空状态覆盖。
  // 显式注入 store 的测试/调用方按 store 去重；生产持久化路径用单例去重。
  if (deps.store) {
    const resetting = resetPromisesByStore.get(deps.store);
    if (resetting) return resetting.then(() => ensureDeviceKey(deps));
    const running = ensurePromisesByStore.get(deps.store);
    if (running) return running;

    const task = doEnsureDeviceKey(deps).finally(() => {
      if (ensurePromisesByStore.get(deps.store!) === task) {
        ensurePromisesByStore.delete(deps.store!);
      }
    });
    ensurePromisesByStore.set(deps.store, task);
    return task;
  }

  if (persistentResetPromise) return persistentResetPromise.then(() => ensureDeviceKey(deps));
  if (persistentEnsurePromise) return persistentEnsurePromise;
  const task = doEnsureDeviceKey(deps).finally(() => {
    if (persistentEnsurePromise === task) persistentEnsurePromise = null;
  });
  persistentEnsurePromise = task;
  return task;
}

async function doEnsureDeviceKey(deps: WalletDeps): Promise<WalletResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const verify = deps.verifyKey ?? defaultVerifyKey;

  // 开存储也必须在保护之内：`new Store()` 在目录不可写 / U 盘拔了 /
  // 文件被别的进程锁住时都会抛。抛出去就会把启动链路带崩。
  let store: DeviceWalletStore;
  let state: DeviceWalletState;
  try {
    store = deps.store ?? (await getPersistentStore());
    state = await store.get();
  } catch (error) {
    logger.warn('[uclaw-device] 打不开设备钱包存储:', error);
    return { apiKey: '', walletId: '' };
  }

  try {
    // 上次没走完的先收尾 —— 半途状态每多活一次启动，就多一次
    // 「客户端和服务端谁是对的」的分歧机会。
    if (state.pendingKey) {
      state = await finishPending(state, store, fetchImpl, verify);
    }
    if (state.key) {
      return { apiKey: state.key, walletId: state.walletId };
    }
    if (!deps.allowFreshBind) {
      const legacy = await discoverLegacyForEnsure(deps);
      if (legacy.status !== 'none') {
        logger.info('[uclaw-device] 发现旧版宿主机钱包，等待用户确认后再导入或新建');
        return { apiKey: '', walletId: '' };
      }
    }
    state = await bindFresh(store, fetchImpl);
    return { apiKey: state.key, walletId: state.walletId };
  } catch (error) {
    logger.warn('[uclaw-device] 收敛失败，下次启动重试:', error);
    return { apiKey: state.key, walletId: state.walletId };
  }
}

/** 用户明确放弃导入旧钱包后，才允许创建一个独立的新钱包。 */
export async function createFreshDeviceWallet(deps: WalletDeps = {}): Promise<WalletResult> {
  // 先等可能正在运行的普通收敛结束，再用同一个 in-flight 入口执行一次显式 bind。
  await ensureDeviceKey(deps);
  return ensureDeviceKey({ ...deps, allowFreshBind: true });
}

/** 读取并验证旧钱包，然后走既有 adopt 路径；旧文件始终保持原样。 */
export async function importLegacyDeviceWallet(
  deps: WalletDeps = {},
): Promise<{ apiKey: string; message: string }> {
  const legacy = await discoverLegacyForEnsure(deps);
  if (legacy.status === 'blocked') {
    throw new Error(legacy.reason === 'pending'
      ? 'DEVICE_WALLET_LEGACY_PENDING'
      : 'DEVICE_WALLET_LEGACY_INVALID');
  }
  if (legacy.status !== 'candidate') throw new Error('DEVICE_WALLET_LEGACY_NOT_FOUND');
  return adoptDeviceKey(legacy.key, deps);
}

/** 把 pending 走完：验通新 key → commit → 转正。 */
async function finishPending(
  state: DeviceWalletState,
  store: DeviceWalletStore,
  fetchImpl: typeof fetch,
  verify: (apiKey: string) => Promise<boolean>,
): Promise<DeviceWalletState> {
  const pending = state.pendingKey;
  if (!pending) return state;
  if (state.pendingKind !== PENDING_ROTATE) {
    logger.warn('[uclaw-device] pendingKind 不认识，不猜，等人工');
    return state;
  }

  // 验证走**只读**查询，不消耗额度。验不过就保留现状（旧 key 还能用），下次重试。
  if (!(await verify(pending))) {
    logger.warn('[uclaw-device] 新密钥还没生效，保留旧密钥，下次重试');
    return state;
  }

  const res = await devicePost(
    '/device/rotate/commit',
    { currentKey: state.pendingFrom || state.key, newKey: pending },
    fetchImpl,
  );
  if (res.status !== 200) {
    logger.warn('[uclaw-device] commit 失败，保留旧密钥:', res.status, res.body?.error);
    return state;
  }

  const next: DeviceWalletState = {
    ...state,
    key: pending,
    keyKind: KEY_KIND_RANDOM,
    pendingKey: '',
    pendingKind: '',
    pendingFrom: '',
  };
  await store.set(next);
  return next;
}

/** 绑一个全新的钱包。 */
async function bindFresh(store: DeviceWalletStore, fetchImpl: typeof fetch): Promise<DeviceWalletState> {
  const res = await devicePost('/device/bind', { platform: process.platform, channel: 'clawx' }, fetchImpl);
  if (res.status !== 200 || !res.body.apiKey) {
    throw new Error(`bind 失败：HTTP ${res.status} ${res.body?.error ?? ''}`);
  }
  const next: DeviceWalletState = {
    key: res.body.apiKey,
    keyKind: KEY_KIND_RANDOM,
    walletId: res.body.walletId ?? '',
    pendingKey: '',
    pendingKind: '',
    pendingFrom: '',
  };
  await store.set(next);
  return next;
}

/**
 * 默认的「这把 key 能用吗」：查订阅状态。**只读，不消耗额度** ——
 * 用真实模型调用来验的话，一把 0 余额的新 key 永远验不过。
 */
async function defaultVerifyKey(apiKey: string): Promise<boolean> {
  const endpoint = await detectBestEndpoint();
  const apiBase = endpoint.apiBase;
  try {
    const res = await fetch(joinUrl(apiBase, '/dashboard/billing/subscription'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 换一把凭证。旧的当场作废 —— 余额记在**钱包**上，不记在 key 上。
 *
 * 用在「怀疑 key 泄露了」。失败时抛错让界面显示原因：这是用户主动点的，
 * 静默失败比报错更糟。
 */
export async function rotateDeviceKey(deps: WalletDeps = {}): Promise<{ apiKey: string; message: string }> {
  const store = deps.store ?? (await getPersistentStore());
  const fetchImpl = deps.fetch ?? fetch;
  const verify = deps.verifyKey ?? defaultVerifyKey;
  let state = await store.get();

  if (!state.key) throw new Error('这台机器还没有钱包，先联网启动一次');

  // 上次 mint 过就别再 mint 第二把 —— 重试要续用同一把 pending，
  // 否则每失败一次就在服务端多留一把悬空的 key。
  const pendingBefore = state.pendingKey;
  if (!pendingBefore) {
    const res = await devicePost('/device/rotate', { currentKey: state.key }, fetchImpl);
    if (res.status !== 200 || !res.body.apiKey) {
      throw new Error(`换密钥失败：HTTP ${res.status} ${res.body?.error ?? ''}`);
    }
    state = { ...state, pendingKey: res.body.apiKey, pendingKind: PENDING_ROTATE, pendingFrom: state.key };
    await store.set(state);
  }

  const minted = state.pendingKey;
  const next = await finishPending(state, store, fetchImpl, verify);
  if (next.key === minted) {
    return { apiKey: next.key, message: '已换成新密钥' };
  }
  throw new Error('新密钥还没生效，请稍后重试（旧密钥仍然可用）');
}

/**
 * 填入一把已有的访问密钥（换电脑 / 重装 / 找回老钱包）。
 *
 * 它**不需要任何服务端调用**，除了验一次这把 key 真的能用。凭证的本质是
 * 「一张充值卡」：谁拿着谁能花，服务端认的是卡本身，不关心它躺在哪台机器上。
 * 所以「把 A 电脑的 key 抄到 B 电脑」= 把字符串写进配置，没有第二步。
 *
 * 这也是为什么**不做恢复码**：key 自己就是那张要备份的东西，再包一层
 * 「用来换 key 的码」只是多一个可丢的东西。
 */
export async function adoptDeviceKey(
  key: string,
  deps: WalletDeps = {},
): Promise<{ apiKey: string; message: string }> {
  const store = deps.store ?? (await getPersistentStore());
  const verify = deps.verifyKey ?? defaultVerifyKey;
  const trimmed = (key ?? '').trim();

  if (!trimmed) throw new Error('请先填入密钥');
  // 只做最松的形状检查 —— 真正的判据是下面那次验证。卡格式会误伤：
  // 历史前缀不止一种，官网生成的长度也未必一样。
  if (!trimmed.startsWith('sk-') || trimmed.length < 8) {
    throw new Error('这不像一把虾盘云密钥（应以 sk- 开头）');
  }
  if (/\s/.test(trimmed)) throw new Error('密钥里混进了空格或换行，请重新复制');

  // 唯一的判据：服务端认不认它。**认了才落盘** —— 填错一个字符就静默保存的话，
  // 客户会得到一台「看起来配好了、一发消息就报错」的机器，而报错指向的是模型不是 key。
  if (!(await verify(trimmed))) {
    throw new Error('这把密钥用不了，没有保存');
  }

  const state = await store.get();
  await store.set({
    ...state,
    key: trimmed,
    keyKind: KEY_KIND_RANDOM,
    walletId: '', // 别人的钱包 id 我们不知道，也不需要知道
    pendingKey: '',
    pendingKind: '',
    pendingFrom: '',
  });
  return { apiKey: trimmed, message: '已启用这把密钥' };
}

export type ResetLocalWalletDeps = WalletDeps & {
  /**
   * C5：先清掉真正消费这把 key 的 provider / image relay，再清钱包状态。
   * 回调失败时钱包保持原样，下一次启动仍能重新收敛，不会出现“界面说已移除，
   * Gateway 还在花旧 key”的假成功。
   */
  beforeClear: () => Promise<void>;
};

/**
 * 只移除本机钱包。服务端钱包、旧 key 和余额都不删除；用户以后仍可 adopt 找回。
 *
 * 已知 rotate pending 会先收尾，然后用错误码要求 UI 重新确认，因为用户最初看到并
 * 备份的是旧 key。未知 pending 按 C3 原样保留，绝不猜、绝不硬清。
 */
export function resetLocalDeviceWallet(
  deps: ResetLocalWalletDeps,
): Promise<{ message: string }> {
  if (deps.store) {
    const running = resetPromisesByStore.get(deps.store);
    if (running) return running;
    const ensureBeforeReset = ensurePromisesByStore.get(deps.store);
    const task = doResetLocalDeviceWallet(deps, ensureBeforeReset ?? undefined).finally(() => {
      if (resetPromisesByStore.get(deps.store!) === task) {
        resetPromisesByStore.delete(deps.store!);
      }
    });
    resetPromisesByStore.set(deps.store, task);
    return task;
  }

  if (persistentResetPromise) return persistentResetPromise;
  const ensureBeforeReset = persistentEnsurePromise;
  const task = doResetLocalDeviceWallet(deps, ensureBeforeReset ?? undefined).finally(() => {
    if (persistentResetPromise === task) persistentResetPromise = null;
  });
  persistentResetPromise = task;
  return task;
}

async function doResetLocalDeviceWallet(
  deps: ResetLocalWalletDeps,
  ensureBeforeReset?: Promise<WalletResult>,
): Promise<{ message: string }> {
  await ensureBeforeReset;
  const store = deps.store ?? (await getPersistentStore());
  const fetchImpl = deps.fetch ?? fetch;
  const verify = deps.verifyKey ?? defaultVerifyKey;
  let state = await store.get();

  if (state.pendingKey) {
    if (state.pendingKind !== PENDING_ROTATE) {
      throw new Error('DEVICE_WALLET_UNKNOWN_PENDING');
    }
    const settled = await finishPending(state, store, fetchImpl, verify);
    if (settled.pendingKey) {
      throw new Error('DEVICE_WALLET_PENDING_NOT_SETTLED');
    }
    // 当前 key 已经从用户首次确认时看到的那把变了，必须重新展示并确认。
    throw new Error('DEVICE_WALLET_PENDING_SETTLED');
  }

  await deps.beforeClear();
  await store.set({ ...EMPTY_STATE });
  return { message: '' };
}
