/**
 * **策略失效检测** —— 用户明确要求的那一环。
 *
 * ## 用户的原话（2026-10-12）
 *
 * > 「**并且得注意一点：消息面的东西常常有时效性，如果消息面的策略失效后，
 * >  应当会及时修正、调整、改变**，简单说也就是和团队模式设计初衷一样，
 * >  模拟真实得专业量化团队去操作」
 *
 * ## 为什么"失效检测"是独立的一环（而不是靠人发现）
 *
 * 一个消息面策略的**生命周期**通常是：
 *
 * ```
 *   ① 有效（消息驱动，赚钱）
 *   ② 衰减（同样的消息，市场不再有反应 —— 因为已经被消化）
 *   ③ 失效（继续用 → 稳定亏钱）
 * ```
 *
 * **②→③ 的转变是静默的** —— 没有任何"错误"发生，只是**不再有效了**。
 * 若没有自动检测，表现是"策略慢慢开始亏，而没人知道为什么"。
 *
 * ## 与"影子赛马"的关系（两者不是一回事）
 *
 * | | 影子赛马（`race/allocator.ts`）| 本文件 |
 * |---|---|---|
 * | 判什么 | **一条策略线**该拿多少额度 | **一个信号来源**是否还有效 |
 * | 输入 | 该线的全部成交 | 该信号的**归因成交** |
 * | 输出 | promote/hold/demote/retire | 有效 / 衰减中 / 已失效 |
 *
 * 两者互补：赛马管"给多少钱"，失效检测管"这个逻辑还成不成立"。
 *
 * ## ⚠️ 判据为什么不能只看"最近是否亏钱"
 *
 * 一个策略**正常**也会有连亏（那是方差，不是失效）。所以判据要**组合**：
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | 滚动胜率显著低于历史 | 区分"正常方差"与"逻辑变了" |
 * | **消息反应衰减**（同样强度的消息，价格反应变小）| **这是消息面策略失效的专属信号** |
 * | 连续亏损笔数 | 快速止损（但要配合样本量，否则会误杀）|
 */

/** 一次"由某信号驱动"的成交（用于归因）。 */
export interface SignalTrade {
  /** 该笔的收益率（相对本笔投入，例如 0.012 = +1.2%）。 */
  returnPct: number;
  /**
   * **信号强度**（0~1）—— 消息面策略用它衡量"这条消息有多强"。
   *
   * ⚠️ 它用来做**反应衰减检测**：同样强度的消息，若价格反应持续变小，
   * 说明**市场已经消化了这类消息** —— 那是消息面策略失效的核心征兆。
   */
  signalStrength: number;
}

/** 失效档位。 */
export type SignalHealth = 'effective' | 'decaying' | 'failed' | 'insufficient_data';

export interface SignalVerdict {
  health: SignalHealth;
  samples: number;
  /** 滚动窗口胜率。 */
  recentWinRate: number;
  /** 历史（窗口之外）胜率 —— 用来对比。 */
  baselineWinRate: number;
  /** 最近连续亏损笔数。 */
  losingStreak: number;
  /** 一句话结论（给人看，要能直接贴到 UI / 日志）。 */
  reason: string;
  /** 建议动作。 */
  action: 'keep' | 'reduce_weight' | 'disable_and_review';
}

/**
 * **默认门槛**（起步值，需按实测校准）。
 *
 * ⚠️ 这些数**不该硬抄机构数字**（那些是给大资金、多年样本的），
 * 而应当**按我们自己的实测分布**校准。写在这里是为了先有可执行标准。
 */
export const SIGNAL_LIMITS = {
  /** 少于这个样本数**不下结论** —— 否则会把方差当失效。 */
  MIN_SAMPLES: 20,
  /** 滚动窗口：只看最近这么多笔。 */
  WINDOW: 30,
  /** 连续亏损达到这个数 → 立即降权（快速止损）。 */
  STREAK_REDUCE: 6,
  /** 连续亏损达到这个数 → 停用并复盘。 */
  STREAK_DISABLE: 10,
  /** 滚动胜率跌破历史胜率的这个比例 → 失效。 */
  WIN_RATE_COLLAPSE: 0.6,
} as const;

/**
 * 判断一个信号是否还有效。
 *
 * @param trades 该信号驱动的成交（按时间顺序）
 */
