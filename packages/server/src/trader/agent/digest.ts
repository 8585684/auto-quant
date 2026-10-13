/**
 * **单标的分析的同构摘要** —— "按币并行"的关键前置件。
 *
 * ## 来源：用户的建议（2026-10-12）
 *
 * > 「以前需要用到分析币种行情的时候（例如要分析 20 个币种），以前的做法
 * >  好像是全部放到一个上下文\对话中一次性分析，貌似会导致模型思考很长，
 * >  浪费实际，这个团队模式下是否能改成拆分，假设要分析 20 个，那就
 * >  **并行 20 个子代理，同步进行一人分析一个，分析完了以后汇总**」
 *
 * ## 为什么"同构"是这个方案成败的关键（而不是可选的优化）
 *
 * 汇总步骤要读 N 份分析。若每份**自由发挥**（有的 200 字、有的 2000 字），
 * 那么：
 *
 * ```
 *   20 份 × 2000 字 = 4 万字进汇总 → 比现在的"一次读 6 万字"没好多少
 * ```
 *
 * 而**同构 + 短**（固定字段、每份 ~150 字）：
 *
 * ```
 *   20 份 × 150 字 = 3000 字 → 汇总很快，而且【可以比较】
 * ```
 *
 * ## ⚠️ 更重要的收益：**可比较**
 *
 * 自由文本**没法排序**。而"从 20 个里选 3 个"本质是**比较** ——
 * 若每份格式不同，汇总 agent 只能"读一遍然后凭感觉挑"，
 * 而**那正是 LLM 最容易出错的地方**（它会偏好写得长的、或者排在前面的）。
 *
 * 固定字段之后，"排序"可以**部分用代码做**（例如按 `score` 排），
 * 而 AI 只需要做"为什么这几个更好"的判断。
 *
 * ## 字段为什么是这些（每一个都有用途）
 *
 * | 字段 | 用途 | 不用它会发生什么 |
 * |---|---|---|
 * | `symbol` | 对齐 | 无法把摘要与标的对应 |
 * | `direction` | 汇总排序 | 无法判断多空 |
 * | `score` | **排序（代码可做）** | 只能靠文字描述，无法比较 |
 * | `confidence` | 排序权重 | 一个"弱信号"与"强信号"被等同对待 |
 * | `keyLevels` | 下游挂单/止损参考 | 辩论者还要自己算 |
 * | `evidence` | **审计与辩论** | 结论没有依据 → 无法复核 |
 * | `invalidates` | **失效条件** | 无法知道"什么情况下这个判断不成立" |
 * | `dataGaps` | **诚实标注** | 数据缺失被当成"中性"（那是假事实）|
 */

/** 一个标的的分析摘要（**同构** —— 所有标的都是这个形状）。 */
export interface SymbolDigest {
  /** 标的（与请求一致）。 */
  symbol: string;
  /** 方向判断。`unclear` 是**合法结论**（数据不足时不该硬给方向）。 */
  direction: 'bullish' | 'bearish' | 'neutral' | 'unclear';
  /**
   * **信号强度 0~100**（不是概率）—— 用于**排序**。
   *
   * ⚠️ 为什么要一个数：`direction` 只能分类，无法排序。
   * 而"从 20 个里选 3 个"需要**可比较**。有了它，**排序可以部分用代码做**，
   * AI 只需解释"为什么这几个更好"。
   *
   * ⚠️ 它**不是**"上涨概率"：50 表示"信号强度中等"，不是"五成概率涨"。
   * 把它读成概率会让人误以为系统在预测价格。
   */
  score: number;
  /** 结论的置信度 0~100（对自己这个判断有多确定）。 */
  confidence: number;
  /** 关键价位（可空）—— 下游挂单/止损直接可用，不必自己算。 */
  keyLevels?: { support?: number; resistance?: number };
  /** **依据**（一两句）—— 审计与辩论都要靠它。 */
  evidence: string;
  /**
   * **失效条件** —— "什么情况下这个判断不成立"。
   *
   * ⚠️ 这一条是**防谄媚的关键**（见调研 [arXiv:2509.23055](https://arxiv.org/html/2509.23055v1)）：
   * 要求模型写出"我什么时候是错的"，能显著降低"永远看多"的倾向。
   */
  invalidates: string;
  /**
   * **数据缺口** —— 明确写出"哪些数据没拿到"。
   *
   * ⚠️ 为什么必须显式：若不写，模型会用**常识填充**缺失的数据，
   * 而下游（辩论/裁决）**看不出那是编的**。实测过的同类问题：
   * 一条缺 `confidence` 的历史记录让整块看板崩掉 ——
   * 数据缺失**必须被看见**，不能被静默补全。
   */
  dataGaps?: string[];
}

/** 解析结果。 */
export type DigestParse = { ok: true; digest: SymbolDigest } | { ok: false; error: string; raw: string };

