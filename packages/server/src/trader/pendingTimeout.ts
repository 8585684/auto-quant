/**
 * 挂单时限 —— 按"走到挂价需要多久"算，而不是一个固定值。
 *
 * ## 为什么固定值是个设计缺陷（2026-10-01 实测）
 *
 * 线上实例：DOGEUSDT 挂 0.095241，现价 0.095860 → 距离 **0.646%**；
 * 15m ATR ≈ **0.212%**。按随机游走，走到 `0.646 / 0.212 ≈ 3.05` 倍 ATR 的位置，
 * 预期需要 `3.05² ≈ 9.3` 根 15m K 线 = **139 分钟**。
 *
 * 而系统给的时限是 **45 分钟** —— 那张单在数学上**必然**等不到就被撤掉，
 * 模型下一轮再挂同一个价位：
 *
 *     78 张限价单被撤 / 44 张成交，最近一次成交在 20 小时前
 *
 * 「挂多远」是**模型的判断**（结构位回踩是一种合理的交易方式）。
 * 系统该做的是**给那个判断足够的时间去验证**，而不是用一刀切的时限否定它 ——
 * 那正是用户说的「系统要最大化配合模型」。
 *
 * ## 口径
 *
 * 随机游走（不是线性外推）：走到 `x` 倍 ATR 的距离，预期需要 `x²` 根 K 线。
 * 线性外推（`x` 根）在 3 倍 ATR 上会把时间低估 3 倍 —— **一个让挂单过早被撤的
 * 数字比不给更糟**，因为它看起来还算过。
 */

/**
 * 每根 K 线的分钟数（`pendingTimeoutMinutes` 的**缺省**口径）。
 *
 * ⚠️ **生产调用点不要用这个常量** —— 用 `timeframeBarMinutes(snap.primary.timeframe)`。
 * 保留它只为"缺省 = 15"这个既有语义（本文件的距离/ATR 最初都按 15m 口径写，
 * 而 `pendingTimeout.test.ts` 里那 5 条既有用例没传 `barMinutes`）。
 */
export const BAR_MINUTES = 15;

/**
 * 某个周期下**一根 K 线是多少分钟**。
 *
 * ## 为什么需要它（外部 issue #165）
 *
 * `prompt.ts:4319` 取的 ATR 来自 **`snap.primary`** —— 主周期指标，
 * 而 `primaryTimeframe` **默认是 `'5m'`**（`shared/strategy.ts:86`）且**可配置**。
 * 而本文件原来把 `BAR_MINUTES = 15` **写死**在算式里：
 *
 * ```ts
 * const needed = bars * BAR_MINUTES * SAFETY_FACTOR;   // ← 15，但 ATR 可能是 5m 的
 * ```
 *
 * 5m ATR 约为 15m ATR 的 `1/√3`，于是 `atrPercent` 偏小 → `inAtrs` 偏大 →
 * `bars = inAtrs²` 偏大 → **`needMinutes` 系统性偏大**。
 * 而同一个值也喂给 `autoTrader.ts:4686` 的**真实撤单时限** ——
 * 所以它改变了真实的挂单等待时长，不只是提示词里的一句话。
 *
 * ## 为什么不是"把 15 改成 5"
 *
 * 因为主周期**可配置**（`1m`…`1d`）。写死任何一个值都会在别的配置下重新错。
 * 正确做法是从 `TimeframeIndicators.timeframe`（`indicators.ts:42` 自带该字段）
 * 推导 —— 调用方拿得到它，不需要改结构。
 *
 * ⚠️ 未来若 `TIMEFRAMES` 加了新周期，本函数**必须**同步 ——
 * `pendingTimeout.test.ts` 有一条用例遍历 `TIMEFRAMES` 逐个断言，
 * 漏掉时它会当场变红。
 */
export function timeframeBarMinutes(timeframe: string): number {
  const m = /^(\d+)([mhd])$/.exec(timeframe);
  if (!m) return BAR_MINUTES;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return BAR_MINUTES;
  const unit = m[2];
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;
  return value * 24 * 60; // 'd'
}

/**
 * 时限的硬上限（8 小时）。
 *
 * 挂得极远时算出来的分钟数可以很大（10 倍 ATR → 100 根 ≈ 25 小时）。
 * 而 `maxPositions` 通常只有 3 —— 一张永不过期的单等于**永久占用一个名额**，
 * 那比"撤掉重挂"更糟。
 */
export const PENDING_TIMEOUT_MAX_MINUTES = 480;

/**
 * 安全系数：给"预期所需时间"留一点余量。
 *
 * 随机游走是**期望值**，实际达到某个价位的时间分布很散（重尾）。
 * 1.5 而不是 2：宁可略早撤、让模型重新决定，也不要让一张单占名额一整天。
 */
const SAFETY_FACTOR = 1.5;

/**
 * 算出某张挂单的时限（分钟）。
 *
 * @param baseMinutes     配置里的 `pendingEntryTimeoutMinutes`（模型可调）
 * @param distancePercent 挂价与现价的距离（绝对值，百分比）
 * @param atrPercent      15m ATR 占现价的百分比
 *
 * 规则：**取"配置值"与"预期所需时间 × 安全系数"的较大者，再封顶**。
 * 永远不缩短配置值 —— 那会让正常的近价挂单被系统提前砍掉，方向正好相反。
 */
export function pendingTimeoutMinutes(input: {
  baseMinutes: number;
  distancePercent: number;
  atrPercent: number;
  /**
   * ATR 来自哪个周期的 K 线 —— **一根多少分钟**。
   *
   * ⚠️ **生产调用点必须显式传**（外部 issue #165）：`atrPercent` 与
   * "一根 K 线多久"必须同口径，否则算出的 `needed` 会系统性偏大或偏小。
   * 用 `timeframeBarMinutes(snap.primary.timeframe)` 推导。
   *
   * 缺省 15 只为保持既有语义（见 `BAR_MINUTES` 的说明）。
   */
  barMinutes?: number;
}): number {
  const base = Number.isFinite(input.baseMinutes) ? input.baseMinutes : 0;
  /* `0` = 关闭这条规则（本项目同类字段的既有约定），关闭就该是关闭。 */
  if (base <= 0) return 0;

  const distance = input.distancePercent;
  const atr = input.atrPercent;
  /*
   * ⚠️ 数据不完整时**退回配置值**，不要算。
   * `atr = 0` 会让比值变成 `Infinity`，而 `Infinity` 传给定时器等于"永不过期"。
   */
  if (!Number.isFinite(distance) || !Number.isFinite(atr) || atr <= 0 || distance <= 0) {
    return base;
  }

  /*
   * ⚠️ `barMinutes` 非法时退回 `BAR_MINUTES` —— 不能让它把时限变成 NaN。
   * NaN 传给定时器是"永不过期"或"立刻过期"，两者都危险。
   */
  const barMinutes =
    input.barMinutes !== undefined && Number.isFinite(input.barMinutes) && input.barMinutes > 0
      ? input.barMinutes
      : BAR_MINUTES;

  const inAtrs = distance / atr;
  const bars = inAtrs * inAtrs; // 随机游走：x 倍 ATR 需要 x² 根
  const needed = bars * barMinutes * SAFETY_FACTOR;

  return Math.min(PENDING_TIMEOUT_MAX_MINUTES, Math.max(base, Math.ceil(needed)));
}
