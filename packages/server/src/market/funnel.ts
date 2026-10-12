/**
 * **分层漏斗** —— 用**代码**把"全市场几百个标的"逐层收敛到"值得让 AI 细看的少数"。
 *
 * ## 来源：用户的"层层筛选"（2026-10-12）
 *
 * > 「交易所有 500 个可以交易的币，那么由总管制定好研究分析方向以后
 * >  **委派 N 个子代理按照计划去逐个分析**……然后**汇总上报，层层筛选**」
 *
 * ## ⚠️ 但第一层**不该用 LLM**（这是我要补充的）
 *
 * 用户的描述是"20 个人手，每人分析 25 个币" —— 而 **"每人 25 个"意味着
 * 那个人要读 `25 × 7506 ≈ 19 万 token`**，那正是我们要解决的"一次读太多"问题。
 *
 * **正确的分工**：
 *
 * ```
 *   500 个标的
 *      ↓ ① 代码粗筛（毫秒级、免费、确定性）—— 【本文件】
 *    30~50 个
 *      ↓ ② agent 细看（并发闸门控制，每人【一个】标的）—— 用 mapConcurrent
 *    10~15 个
 *      ↓ ③ 汇总排序（比较，不是拼接）
 *     最终候选
 * ```
 *
 * **第一层为什么必须是代码**：
 *
 * | 维度 | 代码 | LLM |
 * |---|---|---|
 * | 速度 | **毫秒** | 秒~分钟 |
 * | 成本 | 0 | 每次调用 |
 * | 确定性 | **完全可复现** | 每次不同 |
 * | 幻觉 | **不可能** | 会编 |
 *
 * "成交额 > 5000 万"是一个**数值比较** —— 让 LLM 做这件事是纯浪费，
 * 而且它可能算错。**AI 该用在"这个形态意味着什么"，不是"哪个数更大"。**
 *
 * ## 每一层淘汰掉什么（都要能解释）
 *
 * 用户要的是"层层筛选"，而**每一层淘汰的理由必须能被人读懂** ——
 * 否则操作员无法判断"我的币为什么没被看到"。
 */

/** 参与粗筛的一个标的（来自行情接口）。 */
export interface FunnelCandidate {
  symbol: string;
  /** 24h 成交额（计价货币，通常是 USDT）。 */
  quoteVolume24h: number;
  /** 24h 涨跌幅（百分数，`6.5` = 6.5%）。 */
  changePercent24h: number;
  /** 24h 振幅（百分数）。 */
  amplitudePercent: number;
}

/** 一层的配置。 */
export interface FunnelStage {
  /** 这一层的名字（会写进日志，让操作员知道"死在哪一层"）。 */
  name: string;
  /** 这一层保留多少个（`undefined` = 不按数量截断，只按条件过滤）。 */
  keep?: number;
  /** 硬条件（不满足直接淘汰）。 */
  require?: {
    minQuoteVolume24h?: number;
    maxQuoteVolume24h?: number;
    minAmplitudePercent?: number;
    maxAmplitudePercent?: number;
    /** 涨跌幅的**绝对值**下限（想找"有动静"的标的）。 */
    minAbsChangePercent?: number;
    /** 涨跌幅的**绝对值**上限（过滤掉已经暴走/插针的）。 */
    maxAbsChangePercent?: number;
  };
  /** 按什么排序取前 `keep` 个（默认按成交额降序）。 */
  orderBy?: 'quoteVolume' | 'amplitude';
}

/** 每层的淘汰统计 —— **必须可解释**。 */
export interface FunnelStageReport {
  name: string;
  input: number;
  output: number;
  /** 被这一层淘汰的（用于日志与 UI 展示）。 */
  dropped: number;
  /** 一句话说明这一层做了什么。 */
  note: string;
}

export interface FunnelResult {
  /** 最终留下的标的（按最后一层的顺序）。 */
  survivors: FunnelCandidate[];
  /** 逐层报告（从第一层到最后一层）。 */
  stages: FunnelStageReport[];
}

/**
 * **默认漏斗** —— 全市场 → 可交易 → 有波动 → 交给 AI。
 *
 * ⚠️ **这些阈值是"起步值"，需要按实测校准**（尤其小资金下）。
 * 它们写在这里是为了**先有可执行的标准**，而不是"凭感觉调"。
 */
