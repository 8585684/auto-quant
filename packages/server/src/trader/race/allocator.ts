/**
 * **影子赛马的评估与授信** —— 纯计算，不碰真钱。
 *
 * ## 来源：用户的"授信额度"模型（2026-10-12）
 *
 * 用户的原话：
 *
 * > 「一个专业交易机构，里面有很多交易员（档次各不同，交易手法、策略也不同），
 * >  但是公司都给他们**授信不同额度**让他们去交易，**盈利高的会增加额度**，
 * >  简单说我的理解就是交易员**批量撒网，优胜劣汰**……而不是吊死在一个树上，
 * >  也不把钱放一个篮子里面，因为**运气有时候也是实力一部分**」
 *
 * **这确实是真实机构的做法**（pod shop：Citadel / Millennium 的多团队 + 授信额度）。
 *
 * ## ⚠️ 但必须处理一个统计陷阱（否则"择优"会系统性选中噪声）
 *
 * 用户接受"运气也是实力的一部分"。但在**小资金 + 少样本**下，这句话会变成陷阱：
 *
 * ```
 *   若一个策略真实期望收益 = 0（纯噪声）
 *     跑 20 笔后"盈利"的概率 ≈ 50%
 *   5 个这样的策略里，最好的那个看起来会很漂亮 —— 但它全是运气
 * ```
 *
 * 这叫**多重比较 / 选择性偏差**。**"撒网择优"最大的风险不是分散，
 * 而是把噪声当成能力，然后给它加额度。**
 *
 * ## 所以评估用四个机制（都是真实机构的标准做法）
 *
 * | 机制 | 这里怎么实现 |
 * |---|---|
 * | ① **按样本量而非时间**决定孵化期 | `MIN_SAMPLES` —— 跑够笔数才允许升级 |
 * | ② **风险调整后收益** | `sharpe`，不是绝对收益（高收益常来自高杠杆）|
 * | ③ **渐进授信 + 上限** | 每次最多 ×1.5，且**封顶**在总资金的比例 |
 * | ④ **回撤减额而非直接砍** | 回撤超阈值先降档，持续恶化才停用 |
 */

/** 一条策略线（一个"交易员"）的成交记录 —— 影子期用**假想成交**。 */
export interface RaceTrade {
  /** 该笔的收益率（相对本笔投入，例如 0.012 = +1.2%）。 */
  returnPct: number;
}

/** 一条策略线。 */
export interface StrategyLine {
  id: string;
  name: string;
  /** 当前授信（USDT）。 */
  creditUsd: number;
  /** 影子期的成交（按时间顺序）。 */
  trades: RaceTrade[];
  /** 已被停用（连续降级）。 */
  retired: boolean;
}

/** 评估结论。 */
export type RaceVerdict = 'promote' | 'hold' | 'demote' | 'retire';

export interface RaceEvaluation {
  samples: number;
  /** 滚动窗口内的 Sharpe（无风险利率取 0）。样本不足时为 null。 */
  sharpe: number | null;
  /** 滚动窗口内的最大回撤（正数，例如 0.18 = 18%）。 */
  maxDrawdown: number;
  /** 窗口内累计收益（复利）。 */
  cumReturn: number;
  verdict: RaceVerdict;
  /** 为什么这么判 —— **要能被人读懂**，否则操作员只能盲信。 */
  reason: string;
}

/*
 * ## 门槛为什么是这些数
 *
 * ⚠️ **这些是"起步值"，不是"最优值"** —— 它们应当由实测（影子期的真实分布）校准。
 * 写在这里是为了**先有可执行的标准**，而不是"凭感觉调"。
 *
 * | 常量 | 值 | 依据 |
 * |---|---|---|
 * | `MIN_SAMPLES` | 30 | 统计上"30 个样本"是中心极限定理开始可用的粗略下限；**20 笔区分不了能力与运气** |
 * | `SHARPE_PROMOTE` | 1.0 | 业界常用的"值得配资金"门槛 |
 * | `SHARPE_DEMOTE` | 0.0 | 滚动 Sharpe 为负 = 这段时间在亏 |
 * | `DD_DEMOTE` | 0.25 | 回撤超 25% 先降档（不是直接砍）|
 * | `DD_RETIRE` | 0.40 | 回撤超 40% 停用并复盘 |
 * | `WINDOW` | 60 | 滚动窗口：**只看最近 60 笔** —— 市场会变，旧业绩不该永久背书 |
 */
