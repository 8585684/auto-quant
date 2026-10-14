/**
 * **挑出"配置要的、且真的算出来了"的那个 ATR 周期**（外部 issue #179）。
 *
 * ## 为什么需要它
 *
 * `atr` 的键来自 `config.atrPeriods`（`market/indicators.ts` 用
 * `atrSeries[String(period)]` 构造），而该字段：
 *
 * - 默认 `[14]`（`shared/strategy.ts:140`）
 * - **界面上可改**（`StrategyFields.tsx`）
 * - **AI 可调**
 *
 * 但三处取值写死了 `'14'`：
 *
 * ```
 * prompt.ts:2816       c.primary?.atr?.['14']       ← 连续观望提醒的 ATR 统计
 * prompt.ts:4324       snap?.primary?.atr?.['14']   ← 挂单时限估算
 * autoTrader.ts:4754   snap?.primary?.atr?.['14']   ← 真实撤单时限
 * ```
 *
 * 配置里一旦不含 14（例如被改成 `[7]`）：
 *
 * 1. **提示词里那整块统计/估算无声消失**（没有 else、没有 fallback、没有告警）；
 * 2. `autoTrader.ts` 那处落空 → 时限退回固定值 →
 *    **"自适应时限"静默退化成固定值** —— 那是**能力降级**，不只是少显示一行字。
 *
 * ## 为什么是"只有一份实现"
 *
 * 三处取值、三处消费逻辑各不相同，但"**怎么挑周期**"这件事必须一致。
 * 各写一遍的话，将来必然出现"改了两处、漏了一处" ——
 * 而本仓库反复吃过这个亏（`CLOSE_REASONS` 与标签、`supportedSkins` 与 CSS、
 * `ink-soft` 与主题覆盖，都是同一形态）。
 *
 * ## 语义
 *
 * - 按 `atrPeriods` 的**顺序**找第一个**实际存在**的序列；
 * - 一个都找不到 → `values: null` + `requested`（让调用方能**说清配置要了哪些**）；
 * - **不 fallback 到 14**：配置为空说明"没有要求任何 ATR"，
 *   猜一个 14 会让调用方以为有数据、而那不是配置要的。
 */

export interface PickedAtr {
  /** 取到的序列；`null` 表示配置要的周期一个都没算出来。 */
  values: Array<number | null> | null;
  /** 实际用到的周期号；`null` 时无意义。 */
  period: number | null;
  /** 配置里要的周期（用于在"取不到"时把话说清楚）。 */
  requested: number[];
}

/**
 * 从 `atr` 记录里挑出配置要的第一个可用周期。
 *
 * @param atr         `TimeframeIndicators.atr`（键是 `String(period)`）
 * @param atrPeriods  配置里的周期列表（`config.atrPeriods`）
 */
export function pickAtrSeries(
  atr: Record<string, Array<number | null>> | undefined,
  atrPeriods: readonly number[],
): PickedAtr {
  const requested = [...atrPeriods];
  if (!atr) return { values: null, period: null, requested };

  for (const period of requested) {
    const series = atr[String(period)];
    if (Array.isArray(series)) return { values: series, period, requested };
  }
  return { values: null, period: null, requested };
}