/** 从模型输出里抽出 JSON（容忍 ```json 包裹与前后废话）。 */
function extractJson(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析一份摘要。
 *
 * ⚠️ **严格但宽容地失败**：字段缺失/类型不对 → `ok: false` 并**保留原文**。
 *
 * 为什么不用 zod 的 `.catch()` 之类"静默补默认值"：
 * 一个"补了默认值"的摘要在下游**看不出它其实是坏的** ——
 * 例如 `score` 缺失被补成 0，汇总时会把它排在最后，
 * 而真相是"这个标的根本没被分析成功"。
 * **保留原文 + 明确失败**才能让调用方决定（重试 / 标记缺失 / 剔除）。
 */
export function parseDigest(text: string, expectedSymbol?: string): DigestParse {
  const raw = extractJson(text);
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '没有找到 JSON 对象', raw: text.slice(0, 400) };
  }
  const o = raw as Record<string, unknown>;

  const symbol = typeof o.symbol === 'string' ? o.symbol : '';
  if (symbol.length === 0) return { ok: false, error: '缺 symbol', raw: text.slice(0, 400) };
  if (expectedSymbol !== undefined && symbol !== expectedSymbol) {
    /*
     * ⚠️ **标的对不上必须失败**，不能"反正差不多就用"。
     * 按币并行时，每份摘要会被放回它自己的槽位 ——
     * 若模型答的是另一个币而这里放行，**结果会被记到错误的标的名下**，
     * 而且**完全静默**（数字都在、格式都对）。
     */
    return { ok: false, error: `标的对不上（期望 ${expectedSymbol}，实际 ${symbol}）`, raw: text.slice(0, 400) };
  }

  const dir = o.direction;
  const direction = dir === 'bullish' || dir === 'bearish' || dir === 'neutral' || dir === 'unclear'
    ? dir
    : null;
  if (direction === null) return { ok: false, error: `direction 非法（${String(dir)}）`, raw: text.slice(0, 400) };

  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

  const score = num(o.score, 0, 100);
  if (score === null) return { ok: false, error: `score 非法（${String(o.score)}）`, raw: text.slice(0, 400) };
  const confidence = num(o.confidence, 0, 100);
  if (confidence === null) return { ok: false, error: `confidence 非法（${String(o.confidence)}）`, raw: text.slice(0, 400) };

  const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
  if (evidence.length === 0) return { ok: false, error: '缺 evidence（结论必须有依据）', raw: text.slice(0, 400) };
  const invalidates = typeof o.invalidates === 'string' ? o.invalidates.trim() : '';
  if (invalidates.length === 0) {
    /*
     * 失效条件**必填** —— 见类型定义里的说明（防谄媚）。
     * 缺它就失败，而不是补一句"无"：补出来的"无"会让下游以为
     * "这个判断没有失效条件"，而真相是**模型没回答那个问题**。
     */
    return { ok: false, error: '缺 invalidates（必须写出失效条件）', raw: text.slice(0, 400) };
  }

  const kl = o.keyLevels;
  let keyLevels: SymbolDigest['keyLevels'];
  if (kl !== null && typeof kl === 'object') {
    const k = kl as Record<string, unknown>;
    const s = num(k.support, 0, Number.MAX_SAFE_INTEGER);
    const r = num(k.resistance, 0, Number.MAX_SAFE_INTEGER);
    if (s !== null || r !== null) keyLevels = { ...(s !== null ? { support: s } : {}), ...(r !== null ? { resistance: r } : {}) };
  }

  const gaps = Array.isArray(o.dataGaps)
    ? o.dataGaps.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    : undefined;

  return {
    ok: true,
    digest: {
      symbol, direction, score, confidence,
      ...(keyLevels !== undefined ? { keyLevels } : {}),
      evidence, invalidates,
      ...(gaps !== undefined && gaps.length > 0 ? { dataGaps: gaps } : {}),
    },
  };
}

/**
 * **按"可比较性"排序** N 份摘要 —— 这一步**用代码做**，不用 AI。
 *
 * ## 为什么要用代码排（而不是让汇总 agent "读一遍然后挑"）
 *
 * "从 20 个里选 3 个"本质是**比较**，而 LLM 在做这种排序时有已知偏差：
 * **偏好写得长的、以及排在上下文前面的**（位置偏差）。
 *
 * 用代码排之后，AI 只需回答"**为什么这几个更好**"——
 * 那才是它擅长的事（解释与权衡），而不是数大小。
 *
 * ## 排序依据
 *
 * 1. **`score`（信号强度）降序** —— 主键
 * 2. **`confidence` 降序** —— 同强度时，更确定的优先
 * 3. `unclear` 一律排最后 —— **数据不足不该排在"有结论但弱"的前面**
 *
 * ⚠️ **`direction` 不参与排序**：粗筛阶段不该预判多空
 *（否则会系统性偏向某一方向）。方向由下游裁决。
 */
export function rankDigests(digests: readonly SymbolDigest[]): SymbolDigest[] {
  return [...digests].sort((a, b) => {
    const au = a.direction === 'unclear' ? 1 : 0;
    const bu = b.direction === 'unclear' ? 1 : 0;
    if (au !== bu) return au - bu;
    if (b.score !== a.score) return b.score - a.score;
    return b.confidence - a.confidence;
  });
}

/**
 * 把 N 份摘要压成**一段紧凑文本**，供汇总/辩论使用。
 *
 * ⚠️ **不是简单拼接** —— 每份压成一行，且**保留 `dataGaps`**。
 * 丢掉 dataGaps 会让下游看不到"哪些结论是基于不完整数据的"。
 */
export function renderDigests(digests: readonly SymbolDigest[]): string {
  if (digests.length === 0) return '（没有可用的标的分析）';
  return rankDigests(digests)
    .map((d) => {
      const parts = [
        `**${d.symbol}**`,
        `方向=${d.direction}`,
        `强度=${d.score}`,
        `置信=${d.confidence}`,
      ];
      if (d.keyLevels !== undefined) {
        const lv: string[] = [];
        if (d.keyLevels.support !== undefined) lv.push(`支撑 ${d.keyLevels.support}`);
        if (d.keyLevels.resistance !== undefined) lv.push(`阻力 ${d.keyLevels.resistance}`);
        if (lv.length > 0) parts.push(lv.join('/'));
      }
      let line = `- ${parts.join(' · ')}\n  依据：${d.evidence}\n  失效条件：${d.invalidates}`;
      if (d.dataGaps !== undefined && d.dataGaps.length > 0) {
        line += `\n  ⚠️ 数据缺口：${d.dataGaps.join('；')}`;
      }
      return line;
    })
    .join('\n');
}