export const RACE_LIMITS = {
  MIN_SAMPLES: 30,
  SHARPE_PROMOTE: 1.0,
  SHARPE_DEMOTE: 0.0,
  DD_DEMOTE: 0.25,
  DD_RETIRE: 0.4,
  WINDOW: 60,
  /** 单次升级的倍数上限（渐进授信）。 */
  PROMOTE_MULTIPLIER: 1.5,
  /** 单次降级的倍数（不是清零）。 */
  DEMOTE_MULTIPLIER: 0.5,
} as const;

/** 一条线最多占总资金的比例（**封顶** —— 防止一条线独大）。 */
export const MAX_CREDIT_SHARE = 0.2;

/** 滚动窗口内的统计量。 */
export function windowStats(returns: readonly number[]): {
  samples: number;
  mean: number;
  std: number;
  sharpe: number | null;
  maxDrawdown: number;
  cumReturn: number;
} {
  const samples = returns.length;
  if (samples === 0) {
    return { samples: 0, mean: 0, std: 0, sharpe: null, maxDrawdown: 0, cumReturn: 0 };
  }
  const mean = returns.reduce((a, b) => a + b, 0) / samples;
  /* 样本标准差（n-1）—— 用总体标准差会**系统性低估**波动，从而高估 Sharpe。 */
  const variance = samples > 1
    ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples - 1)
    : 0;
  const std = Math.sqrt(variance);

  /*
   * Sharpe：样本不足或波动为 0 时**返回 null 而不是 Infinity**。
   *
   * 为什么：`mean/0 = Infinity` 会让"从没亏过"的策略看起来完美 ——
   * 而它可能只是**样本太少**（那正是我们要防的"把噪声当能力"）。
   * 返回 null 让调用方**必须显式处理"还没有结论"**这种情况。
   *
   * ## ⚠️ 必须用【阈值】而不是 `std > 0`（我自己的测试当场抓到的 BUG）
   *
   * 实测：40 笔全是 `+0.01` 时，`std` **不是 0** ——
   * ```
   *   mean = 0.4000000000000001 / 40 = 0.010000000000000002
   *   (0.01 - mean)² ≈ 4e-36   ← 浮点残差，但【大于 0】
   *   → sharpe = mean / std ≈ 天文数字 → 判成 "promote"
   * ```
   * **那正是这个模块要防的陷阱**（"从没亏过"看起来完美），
   * 而 `std > 0` 这种写法**恰好把它放行了**。
   *
   * ## 阈值怎么选（不是拍脑袋）
   *
   * 收益率是**小数**（`0.01` = 1%）。有意义的波动至少 `1e-6`（万分之一）；
   * 而浮点残差在这个量级下约 `1e-17`。取 `1e-9` 落在两者中间 ——
   * **两侧各有 6~8 个数量级的余量**，不会误伤真实波动，也不会放行残差。
   */
  const stdIsMeaningful = std > 1e-9;
  const sharpe = stdIsMeaningful && samples >= 2 ? mean / std : null;

  /* 最大回撤：按复利净值曲线算。 */
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  return { samples, mean, std, sharpe, maxDrawdown, cumReturn: equity - 1 };
}

/**
 * 评估一条策略线。
 *
 * ⚠️ **只用滚动窗口**（最近 `WINDOW` 笔）—— 市场会变，
 * 三年前的业绩不该给今天的额度背书。
 */
