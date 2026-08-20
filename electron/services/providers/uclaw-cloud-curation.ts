/**
 * U-Claw 的模型策展 —— **优先问服务端，问不到才用内置兜底清单**。
 *
 * 规范（虾盘云《系统不变量与开发规范》三之二）：
 *
 *   真相源 = 虾盘云的 models/registry.json，其余全是派生物。
 *   这把 key 能调什么   →  /v1/models
 *   多贵                →  /api/pricing（查不到就不显示，不许估、不许写死）
 *   推荐哪几个、什么顺序 →  注册表的 `featured`（带排序号）
 *
 * 注册表里已经有 `featured`（1=首推，依次排）和 `kind`（text/image/video/…），
 * 客户端不该另攒一份 —— 那正是规范里点名的坑：
 * 「U-King 客户端代码 30 处硬编码模型 ID，上游改名就得改 30 处，
 *   漏一处就是一个孤儿 503」。
 *
 * 但对外端点 `/api/models/registry` 目前**还没上线**（models/README 的 TODO
 * 里还是未勾选，实测 /uclaw/registry.json 返回的是 SPA 的 index.html）。
 * 所以这里做成「**能拉就拉，拉不到用兜底**」：
 *   - 服务端哪天把端点发出来 → 客户端自动切过去，**不用发版**
 *   - 在那之前 → 用下面这份按注册表 featured 抄下来的兜底清单
 *
 * 兜底清单**只存 id**（不存 label / 价格 / 上下文长度 —— 那些一定会漂）。
 * 存 id 是安全的：不变量 #11「对外模型 ID 是公开契约，发出去就永不下架，
 * 只能重新指向」。
 */

const REGISTRY_TIMEOUT_MS = 6_000;

/**
 * 兜底策展清单，顺序抄自注册表 `featured`（2026-08-20 快照）。
 *
 * ⚠️ 这是**副本，不是真相源**。改推荐请改虾盘云的 registry.json；
 * 这里只在拉不到服务端时兜底。端点上线后本常量应当删除。
 */
export const UCLAW_CLOUD_FALLBACK_CURATION = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'qwen-plus',
  'deepseek-v4-flash-codex',
  'MiniMax-M3',
  'qwen3.7-flash',
  'kimi-k2.6',
] as const;

/** 图像生成的兜底默认，同样抄自注册表（featured=8 的 image）。 */
export const UCLAW_CLOUD_FALLBACK_IMAGE_MODEL = 'gpt-image-2';

export type CuratedModels = {
  /** 聊天模型，按推荐顺序。 */
  chat: string[];
  /** 图像生成的首选模型。 */
  image: string;
};

type RegistryEntry = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  featured?: unknown;
};

function registryUrl(apiOrigin: string): string {
  return `${apiOrigin}/api/models/registry`;
}

/**
 * 从虾盘云注册表拉策展。拿不到就返回 null，调用方用兜底清单。
 *
 * 刻意做得很挑剔：状态码 200 不代表拿到了东西 —— 实测 SPA 的 catch-all
 * 路由会用 200 + text/html 回一切未知路径。只认真正解析出模型条目的响应。
 */
export async function fetchCuratedModels(apiOrigin: string): Promise<CuratedModels | null> {
  try {
    const res = await fetch(registryUrl(apiOrigin), {
      signal: typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
        : undefined,
    });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;

    const payload = (await res.json()) as { models?: RegistryEntry[] } | RegistryEntry[];
    const entries = Array.isArray(payload) ? payload : payload?.models;
    if (!Array.isArray(entries) || entries.length === 0) return null;

    const featured = entries
      .filter((m) => typeof m?.id === 'string' && m.id
        && typeof m.featured === 'number'
        && (m.status === undefined || m.status === 'active'))
      .sort((a, b) => (a.featured as number) - (b.featured as number));

    const chat = featured.filter((m) => m.kind === 'text').map((m) => m.id as string);
    const image = featured.find((m) => m.kind === 'image')?.id as string | undefined;
    if (chat.length === 0) return null;

    return { chat, image: image ?? UCLAW_CLOUD_FALLBACK_IMAGE_MODEL };
  } catch {
    return null;
  }
}

/** 拉不到服务端策展时用的兜底。 */
export function fallbackCuratedModels(): CuratedModels {
  return {
    chat: [...UCLAW_CLOUD_FALLBACK_CURATION],
    image: UCLAW_CLOUD_FALLBACK_IMAGE_MODEL,
  };
}

/**
 * 策展 ∩ 服务端目录，保持策展顺序。
 *
 * `available` 为 null 表示 /v1/models 没问到（离线 / 抖动）—— 这时**原样返回
 * 策展清单**，不做过滤：宁可多列一个暂时调不通的，也别因为一次网络抖动
 * 把用户买过的模型从界面上抹掉。
 */
export function resolveOfferedModelIds(curated: string[], available: string[] | null): string[] {
  if (curated.length === 0) return [];
  if (!available || available.length === 0) return [...curated];
  const set = new Set(available);
  const hit = curated.filter((id) => set.has(id));
  return hit.length > 0 ? hit : [...curated];
}
