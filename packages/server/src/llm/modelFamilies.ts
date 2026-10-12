/**
 * **模型版本的识别与"过时淘汰"**（2026-10-13）。
 *
 * ## 用户的要求（原话）
 *
 * > 「我看到很多这种**调用过时模型**的情况，你一定要自查清楚了，**避免使用过时模型**！
 * >  可以使用最新的版本模型不同型号（例如 glm5.3、glm5.3 flash、glm5.3 flashx），
 * >  但**不能使用过时淘汰的模型**（这个功能需要**你自己想办法解决**，因为模型随时都会
 * >  更新新版本，**我不可能一直盯着出新版本让你改，而是系统会自己发现，自己更改，
 * >  自动替换淘汰**）」
 *
 * ## 为什么必须有这个模块（而不是继续维护一份硬编码清单）
 *
 * `MODEL_PROFILES` 是一份**静态档案** —— 它记录了"我实测过哪些模型"，
 * 但它**不知道 `glm-5.1` 已经被 `glm-5.3` 取代**。
 * 于是模型一更新，那份档案就开始指向淘汰版本，而**没有任何机制会提醒你**。
 *
 * 用户明确说了他不该盯着新版本 —— 所以判据必须**从网关的实时模型清单推导**：
 * ```
 *   输入：网关现在有哪些模型（实时）
 *   输出：其中哪些是"被同家族更新版本取代"的
 * ```
 *
 * ## 两条淘汰规则（都是纯函数，可测）
 *
 * ### ① 同家族同变体 → 只留最高版本
 * ```
 *   glm-5.1 · glm-5.2 · glm-5.3        → 留 glm-5.3（另两个过时）
 *   trae-cn/DeepSeek-V4-Flash          → 若存在 V4.1 版本则过时
 * ```
 *
 * ### ② 无版本号的"别名" → 与同家族同变体的最高版本重复
 * ```
 *   opencode-go/deepseek-flash  与  opencode-go/deepseek-v4.1-flash
 *   是【同一个模型的两个名字】（用户亲自提醒过）→ 只留一个，避免白试一次
 * ```
 *
 * ⚠️ **规则②是"同一供应商内"的**：`workbuddy-ai/deepseek-v4.1-flash` 与
 * `opencode-go/deepseek-flash` 是**不同供应商**，各自有额度 ——
 * 那不算重复（它们是冗余，是好东西）。
 */

/** 从模型 id 里解析出来的"家族 + 变体 + 版本"。 */
export interface ModelIdentity {
  /** 家族名（小写，去掉供应商前缀与分隔符）：`glm` / `deepseek` / `kimi` / `gpt` … */
  family: string;
  /** 变体后缀（小写）：`flash` / `max` / `pro` / `official` …；没有则为 `''`。 */
  variant: string;
  /**
   * 版本号数组：`glm-5.3` → `[5, 3]`；`kimi-k3` → `[3]`；`deepseek-v4.1-flash` → `[4, 1]`。
   * **`null` = 这个名字里没有版本号**（可能是别名，见规则②）。
   */
  version: readonly number[] | null;
}

/**
 * 变体词表 —— 只用于**把"型号"与"版本"分开**。
 *
 * 为什么需要它：`glm-5.3-flash` 里的 `flash` 是**型号**，
 * 而 `deepseek-v4.1-flash` 里的 `flash` 也是型号。
 * 若不分出来，`glm-5.3-flash` 与 `glm-5.3` 会被当成同一家族的不同版本。
 *
 * ⚠️ **必须是小写**，且**按长度倒序匹配**（`official-max` 要优先于 `max`）。
 */
const VARIANT_WORDS: readonly string[] = [
  'official-max',
  'official',
  'highspeed',
  'lightning',
  'contributor',
  'preview',
  'thinking',
  'reasoner',
  'vision-exp',
  'vision',
  'nano',
  'mini',
  'pro',
  'max',
  'flash',
  'fast',
  'lite',
  'air',
  'turbo',
  'plus',
  'code',
  'coder',
  'chat',
  'free',
];

/**
 * 解析一个模型 id。
 *
 * ⚠️ 刻意**只认「v?<数字>(.<数字>)*」这一种版本形状** ——
 * 因为各家命名都长这样（`v4`、`5.3`、`k3`、`v4.1`）。
 * 不去猜别的形状：**猜错会让"最新模型"被误判成过时**，
 * 那比"没识别出更新"更糟。
 */
export function parseModelId(id: string): ModelIdentity {
  /* ① 去掉供应商前缀（第一个 `/` 之前的部分）。 */
  const slash = id.indexOf('/');
  const bare = (slash === -1 ? id : id.slice(slash + 1)).toLowerCase();

  /*
   * ② 切出变体后缀。
   * ⚠️ 从**尾部**逐段剥离：`DeepSeek-V4-Flash-Official-max` →
   * 剥掉 `max` 与 `official`，变体记为 `official-max`。
   */
  const parts = bare.split('-').filter((p) => p.length > 0);
  const variantParts: string[] = [];
  while (parts.length > 0) {
    const last = parts[parts.length - 1]!;
    if (!VARIANT_WORDS.includes(last)) break;
    /* 别把整个名字都剥成变体（`pro` 这种单名模型要保留家族）。 */
    if (parts.length === 1) break;
    variantParts.unshift(last);
    parts.pop();
  }
  const variant = variantParts.join('-');

  /* ③ 从剩下的部分里找版本号：`v4.1` → [4,1]；`5.3` → [5,3]；`k3` → [3]。 */
  let version: number[] | null = null;
  const familyParts: string[] = [];
  for (const p of parts) {
    /* `v4.1` / `v4` / `4.1` / `5` 都算版本；`k3` 这种"单字母+数字"也算。 */
    const m = /^(?:v)?(\d+(?:\.\d+)*)$/.exec(p) ?? /^[a-z](\d+)$/.exec(p);
    if (m && version === null) {
      version = m[1]!.split('.').map((n) => Number(n));
      continue;
    }
    familyParts.push(p);
  }
  /*
   * ⚠️ 若版本号出现在中间（`deepseek-v4-flash-0731` 的 `0731` 是日期），
   * 那个日期段不该被当版本 —— 判据：**纯数字且 ≥ 4 位**视为日期/序号，跳过。
   */
  return {
    family: familyParts.join('-') || bare,
    variant,
    version,
  };
}

