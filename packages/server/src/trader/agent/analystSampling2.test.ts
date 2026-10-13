/**
 * **"摘要型候选"不该和"完整型候选"平等地占取样名额**（2026-10-13）。
 *
 * ## 真问题（线上材料实测，`#11` c90）
 *
 * ```
 *   # 候选标的（14 个）
 *   **前 10 个给出完整指标序列**；**其余只给摘要**（最新值 + 最近 5 根的走向）
 *
 *     1. GTCUSDT  11823 字符  ← 完整（ai_requested）
 *     ...  （1–6 全是 ai_requested，全部完整）
 *     7. BTCUSDT   9961 字符  ← 完整（coinpool）
 *     8. ETHUSDT   9337 字符  ← 完整（coinpool）
 *     9. SOLUSDT  10404 字符  ← 完整（coinpool）
 *    10. ZECUSDT   9255 字符  ← 完整（coinpool）
 *    11. NEARUSDT  1107 字符  ← **只有摘要**（coinpool）
 *    12. XRPUSDT   1104 字符  ← **只有摘要**
 *    13. HYPEUSDT  1102 字符  ← **只有摘要**
 *    14. DOGEUSDT  2302 字符  ← **只有摘要**
 * ```
 *
 * `analystContext` 只取 6 个，而 `compactMarketContext` 把 14 个**全部**
 * 当成可取样切片（它按 `### N. SYMBOL` 切，**不区分"完整/摘要"**）。
 *
 * ## 为什么这是个问题
 *
 * ```
 *   完整型切片 ≈ 10,000 字符 → 有价值（有指标序列可分析）
 *   摘要型切片 ≈  1,100 字符 → 只有"最新值 + 最近 5 根走向"
 * ```
 * 按**个数**分配名额时两者**平等** —— 最坏情况是"3 个完整 + 3 个摘要"，
 * 一半名额花在没序列的标的上。
 *
 * 更糟的是"摘要型"在材料里**看起来也是候选**，于是分析师会去点评它们，
 * 而它只能看到价格与涨跌 —— 线上实测它真的这么做了：
 * > 「另外 8 个候选（ai_requested 3 个 + coinpool 5 个）我只看到符号/价格/涨跌，
 * >   没有任何指标序列，连它们是谁都不知道。」
 *
 * ## 判据：按"有没有指标序列"分流
 *
 * ```
 *   detailed  —— 段落里含指标序列 → 优先取样
 *   summary   —— 只有摘要        → 只在名额有剩时才取
 * ```
 * ⚠️ **"优先"不是"排除"** —— 摘要型仍然可能被取到（完整型不够时），
 * 因为"知道有这个标的在"本身也有价值。但要**先取完整的**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isDetailedSlice, pickForAnalysis } from './analystSampling.js';

type Slice = { symbol: string; text: string; sources: string[] };

/** 造"完整型"切片（含指标序列）。 */
const detailed = (sym: string, src: string): Slice => ({
  symbol: sym,
  text: `### 1. ${sym}（${src}）\ncurrent_price = 1.23, current_ema20 = 1.20, current_ema50 = 1.18\n（12 根 K 线）`,
  sources: [src],
});

/** 造"摘要型"切片（只有最新值 + 最近 5 根走向）。 */
const summary = (sym: string, src: string): Slice => ({
  symbol: sym,
  text: `### 1. ${sym}（${src}）\n最新 1.23 · 最近 5 根走向：↑↑↓↑↓`,
  sources: [src],
});

test('★★★ `isDetailedSlice` 必须能区分"完整序列"与"只有摘要"', () => {
  assert.equal(isDetailedSlice(detailed('AAAUSDT', 'coinpool').text), true, '★ 含指标序列 = 完整');
  assert.equal(isDetailedSlice(summary('BBBUSDT', 'coinpool').text), false, '★ 只有摘要 = 不是完整');
});

test('★★★ 完整型必须【优先】占名额（摘要型不该抢占）', () => {
  /*
   * 线上真实形状：6 个 ai（完整）+ 4 个 coin 完整 + 4 个 coin 摘要，limit=6。
   * 期望：取到 6 个**完整的**（3 ai + 3 coin），而不是混进摘要型。
   */
  const slices = [
    detailed('GTCUSDT', 'ai_requested'),
    detailed('OGNUSDT', 'ai_requested'),
    detailed('QUSDT', 'ai_requested'),
    detailed('WUSDT', 'ai_requested'),
    detailed('SKLUSDT', 'ai_requested'),
    detailed('DOSUSDT', 'ai_requested'),
    detailed('BTCUSDT', 'coinpool'),
    detailed('ETHUSDT', 'coinpool'),
    detailed('SOLUSDT', 'coinpool'),
    detailed('ZECUSDT', 'coinpool'),
    summary('NEARUSDT', 'coinpool'),
    summary('XRPUSDT', 'coinpool'),
    summary('HYPEUSDT', 'coinpool'),
    summary('DOGEUSDT', 'coinpool'),
  ];
  const { picked } = pickForAnalysis(slices, 6);
  assert.equal(picked.length, 6);
  for (const p of picked) {
    assert.ok(isDetailedSlice(p.text), `★ 取到的都该是完整型（实际取到了摘要型 ${p.symbol}）`);
  }
  /* 而"两类都有代表"这条旧判据仍然成立。 */
  const srcs = picked.map((p) => p.sources[0]);
  assert.ok(srcs.includes('ai_requested') && srcs.includes('coinpool'), '★ 两类都要有代表');
});

test('★★★ 完整型不够时，摘要型必须能补位（不能白白浪费名额）', () => {
  /*
   * ⚠️ "优先"不是"排除" —— 若完整型只有 2 个而 limit=5，
   * 剩下的名额该给摘要型（"知道有这个标的在"本身也有价值），
   * 而不是只给 2 个、白扔 3 个名额。
   */
  const slices = [
    detailed('AAAUSDT', 'coinpool'),
    detailed('BBBUSDT', 'coinpool'),
    summary('CCCUSDT', 'coinpool'),
    summary('DDDUSDT', 'coinpool'),
    summary('EEEUSDT', 'coinpool'),
  ];
  const { picked } = pickForAnalysis(slices, 5);
  assert.equal(picked.length, 5, '★ 名额要填满（摘要型补位）');
});

test('★★★ 全是摘要型时不能返回空（那就等于没有材料）', () => {
  const slices = [summary('AAAUSDT', 'coinpool'), summary('BBBUSDT', 'ai_requested')];
  const { picked } = pickForAnalysis(slices, 2);
  assert.equal(picked.length, 2, '★ 全是摘要时仍要给出材料');
});
