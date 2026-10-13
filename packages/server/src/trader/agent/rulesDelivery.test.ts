/**
 * **策略师写的规则必须真的到得了团队角色**（2026-10-13 实测 P0）。
 *
 * ## 事故：95 轮 100% skip，规则被切片逻辑吃掉了
 *
 * 推理链（四处各自都没错，串起来错了）：
 * ```
 *   ① routedModel.ts:863  marketContext = userPrompt
 *                                       + '\n---\n\n## 团队需要遵守的规则\n' + systemPrompt
 *                          → 策略师的规则段被拼在【材料最后】
 *   ② symbolSlices.ts     按 '### N. SYMBOL' 切分
 *                          → shared 只取【第一个候选之前】的部分
 *                          → 【规则段被并进最后一个候选的切片】
 *   ③ tradingDesk         analystContext 只取【前 6 个切片】
 *                          → 最后一个切片（含规则段）【被丢掉】
 *   ④ 结果：四个分析师 + 裁决官【从来没见过策略师写的规则】
 * ```
 *
 * 线上实证 —— 策略师自己写的规则（`#11` 的 `system_prompt`）原文：
 * ```
 *   「You MUST open at least one position per 6 cycles if any symbol
 *     showed a ≥2% move. If you skip for 6 straight cycles, your entry
 *     standards are too strict by construction — override them.」
 * ```
 * 而实测：**95 轮全部 skip · 212 条决策 0 个非 skip · orders 0 · trades 0**。
 *
 * ⚠️ 这条规则**确实验证过在 `system_prompt` 里**（grep 命中）；
 * 它也确实验证过在 `marketContext` 里（拼装代码写明了）——
 * **只是被切片逻辑吃掉了**。这正是"看起来一切正常"的那类失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { splitMarketContext } from './symbolSlices.js';

/** 造一份与线上同形的材料（候选 + 末尾的规则段）。 */
function marketContextWithRules(): string {
  const body = 'current_price = 1.23\ncurrent_ema20 = 1.20';
  const cands = [
    'AAAUSDT（ai_requested）',
    'BBBUSDT（ai_requested）',
    'CCCUSDT（coinpool）',
    'DDDUSDT（coinpool）',
  ].map((h, i) => `### ${i + 1}. ${h}\n${body}`);
  const rules =
    '\n---\n\n## 团队需要遵守的规则（来自交易循环）\n' +
    '# 入场标准\nYou MUST open at least one position per 6 cycles if any symbol showed a ≥2% move.';
  return `# 候选标的（4 个）\n${cands.join('\n\n')}${rules}`;
}

test('★★★ 末尾的规则段必须留在 `shared` 里（不能被并进最后一个候选切片）', () => {
  const r = splitMarketContext(marketContextWithRules());
  assert.ok(r !== null, '★ 必须能切分');
  assert.ok(
    r.shared.includes('MUST open at least one position per 6 cycles'),
    '★ 规则段必须在 `shared` 里 —— 那才会随【每个】切片一起发给角色',
  );
});

test('★★★ 最后一个候选的切片里【不能】再留着规则段', () => {
  /*
   * ⚠️ 搬回而不是复制：复制会让最后一个候选的段落里也留着规则，
   * 而分析师会把它当成"这个标的的规则" —— 那正是要避免的混淆。
   */
  const r = splitMarketContext(marketContextWithRules());
  const last = r!.slices[r!.slices.length - 1]!;
  assert.ok(
    !last.text.includes('MUST open at least one position'),
    '★ 规则段不能被复制进候选切片（要"搬走"）',
  );
  assert.ok(
    last.text.includes('DDDUSDT'),
    '★ 最后一个候选自己的内容必须留着',
  );
});

test('★★★ 每个切片的 `text` 不能被规则段污染（切片只该含自己的材料）', () => {
  const r = splitMarketContext(marketContextWithRules());
  for (const s of r!.slices) {
    assert.ok(
      !s.text.includes('## 团队需要遵守的规则'),
      `★ 切片 ${s.symbol} 里不该有规则段`,
    );
  }
});

test('★★★ 找不到规则标记时【原样返回】（不猜、不丢）', () => {
  /*
   * ⚠️ 若哪天拼材料的格式变了，这里会退化成"规则段仍在最后一个切片里"
   * —— 也就是**修之前的行为**，而不是把材料弄坏。
   * 静默弄坏材料比"退回旧行为"糟得多。
   */
  const noRules = '# 候选标的（2 个）\n### 1. AAAUSDT（coinpool）\ncurrent_price = 1\n### 2. BBBUSDT（coinpool）\ncurrent_price = 2';
  const r = splitMarketContext(noRules);
  assert.ok(r !== null);
  assert.equal(r.slices.length, 2, '★ 不能凭空多/少切片');
  assert.equal(r.slices[1]!.symbol, 'BBBUSDT');
});

test('★★★ `compactMarketContext` 也必须把规则带进 shared（端到端）', async () => {
  /*
   * ⚠️ 这条防的是"修了 split 但 compact 里丢了" ——
   * 实际给分析师的材料走的是 `compactMarketContext`（它先 split 再压缩）。
   */
  const { compactMarketContext } = await import('./symbolSlices.js');
  const c = compactMarketContext(marketContextWithRules());
  assert.ok(c !== null, '★ 必须能压缩');
  assert.ok(
    c.shared.includes('MUST open at least one position'),
    '★ 压缩后的 `shared` 里必须仍有规则段',
  );
});