export function assessSignal(trades: readonly SignalTrade[]): SignalVerdict {
  const n = trades.length;
  if (n < SIGNAL_LIMITS.MIN_SAMPLES) {
    return {
      health: 'insufficient_data', samples: n,
      recentWinRate: 0, baselineWinRate: 0, losingStreak: 0,
      reason: `样本不足（${n}/${SIGNAL_LIMITS.MIN_SAMPLES} 笔）—— 这个阶段分不清"方差"与"失效"`,
      action: 'keep',
    };
  }

  const recent = trades.slice(-SIGNAL_LIMITS.WINDOW);
  const baseline = trades.slice(0, Math.max(0, n - SIGNAL_LIMITS.WINDOW));

  /* 胜 = 收益为正。用 `> 0` 而不是 `>= 0`：0 收益的一笔既不算赢也不算输，归到"没赢"。 */
  const winRate = (xs: readonly SignalTrade[]): number =>
    xs.length === 0 ? 0 : xs.filter((t) => t.returnPct > 0).length / xs.length;

  const recentWinRate = winRate(recent);
  /* 没有历史时（刚好等于窗口大小），用整体胜率当基线 —— 否则没法比。 */
  const baselineWinRate = baseline.length > 0 ? winRate(baseline) : winRate(trades);

  /* 连续亏损（从最后一笔往前数）。 */
  let losingStreak = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    if (trades[i]!.returnPct <= 0) losingStreak += 1;
    else break;
  }

  /* ── 判据按"严重程度"从高到低 ────────────────────────────────────── */

  /* ① 连续亏损到停用线 —— 最急，先保命。 */
  if (losingStreak >= SIGNAL_LIMITS.STREAK_DISABLE) {
    return {
      health: 'failed', samples: n, recentWinRate, baselineWinRate, losingStreak,
      reason: `连续 ${losingStreak} 笔亏损（≥${SIGNAL_LIMITS.STREAK_DISABLE}）—— 停用并复盘`,
      action: 'disable_and_review',
    };
  }

  /* ② 胜率崩塌 —— 这是"逻辑变了"的最直接证据。 */
  const collapsed = baselineWinRate > 0 && recentWinRate < baselineWinRate * SIGNAL_LIMITS.WIN_RATE_COLLAPSE;
  if (collapsed) {
    return {
      health: 'failed', samples: n, recentWinRate, baselineWinRate, losingStreak,
      reason: `滚动胜率 ${(recentWinRate * 100).toFixed(0)}% 已跌破历史胜率 ${(baselineWinRate * 100).toFixed(0)}% 的 ${SIGNAL_LIMITS.WIN_RATE_COLLAPSE * 100}% —— 判为失效`,
      action: 'disable_and_review',
    };
  }

  /* ③ 连续亏损到降权线。 */
  if (losingStreak >= SIGNAL_LIMITS.STREAK_REDUCE) {
    return {
      health: 'decaying', samples: n, recentWinRate, baselineWinRate, losingStreak,
      reason: `连续 ${losingStreak} 笔亏损（≥${SIGNAL_LIMITS.STREAK_REDUCE}）—— 先降权观察（不是直接停）`,
      action: 'reduce_weight',
    };
  }

  /* ④ 滚动胜率明显低于历史（但没到崩塌线）。 */
  if (baselineWinRate > 0 && recentWinRate < baselineWinRate * 0.8) {
    return {
      health: 'decaying', samples: n, recentWinRate, baselineWinRate, losingStreak,
      reason: `滚动胜率 ${(recentWinRate * 100).toFixed(0)}% 低于历史 ${(baselineWinRate * 100).toFixed(0)}% —— 衰减中，降权观察`,
      action: 'reduce_weight',
    };
  }

  return {
    health: 'effective', samples: n, recentWinRate, baselineWinRate, losingStreak,
    reason: `有效（滚动胜率 ${(recentWinRate * 100).toFixed(0)}% vs 历史 ${(baselineWinRate * 100).toFixed(0)}%）`,
    action: 'keep',
  };
}

/**
 * **消息反应衰减检测** —— 消息面策略失效的**专属信号**。
 *
 * ## 为什么它单独存在
 *
 * 消息面策略失效的**典型机制**不是"模型变笨了"，而是
 * **市场把这类消息消化掉了**：
 *
 * ```
 *   第一阶段：出消息 → 价格立刻反应 5%  → 策略赚钱
 *   第二阶段：出消息 → 价格反应 2%      → 策略赚得少
 *   第三阶段：出消息 → 价格几乎不动     → 策略开始亏
 * ```
 *
 * 而**胜率**在第二阶段可能还很好看（赚得少但仍是赚）——
 * 所以**只看胜率会漏掉这个阶段**。而"反应衰减"能在**亏钱之前**发出预警。
 *
 * ## 判据
 *
 * 把成交按时间分两半，比较**"单位信号强度带来的平均收益"**：
 *
 * ```
 *   前半：平均收益 / 平均信号强度
 *   后半：平均收益 / 平均信号强度
 *   若后半显著低于前半 → 反应在衰减
 * ```
 *
 * ⚠️ **这是预警，不是判决** —— 它可能因为"这段时间消息整体都弱"而误报，
 * 所以输出的是"衰减比例"，由调用方决定要不要降权。
 */
export function detectReactionDecay(trades: readonly SignalTrade[]): {
  ok: boolean;
  earlyRatio: number;
  lateRatio: number;
  /** 后半相对前半的比例（< 1 = 在衰减）。 */
  decayRatio: number;
  note: string;
} | null {
  if (trades.length < SIGNAL_LIMITS.MIN_SAMPLES) return null;

  const mid = Math.floor(trades.length / 2);
  const half = (xs: readonly SignalTrade[]): number => {
    const strength = xs.reduce((a, t) => a + t.signalStrength, 0);
    if (!(strength > 0)) return 0; /* 信号强度全为 0 → 无法算"单位强度收益" */
    return xs.reduce((a, t) => a + t.returnPct, 0) / strength;
  };

  const earlyRatio = half(trades.slice(0, mid));
  const lateRatio = half(trades.slice(mid));

  /*
   * ⚠️ 前半为 0（或负）时**不给比值** —— 除法的结果没有意义
   *（"从 0 衰减到 0"不是衰减；"从 -1 到 -0.5"更不是"改善 50%"）。
   * 返回 `ok: false` 让调用方知道"这个指标这次不适用"。
   */
  if (!(earlyRatio > 0)) {
    return { ok: false, earlyRatio, lateRatio, decayRatio: 0, note: '前半段单位强度收益非正 —— 无法判断衰减' };
  }

  const decayRatio = lateRatio / earlyRatio;
  const note = decayRatio < 0.5
    ? `⚠️ **反应显著衰减**（后半只有前半的 ${(decayRatio * 100).toFixed(0)}%）—— 市场可能已消化这类消息`
    : decayRatio < 0.8
      ? `反应略有衰减（${(decayRatio * 100).toFixed(0)}%）—— 继续观察`
      : `反应正常（${(decayRatio * 100).toFixed(0)}%）`;

  return { ok: true, earlyRatio, lateRatio, decayRatio, note };
}