export function evaluateLine(line: StrategyLine): RaceEvaluation {
  if (line.retired) {
    return {
      samples: line.trades.length, sharpe: null, maxDrawdown: 0, cumReturn: 0,
      verdict: 'retire', reason: '已停用（连续降级）—— 需要人工复盘后才可能重新启用',
    };
  }

  const recent = line.trades.slice(-RACE_LIMITS.WINDOW).map((t) => t.returnPct);
  const s = windowStats(recent);

  /* ① **样本量门槛优先于一切** —— 这是防"把噪声当能力"的第一道闸。 */
  if (s.samples < RACE_LIMITS.MIN_SAMPLES) {
    return {
      samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'hold',
      reason: `样本不足（${s.samples}/${RACE_LIMITS.MIN_SAMPLES} 笔）—— 这个阶段区分不了能力与运气，不加也不减`,
    };
  }

  /* ② 回撤优先于收益：先保命，再谈加额度。 */
  if (s.maxDrawdown >= RACE_LIMITS.DD_RETIRE) {
    return {
      samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'retire',
      reason: `最大回撤 ${(s.maxDrawdown * 100).toFixed(1)}% ≥ ${RACE_LIMITS.DD_RETIRE * 100}% —— 停用并复盘`,
    };
  }
  if (s.maxDrawdown >= RACE_LIMITS.DD_DEMOTE) {
    return {
      samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'demote',
      reason: `最大回撤 ${(s.maxDrawdown * 100).toFixed(1)}% ≥ ${RACE_LIMITS.DD_DEMOTE * 100}% —— 先降档（不是直接砍）`,
    };
  }

  /* ③ 风险调整后收益。Sharpe 为 null = 波动为 0（样本异常），保守起见按 hold。 */
  if (s.sharpe === null) {
    return {
      samples: s.samples, sharpe: null, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'hold', reason: '波动为 0（样本异常）—— 无法算风险调整后收益，保守不动',
    };
  }
  if (s.sharpe < RACE_LIMITS.SHARPE_DEMOTE) {
    return {
      samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'demote',
      reason: `滚动 Sharpe ${s.sharpe.toFixed(2)} < ${RACE_LIMITS.SHARPE_DEMOTE} —— 这段在亏，降档`,
    };
  }
  if (s.sharpe >= RACE_LIMITS.SHARPE_PROMOTE) {
    return {
      samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
      verdict: 'promote',
      reason: `滚动 Sharpe ${s.sharpe.toFixed(2)} ≥ ${RACE_LIMITS.SHARPE_PROMOTE}（${s.samples} 笔，回撤 ${(s.maxDrawdown * 100).toFixed(1)}%）—— 加额度`,
    };
  }
  return {
    samples: s.samples, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, cumReturn: s.cumReturn,
    verdict: 'hold',
    reason: `滚动 Sharpe ${s.sharpe.toFixed(2)} 在 [${RACE_LIMITS.SHARPE_DEMOTE}, ${RACE_LIMITS.SHARPE_PROMOTE}) 之间 —— 维持`,
  };
}

/**
 * 算下一次的授信额度。
 *
 * ⚠️ **必须封顶**（`MAX_CREDIT_SHARE`）—— 否则一条"看起来很好"的线会吃光全部资金，
 * 而那正是"把噪声当能力"最贵的代价。
 */
export function nextCredit(
  currentUsd: number,
  verdict: RaceVerdict,
  totalCapitalUsd: number,
): number {
  const cap = totalCapitalUsd * MAX_CREDIT_SHARE;
  switch (verdict) {
    case 'promote':
      return Math.min(currentUsd * RACE_LIMITS.PROMOTE_MULTIPLIER, cap);
    case 'demote':
      /* 降档**不清零** —— 一次正常回撤不该杀死一个好策略。 */
      return currentUsd * RACE_LIMITS.DEMOTE_MULTIPLIER;
    case 'retire':
      return 0;
    case 'hold':
      return currentUsd;
  }
}
