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

/** 单个**成员**（某个供应商上的某个模型）的限额事实 —— 这里是布尔，因为成员是确定的。 */
export interface MemberLimit {
  free: boolean | null;
  rate: number | null;
  released: string;
  fast: boolean;
}
type MemberLimits = Map<string, MemberLimit>;

/**
 * 免费状态。
 *
 * - `all`     —— 全部成员免费（**放心当体力活主力用**）
 * - `some`    —— 部分成员免费（有机会不烧额度，但可能被路由到付费成员）
 * - `none`    —— 全部付费
 * - `unknown` —— 配置里查不到（**不是付费**，只是不知道）
 */
export type FreeStatus = 'all' | 'some' | 'none' | 'unknown';

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
   * **免费状态** —— 四态，不是布尔。
   *
   * ## 为什么必须是四态（实测逼出来的）
   *
   * `deepseek-v4.1-flash` 这个模型在 magpie 里有 **8 个成员**，
   * 其中**只有 `workbuddy-ai` 那一个是免费**的，其余 7 个都要额度：
   *
   *     workbuddy-ai  deepseek-v4.1-flash      free=true    ← 不限量
   *     workbuddy-ai  deepseek-v4.1-flash-sg   free=false   rate=0.03
   *     workbuddy     deepseek-v4.1-flash      free=false
   *     cline / factory / devin …              free=false
   *
   * 所以网关上的 `group/auto-deepseek-v4-1-flash` **既不是"免费"也不是"付费"**
   * —— 它**有一部分免费容量**（magpie 的 smart 路由会优先用有额度的成员）。
   *
   * 用布尔表示只能二选一，两种都错：
   *   · 判 `true` → 以为不烧额度，实际可能被路由到付费成员（**烧钱**）；
   *   · 判 `false` → 完全避开它，**白白放弃一个不限量的通道**（用户明确说这个不限量）。
   *
   * 所以分四态，并且**`unknown` 与 `none` 绝不合并**（`unknown` 是"没查到"，
   * 合并会让新上线的免费模型被当成付费的而排到最后）。
   */
  free: FreeStatus;
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
      /* 这两列要等合并 plugin-providers 才知道 —— 先用 `unknown`（**不是 `none`**）。 */
      free: 'unknown' as FreeStatus,
      rate: null,
      released: '',
      fast: false,
    });
  }
  return out;
}

/**
 * **模型名归一化**（用于跨来源匹配）。
 *
 * ## 为什么必须归一化（实测踩到的坑）
 *
 * magpie 暴露的路由组 id 与 `plugin-providers.json` 里的模型名**写法不一致**：
 *
 *     网关暴露：`group/auto-deepseek-v4-1-flash`   ← 全是连字符
 *     配置文件：`deepseek-v4.1-flash`              ← 中间是点
 *
 * 实测后果：组的免费属性匹配不上成员，`group/auto-deepseek-v4-1-flash`
 * 被误判成 `free=false`（付费），而用户明确说它**不限量**
 *（原话：「WorkBuddy AI 提供商里面的 Deepseek-V4.1-Flash 就是不限量无限使用」）。
 *
 * 误判的代价很实在：一个不限量的模型被当成烧额度的，于是**体力活不敢用它**，
 * 白白消耗珍贵的付费额度 —— 正好与"合理安排使用"的目标相反。
 *
 * 所以把 `.` `_` 统一成 `-`、转小写、压掉重复分隔符再比。
 */
function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 从 `plugin-providers.json` 解析出"限量/不限量"等**只在配置里才有**的信息。
 *
 * 返回归一化后的 `provider/model → { free, rate, released, fast }` 映射。
 */
