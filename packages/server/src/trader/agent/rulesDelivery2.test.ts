/**
 * **策略师的规则必须送到【每一条路径】上的角色**（2026-10-13 实测 P0）。
 *
 * ## 事故：95 轮 · 217 条决策 · 全部 skip · 0 成交
 *
 * 策略师自己写的规则（`#11` 的 `system_prompt` 原文）：
 * ```
 *   「You MUST open at least one position per 6 cycles if any symbol showed a
 *     ≥2% move. If you skip for 6 straight cycles, your entry standards are
 *     too strict by construction — override them.」
 * ```
 * **它没有遵守自己写的规则** —— 因为那条规则**从来没到过它手上**。
 *
 * ## 两条独立的丢法（都要修，缺一不可）
 *
 * `routedModel.ts:863` 把规则段拼在材料**最后**：
 * ```
 *   marketContext = userPrompt + '\n---\n\n## 团队需要遵守的规则\n' + systemPrompt
 * ```
 *
 * **路径 ①（分析师）—— 被切片丢掉**
 * ```
 *   symbolSlices.splitMarketContext 按 '### N. SYMBOL' 切
 *   → shared 只取【第一个候选之前】的部分
 *   → 规则段被并进【最后一个候选的切片】
 *   → analystContext 只取【前 6 个切片】→ 规则段一起被丢
 *   → 修：把尾巴【搬回 shared】（updated 2026-10-13）
 * ```
 *
 * **路径 ②（辩论者 / 裁决官）—— 被预算 break 丢掉**
 * ```
 *   headOfMarket 的循环：if (used + p.length > budgetChars) break;
 *   → 预算 12,000 用完就 break → 规则段在最后一个 part → 永远进不了 picked
 *   → 修：把尾巴【无条件接回去】（updated 2026-10-13）
 * ```
 *
 * ## 线上决定性证据
 *
 * `#11` 最新一轮的 `cot_trace`（四个分析师 + 裁决官的产出）里：
 * ```
 *   "MUST open at least one position"  ❌ 未命中
 *   "default-to-action"                ❌ 未命中
 *   "opportunity cost"                 ❌ 未命中
 * ```
 * 而 `marketContext` 里**确实拼了**它（拼装代码写明了）——
 * **它在拼装之后、送进角色之前被丢掉了。**
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { headOfMarket } from './tradingDesk.js';
import { compactMarketContext, splitMarketContext } from './symbolSlices.js';

/** 与线上同形的材料：概览 + N 个候选 + 末尾规则段（带足够大的正文让预算吃紧）。 */
function onlineLike(candCount = 12, bodyPerCand = 9000): string {
  const body = `current_price = 1.23\ncurrent_ema20 = 1.20\n${'x'.repeat(bodyPerCand)}`;
  const cands = Array.from(
    { length: candCount },
    (_, i) => `### ${i + 1}. SYM${i}USDT（coinpool）\n${body}`,
  );
  const rules =
    '\n---\n\n## 团队需要遵守的规则（来自交易循环）\n' +
    '# 入场标准\nYou MUST open at least one position per 6 cycles.';
  return `# 全市场概览\n525 个标的…\n\n${cands.join('\n\n')}${rules}`;
}

/* -------------------------------------------------------------------------- */
/*  路径 ②：headOfMarket（辩论者 / 裁决官）                                       */
/* -------------------------------------------------------------------------- */

test('★★★ `headOfMarket` 必须保留末尾的规则段（预算 break 会把它丢掉）', () => {
  /*
   * ⚠️ 这条是本文件最重要的断言：`budgetChars` 故意给小（12,000），
   * 而每个候选 9,000 字符 → 只能放 1 个候选 → 规则段**必然在 break 之后**。
   */
  const r = headOfMarket(onlineLike(), 12_000);
  assert.ok(
    r.text.includes('MUST open at least one position'),
    `★ 规则段必须被保留（实际材料长度 ${r.text.length}，候选显示 ${r.candidatesShown}）`,
  );
});

test('★★★ 规则段不能被复制两份（材料里出现两次会让模型以为有两套规则）', () => {
  /* 预算极大 → 所有 part 都进 picked（含规则段）→ 不该再追加一次。 */
  const r = headOfMarket(onlineLike(2, 200), 1_000_000);
  const n = (r.text.match(/MUST open at least one position/g) ?? []).length;
  assert.equal(n, 1, `★ 规则段应恰好出现 1 次（实际 ${n} 次）`);
});

test('★★★ 没有规则段时不能凭空多出东西（原样退化成修之前的行为）', () => {
  const noRules = '# 概览\n### 1. AAAUSDT（coinpool）\ncurrent_price = 1';
  const r = headOfMarket(noRules, 12_000);
  assert.ok(!r.text.includes('团队需要遵守的规则'), '★ 不该凭空造规则段');
  assert.ok(r.text.includes('AAAUSDT'), '★ 候选内容要留着');
});

test('★★★ 候选段本身不能被规则段污染（规则不属于任何候选）', () => {
  const r = headOfMarket(onlineLike(3, 100), 1_000_000);
  /* 规则段应出现在【所有候选之后】—— 即最后一次出现位置 > 最后一个候选标题位置。 */
  const rulesAt = r.text.indexOf('MUST open at least one position');
  const lastCandAt = r.text.lastIndexOf('### 3. SYM2USDT');
  assert.ok(rulesAt > lastCandAt, '★ 规则段必须在候选之后（不能插进候选中间）');
});

/* -------------------------------------------------------------------------- */
/*  路径 ①：切片（四个分析师）                                                    */
/* -------------------------------------------------------------------------- */

test('★★★ `splitMarketContext` 也必须把规则段放进 `shared`', () => {
  const r = splitMarketContext(onlineLike());
  assert.ok(r !== null, '★ 必须能切分');
  assert.ok(
    r.shared.includes('MUST open at least one position'),
    '★ 规则段必须在 shared 里（那才随【每个】切片发给角色）',
  );
  for (const s of r.slices) {
    assert.ok(!s.text.includes('## 团队需要遵守的规则'), `★ 切片 ${s.symbol} 不该含规则段`);
  }
});

test('★★★ `compactMarketContext` 端到端也要带上规则（分析师实际走这条路）', () => {
  const c = compactMarketContext(onlineLike());
  assert.ok(c !== null, '★ 必须能压缩');
  assert.ok(
    c.shared.includes('MUST open at least one position'),
    '★ 压缩后的 shared 里必须仍有规则段',
  );
});

/* -------------------------------------------------------------------------- */
/*  两条路径都得修（缺一不可）                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ 两条路径都必须保留规则 —— 只修一条等于没修', () => {
  /*
   * ⚠️ 这条断言防的是"修了分析师、忘了裁决官"（或反过来）——
   * 而**裁决官才是最终决策者**。它拿不到规则，前面四个分析师再懂也没用。
   */
  const viaHead = headOfMarket(onlineLike(), 12_000).text;
  const viaSlices = splitMarketContext(onlineLike())!.shared;
  assert.ok(viaHead.includes('MUST open at least one position'), '★ headOfMarket 路径必须保留');
  assert.ok(viaSlices.includes('MUST open at least one position'), '★ 切片路径必须保留');
});
