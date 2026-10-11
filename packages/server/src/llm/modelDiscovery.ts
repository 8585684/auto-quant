/**
 * **模型自动发现与自动分档** —— 让系统在模型变化时自己跟上，不靠人维护。
 *
 * ## 用户的原话（这是本模块存在的全部理由）
 *
 * > 「例如现在我添加到 magpie 里面的 OpenCode Zen Free 供应商，里面模型基本都是免费不限量
 * >  供应使用，但是**时效性不固定**，万一今天能用，明天不能用、改了名字或者限量了，
 * >  又或者**突然上线了什么模型**（假如系统运行中这个提供商增加了一个模型，很好用智商高，
 * >  **系统是否会自动发现，自动调研判断模型档次，然后应用到相应的智能体中**）……
 * >  那么系统如何保证能不中断，能正常用」
 * >
 * > 「现在这么多模型，哪些不限量使用，哪些是限量的，其实**不用你手动探测，
 * >  你去 magpie 里面看，上面应该有些会标注**」
 *
 * ## 实测数据源（两个，缺一不可）
 *
 * | 来源 | 有什么 | 缺什么 |
 * |---|---|---|
 * | `GET /v1/models`（运行时可达）| context / max_output / **reasoning** / **supported_reasoning_levels** / modalities | **没有 `free`、没有 `cost`** |
 * | `plugin-providers.json`（配置文件）| **`free`** / **`rate`** / **`cost`** / `released` / `variants` / `fast` | 需要读文件 |
 *
 * **所以必须合并两处** —— 只用 `/v1/models` 就分不出"免费还是烧积分"，
 * 而那正是用户要的"合理安排使用"的依据。
 */

import { readFileSync } from 'node:fs';

/** 从 magpie 发现的原始模型信息（两处数据合并后）。 */
export interface DiscoveredModel {
  /** magpie 上的调用 id（`provider/model` 或 `group/auto-*`）。 */
  id: string;
  displayName: string;
  /** 供应商 id（`owned_by` 或 id 前缀）。 */
  provider: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** 是否思维链模型 —— **决定输出预算要放大几倍**（实测：不放大就得到 content=null）。 */
  reasoning: boolean;
  /** 支持的思考等级（如 `['low','high','max']`）。空数组 = 不支持指定等级。 */
  reasoningLevels: string[];
  /** 是否支持图片输入。 */
  image: boolean;
  /**
   * **是否免费/不限量**。
   *
   * `true` = 用户说的"免费不限量供应"；`false` = 要消耗积分/额度；
   * `null` = **不知道**（`plugin-providers.json` 里没有这条）。
   *
   * ⚠️ **`null` 与 `false` 是两件事**：`false` 是"查到了，要收费"，
   * `null` 是"没查到"。混为一谈会让新上线的免费模型被当成付费的而排到最后。
   */
  free: boolean | null;
  /** 消耗费率（`rate`）；`null` = 不知道。 */
  rate: number | null;
  /** 发布日期（`released`）；空字符串 = 未知。用于判断"是不是新上线的"。 */
  released: string;
  /** 是否快速档（`fast`）。 */
  fast: boolean;
}

/** `/v1/models` 里一条记录的形状（只声明我们用到的字段）。 */
interface WireModel {
  id?: unknown;
  display_name?: unknown;
  magpie_label?: unknown;
  owned_by?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  reasoning?: unknown;
  supported_reasoning_levels?: unknown;
  modalities?: unknown;
}

/** `plugin-providers.json` 里一条模型的形状。 */
interface PluginModel {
  id?: unknown;
  apiId?: unknown;
  context?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  image?: unknown;
  released?: unknown;
  free?: unknown;
  rate?: unknown;
  cost?: unknown;
  fast?: unknown;
}

interface PluginProvider {
  id?: unknown;
  models?: unknown;
}

/** 数值转换，非法值给默认。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 从 `/v1/models` 的响应体解析出基础信息。 */
export function parseWireModels(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const m = raw as WireModel;
    if (typeof m.id !== 'string' || m.id.length === 0) continue;
    const provider =
      typeof m.owned_by === 'string' && m.owned_by.length > 0
        ? m.owned_by
        : m.id.includes('/')
          ? m.id.split('/')[0]!
          : 'unknown';
    const levels: string[] = [];
    if (Array.isArray(m.supported_reasoning_levels)) {
      for (const lv of m.supported_reasoning_levels) {
        const effort = (lv as { effort?: unknown })?.effort;
        if (typeof effort === 'string') levels.push(effort);
      }
    }
    const modalities = m.modalities as { input?: unknown } | undefined;
    const image = Array.isArray(modalities?.input) && modalities.input.includes('image');
    out.push({
      id: m.id,
      displayName: typeof m.display_name === 'string' ? m.display_name : m.id,
      provider,
      contextTokens: num(m.context_length ?? m.context_window ?? m.max_input_tokens),
      maxOutputTokens: num(m.max_output_tokens),
      reasoning: m.reasoning === true,
      reasoningLevels: levels,
      image,
      /* 这两列要等合并 plugin-providers 才知道。 */
      free: null,
      rate: null,
      released: '',
      fast: false,
    });
  }
  return out;
}

