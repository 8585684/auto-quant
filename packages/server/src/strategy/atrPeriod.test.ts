/**
 * **ATR 的周期号不能写死 `'14'`**（外部 issue #179）。
 *
 * ## 缺陷形状
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
 * 一旦配置里不含 14（例如用户/AI 把它改成 `[7]`）：
 *
 * 1. **提示词里那整块统计/估算无声消失** —— 没有 else、没有 fallback、没有告警；
 * 2. `autoTrader.ts` 那处同样落空 → 时限退回固定值 →
 *    **"自适应时限"静默退化成固定值**（那是能力降级，不只是少显示一行字）。
 *
 * ## 修法（两个方向组合，与 issue 里的建议一致）
 *
 * - **A**：优先取 `atrPeriods` 里**实际存在的**第一个周期；
 * - **B**：一个都取不到时**显式说明**，而不是让整块消失。
 *
 * ## 为什么抽成纯函数
 *
 * 三处取值 + 三处不同的消费逻辑，如果各写一遍"怎么挑周期"，
 * 将来必然出现"改了两处、漏了一处"（本仓库反复吃过这个亏）。
 * 所以挑周期这件事**只有一份实现**，三处共用。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickAtrSeries } from './atrPeriod.js';

/** 造一个 `atr: Record<string, number[]>` 形状。 */
function series(keys: string[], value = 1): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of keys) out[k] = [value];
  return out;
}

test('★★★ 配置里第一个周期存在时就用它 —— 不能写死 14', () => {
  const atr = series(['7', '14']);

  /* 配置是 `[7]`：必须用 7，而不是去要那个不存在的 14。 */
  const picked = pickAtrSeries(atr, [7]);
  assert.deepEqual(picked.values, [1], '★ 必须取到 7 的序列');
  assert.equal(picked.period, 7, '★ 报出实际用的周期号（调用方要能说清口径）');
});

test('★★★ 配置里第一个不存在、第二个存在时用第二个', () => {
  /* 配置 `[3, 14]` 而只算了 14 —— 不该整块消失，应当用 14。 */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, [3, 14]);
  assert.deepEqual(picked.values, [1]);
  assert.equal(picked.period, 14);
});

test('★★★ 一个都取不到时返回 null，并报出"配置要了哪些"', () => {
  /*
   * 这是 issue 里的方向 B：**显式说明**而不是静默跳过。
   * 返回 `null` 让调用方自己决定怎么说明（提示词里加一行、或日志里留一条），
   * 而 `requested` 让那句话能说清"配置要的是哪些周期"。
   */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, [7, 21]);
  assert.equal(picked.values, null, '★ 取不到就是 null，不能返回空数组（那会被当成"ATR 是空的"）');
  assert.deepEqual(picked.requested, [7, 21], '★ 要能说出配置里要的是哪些周期');
});

test('★★ 配置为空数组时同样返回 null —— 不猜一个默认值', () => {
  /*
   * ⚠️ **不 fallback 到 14**：配置是空的说明"没有要求任何 ATR"，
   * 猜一个 14 会让调用方以为有数据、而那个数据不是配置要的。
   * 这与 `atrPeriods: []` 的语义一致（schema 允许空数组）。
   */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, []);
  assert.equal(picked.values, null, '★ 配置为空 → null，不猜默认值');
  assert.deepEqual(picked.requested, []);
});

test('★★ 14 在配置里时行为与修复前一致 —— 反向守卫', () => {
  /*
   * 默认配置是 `[14]`，所以**绝大多数部署的行为必须一字不变**。
   */
  const atr = series(['14'], 42);
  const picked = pickAtrSeries(atr, [14]);
  assert.deepEqual(picked.values, [42], '★ 默认配置下取到的就是 14 的序列');
  assert.equal(picked.period, 14);
});

test('★ atr 记录为空对象时返回 null —— 不能抛', () => {
  assert.equal(pickAtrSeries({}, [14]).values, null);
  assert.equal(pickAtrSeries(undefined, [14]).values, null, 'undefined 也要安全');
});

test('★ 非整数 / 重复的配置项不会导致取错 —— 按 String(period) 精确匹配', () => {
  const atr = series(['14']);
  /* 配置里混入一个不存在的 7.5，不能因此取到别的东西。 */
  const picked = pickAtrSeries(atr, [7.5, 14]);
  assert.equal(picked.period, 14, '★ 7.5 不存在 → 继续找，取到 14');
  /* 重复项不影响结果。 */
  assert.equal(pickAtrSeries(atr, [14, 14]).period, 14);
});
