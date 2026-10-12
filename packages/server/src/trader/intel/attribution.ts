/**
 * **信号归因** —— 把"情报 → 决策 → 成交"这条链记下来。
 *
 * ## 为什么必须有它（`signalHealth` 的输入）
 *
 * `intel/signalHealth.ts` 实现了失效检测（胜率崩塌 / 连续亏损 / **反应衰减**），
 * 但它的输入是 **"由某个信号驱动的成交"** —— 而这个概念**现在不存在**：
 *
 * ```
 *   情报（freshness）→ 决策 → 成交        ← 这条链断了
 *                      ↑ 成交没有记住"它是被哪条情报驱动的"
 * ```
 *
 * 没有它，`signalHealth` 就是**空转**：它拿不到"这个信号的历史成交"，
 * 于是**永远返回 `insufficient_data`**（那个"不下结论"的保守分支）。
 *
 * **现象会是**：代码在跑、测试通过、日志正常 —— 但**失效检测从未生效**。
 * 这与上一轮发现的 `freshness` 空转是**同一类问题**（"实现了逻辑 ≠ 逻辑在生效"）。
 *
 * ## 记录什么
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `signalKey` | **归因主键** —— 哪条情报（用"来源域名 + 方向 + 标的"做键）|
 * | `returnPct` | 该笔的收益（`signalHealth` 的核心输入）|
 * | `signalStrength` | 当时那条情报的**权重**（`freshness` 的 `weight`）—— 反应衰减要用它 |
 *
 * ## ⚠️ 为什么用"来源域名 + 方向 + 标的"做键（而不是情报 id）
 *
 * 情报是**一次性的**（每次调研都产生新条目），若用它自己的 id 做键，
 * **每个信号只会有一笔成交** → 永远达不到 `MIN_SAMPLES`（20）→ 失效检测**永远不生效**。
 *
 * 而"来源 + 方向 + 标的"是**可复现的归类**：
 * 例如"coindesk 报道 BTC 利多"这个**信号类型**会跨很多轮重复出现，
 * 于是能积累出足够样本。**这才是"策略/信号"的正确粒度。**
 */

import type { SignalTrade } from './signalHealth.js';

/** 一条归因记录（一笔成交 + 它由什么驱动）。 */
export interface Attribution {
  /** 归因主键：`<来源域名>|<方向>|<标的>`。 */
  signalKey: string;
  /** 该笔的收益率（相对本笔投入）。 */
  returnPct: number;
  /** 开仓时那条情报的权重（`freshness.decay().weight`，0~1）。 */
  signalStrength: number;
  /** 平仓时刻（毫秒）。 */
  closedAt: number;
}

/**
 * 构造归因主键。
 *
 * ⚠️ **标的排序后拼接** —— 否则 `BTC,ETH` 与 `ETH,BTC` 会被当成两个不同的信号，
 * 于是样本被劈成两半，**都达不到门槛**。
 */
export function signalKeyOf(input: {
  sourceHost: string;
  direction: string;
  symbols: readonly string[];
}): string {
  const syms = [...input.symbols].sort().join(',');
  return `${input.sourceHost.toLowerCase()}|${input.direction}|${syms}`;
}

/**
 * 从归因记录里取出某个信号的成交序列（按时间顺序）。
 *
 * 这就是 `signalHealth.assessSignal()` 的输入。
 */
export function tradesForSignal(
  all: readonly Attribution[],
  signalKey: string,
): SignalTrade[] {
  return all
    .filter((a) => a.signalKey === signalKey)
    .sort((x, y) => x.closedAt - y.closedAt)
    .map((a) => ({ returnPct: a.returnPct, signalStrength: a.signalStrength }));
}

/**
 * 列出所有**够样本量**的信号键。
 *
 * ⚠️ 为什么只返回够样本的：`signalHealth` 对不足样本的输入会返回
 * `insufficient_data`（保守正确），但**调用方通常只关心"哪些信号该被检查"**。
 * 把过滤放在这里，避免调用方为每个只出现 1 次的信号跑一遍评估。
 */
export function signalsWithEnoughSamples(
  all: readonly Attribution[],
  minSamples: number,
): string[] {
  const counts = new Map<string, number>();
  for (const a of all) counts.set(a.signalKey, (counts.get(a.signalKey) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= minSamples).map(([k]) => k);
}

/**
 * **过滤掉模型"编造"的情报键**（2026-10-12，防幻觉的关键一环）。
 *
 * ## 为什么必须有它
 *
 * 模型被要求"标注这条决策依据了哪几条情报"。但**它可能写出一个不存在的情报键**：
 *
 * ```
 *   给它的情报：coindesk.com|bullish|BTCUSDT
 *   它写的：    bloomberg.com|bullish|BTCUSDT     ← 编的
 * ```
 *
 * **后果（而且很隐蔽）**：那个编造的键会**永远只有一个样本**
 *（因为下次不会再有同样的编造），于是：
 * · 它永远达不到 `MIN_SAMPLES` → 失效检测对它**永不生效**；
 * · 更糟的是，它让"归因数据"看起来比实际更丰富 ——
 *   操作员会以为"这个信号有历史"，其实**一条都没有**。
 *
 * ## 判据：**只接受"这次真的给过它的"键**
 *
 * 这是唯一可靠的判据 —— 不能靠"域名看起来像不像真的"，
 * 因为模型编的域名**看起来完全正常**。
 *
 * @param claimed 模型写出的键
 * @param known 这次调用**实际给过它**的情报键
 * @returns `kept` 通过校验的；`rejected` 被剔除的（**要记日志** —— 编造率本身是有用信号）
 */
export function filterKnownIntelKeys(
  claimed: readonly string[],
  known: readonly string[],
): { kept: string[]; rejected: string[] } {
  const allowed = new Set(known);
  const kept: string[] = [];
  const rejected: string[] = [];
  for (const k of claimed) {
    if (allowed.has(k)) kept.push(k);
    else rejected.push(k);
  }
  return { kept, rejected };
}