export const DEFAULT_FUNNEL: readonly FunnelStage[] = [
  {
    /*
     * 第一层：**流动性**。这一层淘汰最多（500 → 50 量级）。
     *
     * 为什么成交额是第一道闸：
     * · 成交额太低 → **滑点吃光利润**（这是小资金最容易被忽视的成本）；
     * · 成交额太低 → 价格容易被操纵，技术形态**不可信**。
     *
     * 5000 万 USDT 是"主流交易所有真实深度"的粗略下限。
     */
    name: '流动性',
    require: { minQuoteVolume24h: 50_000_000 },
    orderBy: 'quoteVolume',
    keep: 60,
  },
  {
    /*
     * 第二层：**要有波动才有利润空间**。
     *
     * 振幅 < 2% 的标的：扣掉手续费与资金费后**几乎不可能有正期望**。
     * 而振幅 > 25% 的往往是**插针/暴走**，技术形态失效、风险不可控。
     */
    name: '波动区间',
    require: { minAmplitudePercent: 2, maxAbsChangePercent: 20 },
    orderBy: 'amplitude',
    keep: 30,
  },
];

/**
 * 跑一遍漏斗。
 *
 * @param candidates 全市场候选（通常几百个）
 * @param stages 每层配置（默认 `DEFAULT_FUNNEL`）
 */
export function runFunnel(
  candidates: readonly FunnelCandidate[],
  stages: readonly FunnelStage[] = DEFAULT_FUNNEL,
): FunnelResult {
  const reports: FunnelStageReport[] = [];
  let current = [...candidates];

  for (const stage of stages) {
    const before = current.length;
    const r = stage.require;

    let kept = current.filter((c) => {
      /*
       * ⚠️ **数值无效的标的必须淘汰，不能"放行"**。
       *
       * 若行情接口返回 `NaN`，所有 `>=` 比较都是 `false` —— 那会让它
       * **静默通过**（例如 `NaN >= 5e7` 是 false → 被淘汰；但
       * `c.minQuoteVolume24h !== undefined && NaN < min` 也是 false → 放行）。
       * 两种写法行为相反，所以**先显式检查有限性**，不依赖比较运算的偶然行为。
       */
      if (!Number.isFinite(c.quoteVolume24h) || !Number.isFinite(c.changePercent24h)) return false;

      if (r?.minQuoteVolume24h !== undefined && c.quoteVolume24h < r.minQuoteVolume24h) return false;
      if (r?.maxQuoteVolume24h !== undefined && c.quoteVolume24h > r.maxQuoteVolume24h) return false;
      if (r?.minAmplitudePercent !== undefined) {
        if (!Number.isFinite(c.amplitudePercent) || c.amplitudePercent < r.minAmplitudePercent) return false;
      }
      /* 涨跌幅看**绝对值**：我们要"有动静"，方向由 AI 判断。 */
      if (r?.minAbsChangePercent !== undefined && Math.abs(c.changePercent24h) < r.minAbsChangePercent) return false;
      if (r?.maxAbsChangePercent !== undefined && Math.abs(c.changePercent24h) > r.maxAbsChangePercent) return false;
      return true;
    });

    /* 排序后截断 —— 这一层"选谁"的依据。 */
    if (stage.keep !== undefined && kept.length > stage.keep) {
      const key = stage.orderBy ?? 'quoteVolume';
      kept = [...kept]
        .sort((a, b) => (key === 'amplitude'
          ? b.amplitudePercent - a.amplitudePercent
          : b.quoteVolume24h - a.quoteVolume24h))
        .slice(0, stage.keep);
    }

    reports.push({
      name: stage.name,
      input: before,
      output: kept.length,
      dropped: before - kept.length,
      note: describeStage(stage, before, kept.length),
    });
    current = kept;
  }

  return { survivors: current, stages: reports };
}

/** 把一层的作为写成**人能读懂**的一句话。 */
function describeStage(stage: FunnelStage, input: number, output: number): string {
  const cond: string[] = [];
  const r = stage.require;
  if (r?.minQuoteVolume24h !== undefined) cond.push(`成交额 ≥ ${(r.minQuoteVolume24h / 1e6).toFixed(0)}M`);
  if (r?.maxQuoteVolume24h !== undefined) cond.push(`成交额 ≤ ${(r.maxQuoteVolume24h / 1e6).toFixed(0)}M`);
  if (r?.minAmplitudePercent !== undefined) cond.push(`振幅 ≥ ${r.minAmplitudePercent}%`);
  if (r?.maxAbsChangePercent !== undefined) cond.push(`|涨跌| ≤ ${r.maxAbsChangePercent}%`);
  if (r?.minAbsChangePercent !== undefined) cond.push(`|涨跌| ≥ ${r.minAbsChangePercent}%`);
  const by = stage.orderBy === 'amplitude' ? '按振幅' : '按成交额';
  const tail = stage.keep !== undefined ? `，${by}取前 ${stage.keep}` : '';
  return `${cond.length > 0 ? cond.join(' 且 ') : '无硬条件'}${tail} → ${input} 剩 ${output}`;
}