export function parsePluginLimits(payload: unknown): MemberLimits {
  const map: MemberLimits = new Map();
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
      map.set(`${providerId}/${normalizeModelName(modelId)}`, {
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
  limits: MemberLimits,
): DiscoveredModel[] {
  /* 先按"模型名"（去掉 provider 前缀、归一化）索引免费信息，供组推断使用。 */
  const byModelName = new Map<string, MemberLimit[]>();
  for (const [key, value] of limits) {
    const slash = key.indexOf('/');
    const modelName = slash >= 0 ? key.slice(slash + 1) : key;
    const list = byModelName.get(modelName) ?? [];
    list.push(value);
    byModelName.set(modelName, list);
  }

  return wire.map((m) => {
    const slash = m.id.indexOf('/');
    const providerPart = slash >= 0 ? m.id.slice(0, slash) : '';
    const modelPart = slash >= 0 ? m.id.slice(slash + 1) : m.id;

    /* ① 精确匹配（**归一化后**比 —— magpie 会用 `-` 替换 `.`）。 */
    const exact = limits.get(`${providerPart}/${normalizeModelName(modelPart)}`);
    if (exact) {
      return {
        ...m,
        free: exact.free === true ? 'all' : exact.free === false ? 'none' : 'unknown',
        rate: exact.rate,
        released: exact.released,
        fast: exact.fast,
      };
    }

    /* ② 路由组：`group/auto-<name>` → 用 `<name>` 的成员信息推断。 */
    if (m.id.startsWith('group/auto-')) {
      const name = normalizeModelName(m.id.slice('group/auto-'.length));
      const members = byModelName.get(name) ?? [];
      if (members.length > 0) {
        /*
         * 全部成员免费 → 组免费；只要有一个付费 → 标 false。
         * **保守**：宁可把免费组当付费的（少用它），也不要把付费的当免费的（烧额度）。
         */
        const freeCount = members.filter((x) => x.free === true).length;
        const paidCount = members.filter((x) => x.free === false).length;
        const anyKnown = freeCount + paidCount > 0;
        /*
         * 四态判定：全免费 = `all`；有免费也有付费 = `some`（**有机会不烧额度**）；
         * 全付费 = `none`；一个都没查到 = `unknown`。
         */
        const freeStatus: FreeStatus = !anyKnown
          ? 'unknown'
          : paidCount === 0
            ? 'all'
            : freeCount === 0
              ? 'none'
              : 'some';
        const bestRate = members.reduce<number | null>((min, x) => {
          if (x.rate === null) return min;
          return min === null ? x.rate : Math.min(min, x.rate);
        }, null);
        return {
          ...m,
          free: freeStatus,
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
 * | 名字里有 `flash`/`mini`/… | **T1** | 供应商的命名就是定位声明（实测：`deepseek-v4.1-flash` 输出 128k 但实测 1.5s）|
 * | `reasoning === false` | **T1** | 不会思考 = 体力活（打标、摘要、字段映射）|
 * | `reasoning` 且**思考等级 ≥4 档** | **T3** | 提供了丰富的思考级别 = 旗舰 |
 * | 其余 `reasoning` | **T2** | 会思考但输出能力一般 = 主力分析 |
 *
 * ## ⚠️ 为什么【不用】输出上限判旗舰（这条注释曾经与代码不符）
 *
 * 第一版用「输出 ≥128k」判 T3，后来**去掉了**，但注释没同步删 —— 于是
 * 文档承诺了一条代码不执行的条件（复核发现）。
 *
 * 去掉它的实测理由：现代模型的输出上限普遍很大（`group/*` 动辄 128k+），
 * 用它判 T3 会让 **72 个模型里 59 个进 T3**，档位失去区分度。
 * **"能写长文"与"很聪明"是两件事。**
 *
 * ⚠️ **这仍然只是"初判"**：真正的档位由运行期的**实测延迟与成功率**修正
 *（见 `ModelHealthRegistry`）。启发式只负责"新模型上线时先给它一个合理位置"，
 * 避免"新模型没人用"或"新模型被当成顶级模型去辩论"。
 */
export function inferTier(m: DiscoveredModel): 'T1_fast' | 'T2_mid' | 'T3_deep' {
  /* 供应商自己标了"快"—— 尊重它，不进推理档。 */
  if (m.fast) return 'T1_fast';

  /*
   * **名称信号**：供应商给模型起的名字就是它的定位声明。
   *
   * 加这一条的直接原因是实测：`workbuddy-ai/deepseek-v4.1-flash` 的
   * `max_output_tokens` 是 **128000**，仅凭"输出大"会被判成 T3（旗舰），
   * 而它其实是**最快的那个**（实测 1.5s）—— 名字里的 `flash` 才是真相。
   *
   * **只看输出上限会把"能写长文"误当成"很聪明"**，这两件事无关。
   */
  const name = m.id.toLowerCase().replace(/\./g, '-');
  /*
   * ⚠️ **短词要收窄，否则会误伤**（复核发现 P2-G，已实测）：
   *
   *   误判为 T1：`provider/mini-max`、`provider/mini_pilot`、`a/b_mini_c`、`provider/nano-1`
   *   正确放过：`minimax`、`minimax-m2`、`nanotron-x`、`flashlight`、`fastest-llm`
   *
   * `mini` 后面若接 `max`（无论中间有没有分隔符），那都不是"迷你模型"的意思 ——
   * 所以用 `(?![\-_]?max)` 把 `minimax` 与 `mini-max` **两种写法都排除**。
   *
   * （第一版只写了 `(?!max)`，实测漏掉了 `mini-max` —— 因为它的 `mini` 后面
   *  是 `-` 而不是 `m`。**两种写法都得挡**，否则这种命名一上线就会被塞进快档
   *  去干需要智商的活。）
   */
  if (/(^|[/\-_])(flash|mini(?![\-_]?max)|lite|lightning|turbo|fast|small|nano)([/\-_]|$)/.test(name)) {
    return 'T1_fast';
  }

  /* 不会思考就是体力活。 */
  if (!m.reasoning) return 'T1_fast';

  /*
   * 旗舰判据：给了丰富的思考等级（≥4 档）。
   *
   * 实测佐证：`group/auto-gpt-6-astra` 报了 **6 档**
   *（low/medium/high/xhigh/max/ultra），而普通思考模型只报 2–3 档 ——
   * "愿意暴露更多思考级别"是能力的一个可观测信号，且**比输出上限可靠**
   *（输出上限普遍很大，没有区分度）。
   */
  if (m.reasoningLevels.length >= 4) return 'T3_deep';

  /* 其余会思考的归中档（主力分析）。 */
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
   * ── 排序（**这是实际生效的那一份**）────────────────────────────────────
   *
   * ## ⚠️ 第一版的排序被实测推翻（2026-10-12）
   *
   * 原来是「**免费优先 → 上下文大**」。实测后果很具体：
   *
   * ```
   *   technical（T1 档，本该是体力活）实测耗时 206 秒
   * ```
   *
   * 因为它选中了 `cline/cline-free/mimo-v2.6-flash` —— 一个**思维链模型**。
   * 而"上下文大"这个判据与"快"**毫无关系**（甚至负相关：上下文大的模型
   * 往往更重）。于是体力活被派给了最慢的那一批。
   *
   * ## 现在的口径：**先按"会不会思考"分层，再按免费与上下文**
   *
   * | 档位 | 排序键 |
   * |---|---|
   * | **T1**（体力活）| **不会思考的优先** → 免费 → 上下文 |
   * | **T2**（分析）| 免费 → 不会思考的优先 → 上下文 |
   * | **T3**（判断）| 会思考的优先 → 上下文（免费只是加分）|
   *
   * 为什么 T1 把"不会思考"放第一位：思维链模型在打标/摘要这类活上**既慢
   * 又容易被自己的推理带偏**（实测它们会把"我先去取数"写进输出）。
   * 而 T1 的工作量最大（每轮 4 个分析师），它的速度**直接决定整轮耗时**。
   */
  const freeOf = new Map(models.map((m) => [m.id, m.free]));
  const ctxOf = new Map(models.map((m) => [m.id, m.contextTokens]));
  const reasoningOf = new Map(models.map((m) => [m.id, m.reasoning]));

  /* `all`（全免费）→ `some`（有免费容量）→ `unknown` → `none`。 */
  const rank: Record<FreeStatus, number> = { all: 0, some: 1, unknown: 2, none: 3 };

  for (const tier of Object.keys(byTier) as Array<keyof typeof byTier>) {
    byTier[tier].sort((a, b) => {
      const ra = reasoningOf.get(a) === true ? 1 : 0;
      const rb = reasoningOf.get(b) === true ? 1 : 0;
      const fa = rank[freeOf.get(a) ?? 'unknown'];
      const fb = rank[freeOf.get(b) ?? 'unknown'];

      if (tier === 'T1_fast') {
        /* 体力活：**速度优先** —— 不会思考的排前面。 */
        if (ra !== rb) return ra - rb;
        if (fa !== fb) return fa - fb;
      } else if (tier === 'T2_mid') {
        /* 分析：免费与速度并重。 */
        if (fa !== fb) return fa - fb;
        if (ra !== rb) return ra - rb;
      } else {
        /* T3：**能力优先** —— 会思考的排前面（质量直接决定盈亏）。 */
        if (ra !== rb) return rb - ra;
        if (fa !== fb) return fa - fb;
      }
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