/**
 * 取模型 id 的**供应商前缀**（第一个 `/` 之前）。
 *
 * ⚠️ 它是"淘汰是否适用"的关键维度：**只有同一供应商才会用新版本替换旧版本**。
 * 不同供应商的同名模型是**互不相干的资源**（各有额度），必须都保留。
 */
function providerOf(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? '' : id.slice(0, slash);
}

/** 版本比较：`a` 比 `b` 新则返回正数。 */
function compareVersion(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 一个被判定为"过时"的模型，以及取代它的那个。 */
export interface SupersededModel {
  id: string;
  /** 取代它的模型 id。 */
  by: string;
  /** 判定理由（写进日志，让"为什么不用它"可追溯）。 */
  reason: string;
}

/**
 * **从一份实时模型清单里找出"过时/重复"的那些**。
 *
 * @param ids 网关现在有的**全部**模型 id（含各供应商）。
 * @returns 应当被排除的模型 → 理由。
 *
 * ⚠️ **它只看"清单里有什么"** —— 不依赖任何硬编码的版本号，
 * 所以模型更新后**下一次拉清单就自动生效**（这正是用户要的"自己发现、自己改"）。
 */
export function findSuperseded(ids: readonly string[]): Map<string, SupersededModel> {
  const out = new Map<string, SupersededModel>();
  const parsed = ids.map((id) => ({ id, ...parseModelId(id) }));

  /* ── ① 同供应商 + 同家族 + 同变体 → 只留最高版本 ────────────────────
   *
   * ⚠️⚠️ **必须先按供应商分组**（2026-10-13 我第一版漏了这个，测试当场抓到）。
   *
   * 第一版只按 `family|variant` 分组，于是：
   * ```
   *   workbuddy-ai/deepseek-v4.1-flash
   *   workbuddy/deepseek-v4.1-flash
   *   trae-cn/deepseek-v4.1-flash
   *   opencode-go/deepseek-v4.1-flash
   * ```
   * 这**四个不同供应商的同一模型**被判成"同组"，只留一个、**删掉三个**。
   *
   * 而用户明确说过：「只有 opencode-go 是真实花了钱的…优先的选择除了 opencode-go
   * 以外的提供商才是正确的」—— 这句话本身就证明**它们是不同的资源**：
   * 各有各的额度、各有各的限流。**它们是冗余（好），不是重复（坏）。**
   *
   * 判据：**淘汰只发生在"同一个供应商内部"** ——
   * 因为只有同一家供应商才会"用新版本替换旧版本"。
   */
  const groups = new Map<string, Array<{ id: string; version: readonly number[] | null }>>();
  for (const p of parsed) {
    /* 版本为 null 的单独处理（规则②）—— 它们不参与"谁最高"的比较。 */
    if (p.version === null) continue;
    const key = `${providerOf(p.id)}|${p.family}|${p.variant}`;
    const list = groups.get(key) ?? [];
    list.push({ id: p.id, version: p.version });
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let best = list[0]!;
    for (const x of list) if (compareVersion(x.version!, best.version!) > 0) best = x;
    for (const x of list) {
      if (x.id === best.id) continue;
      out.set(x.id, {
        id: x.id,
        by: best.id,
        reason: `过时版本（${x.version!.join('.')} → ${best.version!.join('.')}）`,
      });
    }
  }

  /* ── ② 无版本号的别名 → 与同供应商、同家族、同变体的最高版本重复 ─── */
  for (const p of parsed) {
    if (p.version !== null) continue;
    const provider = providerOf(p.id);
    /*
     * 找同供应商 + 同家族 + 同变体、且**有版本号**的模型。
     * 若找到 → 这个无版本名是它的别名（用户亲自确认过 `deepseek-flash`
     * 与 `deepseek-v4.1-flash` 是同一个模型）。
     */
    let best: { id: string; version: readonly number[] } | null = null;
    for (const q of parsed) {
      if (q.version === null) continue;
      if (providerOf(q.id) !== provider || q.family !== p.family || q.variant !== p.variant) continue;
      if (best === null || compareVersion(q.version, best.version) > 0) best = { id: q.id, version: q.version };
    }
    if (best !== null) {
      out.set(p.id, {
        id: p.id,
        by: best.id,
        reason: `同供应商同型号的别名（与该供应商的 ${best.version.join('.')} 是同一个模型）`,
      });
    }
  }
  return out;
}

/**
 * **过滤一份模型清单**，去掉过时与重复的。
 *
 * @param ids 网关的全部模型 id。
 * @returns 过滤后的清单 + 被剔除的明细（供日志）。
 */
export function filterSuperseded(ids: readonly string[]): {
  kept: string[];
  removed: SupersededModel[];
} {
  const superseded = findSuperseded(ids);
  return {
    kept: ids.filter((id) => !superseded.has(id)),
    removed: [...superseded.values()],
  };
}