/**
 * 从 `plugin-providers.json` 解析出"限量/不限量"等**只在配置里才有**的信息。
 *
 * 返回 `provider/model → { free, rate, released, fast }` 的映射。
 * key 用 `provider/model` 形式，与 `/v1/models` 的 id 对齐（`group/auto-*` 另算）。
 */
export function parsePluginLimits(payload: unknown): Map<string, { free: boolean | null; rate: number | null; released: string; fast: boolean }> {
  const map = new Map<string, { free: boolean | null; rate: number | null; released: string; fast: boolean }>();
  const providers = Array.isArray(payload) ? payload : ((payload as { providers?: unknown })?.providers ?? []);
  if (!Array.isArray(providers)) return map;

  for (const raw of providers) {
    const p = raw as PluginProvider;
    const providerId = typeof p.id === 'string' ? p.id : null;
    if (!providerId || !Array.isArray(p.models)) continue;
    for (const rawModel of p.models) {
      const m = rawModel as PluginModel;
      const modelId = typeof m.apiId === 'string' && m.apiId.length > 0
        ? m.apiId
        : typeof m.id === 'string'
          ? m.id
          : null;
      if (!modelId) continue;
      map.set(`${providerId}/${modelId}`, {
        free: typeof m.free === 'boolean' ? m.free : null,
        rate: typeof m.rate === 'number' && Number.isFinite(m.rate) ? m.rate : null,
        released: typeof m.released === 'string' ? m.released : '',
        fast: m.fast === true,
      });
    }
  }
  return map;
}

/**
 * 合并两处数据。
 *
 * ## 为什么 `group/auto-*` 要单独处理
 *
 * 实测：`group/auto-gpt-6-astra` 这类**路由组**的 id 与 `plugin-providers.json` 里的
 * 模型名对不上（后者是 `gpt-6-astra`，没有 `group/auto-` 前缀）。
 * 而组恰恰是最该用的调用入口（magpie 在多个供应商提供同名模型时自动建组，
 * 组内自带故障转移）。
 *
 * 所以：**组的免费属性按"它的成员"推断** —— 若同名模型在配置里全是 free，
 * 组就是 free；有任何一个是付费的，就标 `false`（保守）。
 */
export function mergeDiscovered(
  wire: readonly DiscoveredModel[],
  limits: Map<string, { free: boolean | null; rate: number | null; released: string; fast: boolean }>,
): DiscoveredModel[] {
  /* 先按"模型名"（去掉 provider 前缀）索引免费信息，供组推断使用。 */
  const byModelName = new Map<string, Array<{ free: boolean | null; rate: number | null; released: string; fast: boolean }>>();
  for (const [key, value] of limits) {
    const modelName = key.slice(key.indexOf('/') + 1);
    const list = byModelName.get(modelName) ?? [];
    list.push(value);
    byModelName.set(modelName, list);
  }

  return wire.map((m) => {
    /* ① 精确匹配 `provider/model`。 */
    const exact = limits.get(m.id);
    if (exact) return { ...m, ...exact };

    /* ② 路由组：`group/auto-<name>` → 用 `<name>` 的成员信息推断。 */
    if (m.id.startsWith('group/auto-')) {
      const name = m.id.slice('group/auto-'.length);
      const members = byModelName.get(name) ?? [];
      if (members.length > 0) {
        /*
         * 全部成员免费 → 组免费；只要有一个付费 → 标 false。
         * **保守**：宁可把免费组当付费的（少用它），也不要把付费的当免费的（烧额度）。
         */
        const allFree = members.every((x) => x.free === true);
        const anyKnown = members.some((x) => x.free !== null);
        const bestRate = members.reduce<number | null>((min, x) => {
          if (x.rate === null) return min;
          return min === null ? x.rate : Math.min(min, x.rate);
        }, null);
        return {
          ...m,
          free: anyKnown ? allFree : null,
          rate: bestRate,
          released: members.map((x) => x.released).filter(Boolean).sort().pop() ?? '',
          fast: members.some((x) => x.fast),
        };
      }
    }
    return m;
  });
}

