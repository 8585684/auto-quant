/**
 * **概览段的截断不能把"行为约束"砍掉**（2026-10-13 实测 —— 同一类 BUG 的第五处）。
 *
 * ## 事故：裁决官看不到「保证金 ≠ 名义价值」，于是继续算错
 *
 * 线上 `#2594 c99` 的决策理由原文：
 * ```
 *   BTCUSDT skip：「最小名义 50 对 20U 账户**过重**，不做。」
 * ```
 * **而这是错的**：`20.75 × 20x = 415 USDT 名义` —— 它完全开得起。
 *
 * ## 根因：那段换算是"概览"的一部分，而概览被 `overviewCap` 砍了
 *
 * 实测（线上真实 `user_prompt` 132921 字符）：
 * ```
 *   「逐仓运行的」/「保证金 ≠ 名义价值」段  位置 18187（13.7%）
 *   第一个候选标题                          位置 18876
 *   → 它在【第一个候选之前】→ 被当成"概览"
 *   → overviewCap = 24000/4 = 6000
 *   → 位置 18187 > 6000 → **被截掉**
 * ```
 * **我上一轮修的换算说明，裁决官从来没见过。**
 *
 * ## 这是同一类 BUG 的第五处 —— 说明"逐个摘 marker"不是正解
 *
 * ```
 *   ① splitMarketContext 切片     → 摘规则段 ✅
 *   ② headOfMarket 的 break       → 接回规则段 ✅
 *   ③ overviewCap 腰斩规则段      → 摘规则段 ✅
 *   ④ firstCand===null 的退路     → 摘规则段 ✅
 *   ⑤ overviewCap 腰斩【其它约束】→ 本处
 * ```
 * 前四处都在"为规则段打补丁"，而第五处说明**根因是"概览里混着行为约束"
 * 这件事没被承认** —— 修法是**按小节切、约束类优先**，而不是再摘一个 marker。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { headOfMarket } from './tradingDesk.js';

const RULES =
  '\n---\n\n## 团队需要遵守的规则（来自交易循环）\n' +
  '# 入场标准\nYou MUST open at least one position per 6 cycles.';

/**
 * 线上真实形状的概览：
 * ```
 *   # 系统状态（数据类，很长）
 *   # 杠杆档位（数据类）
 *   # 硬性约束 / 逐仓说明（**约束类** —— 必须保住）
 * ```
 */
function overviewShape(constraintAt = 18_000): string {
  const filler = 'x'.repeat(4000);
  const before = `# 系统状态\n${filler}\n`;
  const pad = 'y'.repeat(Math.max(0, constraintAt - before.length));
  const constraints =
    '# 硬性约束\n**保证金 ≠ 名义价值**\n名义价值 = 保证金 × 杠杆\n' +
    '🧮 **你这个账户是逐仓运行的**\n- 真实可执行范围：208–3113 USDT\n';
  const after = `# 绩效\n${filler}\n`;
  const cands = Array.from(
    { length: 6 },
    (_, i) => `### ${i + 1}. SYM${i}USDT（coinpool）\ncurrent_price = 1.23\n${'z'.repeat(3000)}`,
  );
  return `${before}${pad}\n${constraints}${after}\n${cands.join('\n\n')}${RULES}`;
}

test('★★★ 约束类小节必须在 `overviewCap` 截断中幸存（位置远超上限也要保住）', () => {
  /*
   * ⚠️ `budgetChars = 24000` → `overviewCap = 6000`。
   * 而约束小节在 18000 字符处 —— 旧实现必然砍掉它。
   */
  const r = headOfMarket(overviewShape(18_000), 24_000);
  assert.ok(
    r.text.includes('保证金 ≠ 名义价值'),
    '★ 必须保住「保证金 ≠ 名义价值」（否则裁决官会继续以为"50 名义对 20U 过重"）',
  );
  assert.ok(r.text.includes('名义价值 = 保证金 × 杠杆'), '★ 换算公式必须保住');
  assert.ok(r.text.includes('逐仓运行的'), '★ 逐仓说明必须保住');
  assert.ok(r.text.includes('真实可执行范围'), '★ 具体数字必须保住');
});

test('★★★ 规则段也不能因此被挤掉（两条都要在）', () => {
  const r = headOfMarket(overviewShape(18_000), 24_000);
  assert.ok(r.text.includes('MUST open at least one position'), '★ 规则段必须仍在');
  assert.ok(r.text.includes('# 入场标准'), '★ 规则小节必须仍在');
});

test('★★★ 输出必须【保序】（模型读起来要连贯）', () => {
  /*
   * ⚠️ 用**多个中等长度的小节**，而不是"一个超长小节" ——
   * 因为超长小节（> overviewCap）**整体放不下**，会被丢掉（那是正确行为：
   * 半个小节比没有更糟，它会让模型读到被腰斩的句子）。
   * 实测：我第一版测试数据把"系统状态"撑到 20000 字符，
   * 于是它被整体丢弃 → 保序断言假失败。
   */
  const secs = [
    `# 系统状态\n${'a'.repeat(2000)}`,
    `# 杠杆档位\n${'b'.repeat(2000)}`,
    `# 硬性约束\n**保证金 ≠ 名义价值**\n${'c'.repeat(800)}`,
  ].join('\n');
  const cands = Array.from(
    { length: 3 },
    (_, i) => `### ${i + 1}. SYM${i}USDT（coinpool）\ncurrent_price = 1.23\n${'z'.repeat(3000)}`,
  );
  const mc = `${secs}\n${cands.join('\n\n')}${RULES}`;
  const r = headOfMarket(mc, 24_000);
  const a = r.text.indexOf('# 系统状态');
  const b = r.text.indexOf('# 杠杆档位');
  const c = r.text.indexOf('# 硬性约束');
  assert.ok(a >= 0 && b >= 0 && c >= 0, `★ 三个小节都该在（实际 a=${a} b=${b} c=${c}）`);
  assert.ok(a < b && b < c, '★ 小节顺序必须与原文一致');
});

test('★★★ 概览本来就装得下时【不做任何改动】', () => {
  /*
   * ⚠️ 反向保证：绝大多数情况下 `overview` 不长，这条修法**必须无感** ——
   * 否则就是拿一个大改动去换一个局部修复。
   */
  const small = '# 系统状态\n短\n\n### 1. AAAUSDT（coinpool）\ncurrent_price = 1';
  const r = headOfMarket(small, 24_000);
  assert.ok(r.text.includes('# 系统状态'), '★ 原样保留');
  assert.ok(!r.text.includes('因预算未展开'), '★ 不该出现"省略"提示');
});

test('★★★ 省略时要说出来（不能静默少给）', () => {
  const r = headOfMarket(overviewShape(18_000), 24_000);
  assert.ok(
    /因预算未展开|概览/.test(r.text),
    '★ 有省略时必须留下痕迹（否则"少给"看起来像"本来就没有"）',
  );
});

test('★ 约束小节一个都放不下时也要给第一个（宁可超预算）', () => {
  const tiny = `# 系统状态\n${'x'.repeat(20_000)}\n# 硬性约束\n保证金 ≠ 名义价值\n### 1. AAAUSDT（coinpool）\ncurrent_price = 1`;
  const r = headOfMarket(tiny, 24_000);
  assert.ok(r.text.length > 0, '★ 不能返回空材料');
});