/**
 * **自动分档** —— 把发现的模型映射到能力档位。
 *
 * ## 为什么用启发式而不是查表
 *
 * 用户要求"自动调研判断模型档次"。**做不到真正测量智商**（那需要跑基准测试，
 * 代价极高且会随版本漂移），所以这里用**可观测的代理指标**。
 *
 * ## 阈值是怎么定的（第一版太宽松，实测后收紧）
 *
 * 第一版用 `reasoning && maxOutputTokens >= 64_000` 判 T3，结果 **72 个模型里
 * 59 个进了 T3** —— 因为现代模型的输出上限普遍很大（`group/*` 动辄 128k+），
 * 于是"顶级推理"这个档位失去了区分度，等于没分。
 *
 * 收紧后的判据（每条都对应一个可观测事实）：
 *
 * | 条件 | 档位 | 理由 |
 * |---|---|---|
 * | `fast === true` | **T1** | 供应商自己标了"快"，不跟它争 |
 * | `reasoning === false` | **T1** | 不会思考 = 体力活（打标、摘要、字段映射）|
 * | `reasoning` 且（输出 ≥128k **或** 思考等级 ≥4 档）| **T3** | 能写长报告 / 提供了丰富的思考级别 = 旗舰 |
 * | 其余 `reasoning` | **T2** | 会思考但输出能力一般 = 主力分析 |
 *
 * ⚠️ **这仍然只是"初判"**：真正的档位由运行期的**实测延迟与成功率**修正
 *（见 `ModelHealthRegistry`）。启发式只负责"新模型上线时先给它一个合理位置"，
 * 避免"新模型没人用"或"新模型被当成顶级模型去辩论"。
 */
export function inferTier(m: DiscoveredModel): 'T1_fast' | 'T2_mid' | 'T3_deep' {
  /* 供应商自己标了"快"—— 尊重它，不进推理档。 */
  if (m.fast) return 'T1_fast';

  /* 不会思考就是体力活。 */
  if (!m.reasoning) return 'T1_fast';

  /*
   * 旗舰判据：能写长报告（输出 ≥128k）**或**给了丰富的思考等级（≥4 档）。
   *
   * 实测佐证：`group/auto-gpt-6-astra` 报了 **6 档**
   *（low/medium/high/xhigh/max/ultra），而普通思考模型只报 2–3 档 ——
   * "愿意暴露更多思考级别"本身就是能力强的一个信号。
   */
  const bigOutput = m.maxOutputTokens >= 128_000;
  const richLevels = m.reasoningLevels.length >= 4;
  if (bigOutput || richLevels) return 'T3_deep';

  return 'T2_mid';
}

/** 发现结果 + 分档，供 `modelCatalog` 动态构建候选链。 */
export interface DiscoveredCatalog {
  models: DiscoveredModel[];
  /** 档位 → 模型 id 列表（按"免费优先 + 上下文能力"排序）。 */
  byTier: Record<'T1_fast' | 'T2_mid' | 'T3_deep', string[]>;
  /** 发现时刻（epoch ms）。 */
  discoveredAt: number;
  /** 这一轮发现里的新面孔（相对上一次），用于"自动发现新模型"。 */
  appeared: string[];
  /** 这一轮消失的模型（相对上一次），用于告警。 */
  disappeared: string[];
}

/**
 * 从两个数据源构建目录。
 *
 * @param wirePayload `GET /v1/models` 的响应体
 * @param pluginProvidersPath `plugin-providers.json` 的路径；读不到时降级为"只有基础信息"
 * @param previous 上一次的目录（用于算 `appeared` / `disappeared`）
 */
export function buildCatalog(
  wirePayload: unknown,
  pluginProvidersPath: string | null,
  previous?: DiscoveredCatalog | null,
): DiscoveredCatalog {
  const wire = parseWireModels(wirePayload);
  let limits = new Map<string, { free: boolean | null; rate: number | null; released: string; fast: boolean }>();
  if (pluginProvidersPath !== null) {
    try {
      limits = parsePluginLimits(JSON.parse(readFileSync(pluginProvidersPath, 'utf8')));
    } catch {
      /* 读不到配置不是致命错误 —— 只是分不出免费/付费（`free` 保持 null）。 */
      limits = new Map();
    }
  }
  const models = mergeDiscovered(wire, limits);

  const byTier: DiscoveredCatalog['byTier'] = { T1_fast: [], T2_mid: [], T3_deep: [] };
  for (const m of models) {
    /* 路由组也进候选链 —— 它自带 magpie 的组内故障转移。 */
    byTier[inferTier(m)].push(m.id);
  }
  /*
   * 排序：免费优先（不限量、可长期依赖）→ 上下文大 → id 稳定。
   * **这就是"合理安排使用"**：体力活先用免费的，把付费额度留给真正需要的判断。
   */
  const freeOf = new Map(models.map((m) => [m.id, m.free]));
  const ctxOf = new Map(models.map((m) => [m.id, m.contextTokens]));
  for (const tier of Object.keys(byTier) as Array<keyof typeof byTier>) {
    byTier[tier].sort((a, b) => {
      const fa = freeOf.get(a) === true ? 0 : 1;
      const fb = freeOf.get(b) === true ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (ctxOf.get(b) ?? 0) - (ctxOf.get(a) ?? 0);
    });
  }

  const prevIds = new Set((previous?.models ?? []).map((m) => m.id));
  const nowIds = new Set(models.map((m) => m.id));

  return {
    models,
    byTier,
    discoveredAt: Date.now(),
    appeared: previous ? models.filter((m) => !prevIds.has(m.id)).map((m) => m.id) : [],
    disappeared: previous ? [...prevIds].filter((id) => !nowIds.has(id)) : [],
  };
}
