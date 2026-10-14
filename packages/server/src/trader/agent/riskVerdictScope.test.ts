/**
 * **风控官的表态必须只看"结论行"，不能被论证里的条件句带偏**
 *（2026-10-14 线上实测抓到的 BUG —— 它让 43% 的批准被拦下）
 *
 * ## 事故（`#11`，40 轮里 17 轮 = 43% 自相矛盾）
 *
 * ```
 *   <risk>
 *   否决（group/auto-qfmodel）：## 风控审批结论：**批准** ✅   ← 前缀否决、理由批准
 *   担心：唯一开仓（QUSDT）名义仅 10 USDT…可忽略不计。
 *   </risk>
 *   <decision>[]</decision>                                    ← 订单没发出
 * ```
 * 而风控官原文（`c160`）明确批准：
 * ```
 *   ## 风控审批结论：**批准** ✅
 *   唯一开仓（QUSDT）名义仅10 USDT、保证金1 USDT、止损锁死亏损上限约0.1 USDT
 *   ——即便止损因小币流动性断裂而失效，最坏损失也只是1 USDT保证金归零，
 *   对账户风险敞口可忽略不计。
 * ```
 *
 * ## 根因：两个判定的**扫描范围不一致**
 *
 * ```
 *   reason  = 第一行            ← 「批准 ✅」
 *   approve = 全文正则
 *   reject  = 全文正则          ← 论证里的条件句（"若 X 则否决"）会命中
 *   → reject 优先 → approved=false → 渲染成"否决"
 * ```
 *
 * ## 修法：三级优先（从窄到宽），每一级里"否决优先"的安全方向不变
 *
 * ```
 *   ① 第一行（结论行）  ② 前 3 行  ③ 全文兜底
 * ```
 *
 * ⚠️ 这个 BUG 的代价是**双向**的：不只让 43% 的批准被拦，
 * 还让操作员看到"否决：批准 ✅"这种自相矛盾的审计块 ——
 * 而审计块的唯一用途就是"事后能说清当时为什么这么做"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

const OPEN: Decision[] = [{ symbol: 'QUSDT', action: 'open_long', leverage: 10, positionSizeUsd: 10 } as Decision];

/** 线上 `c160` 的真实原文（去掉渲染层加的前缀）。 */
const C160 = [
  '## 风控审批结论：**批准** ✅',
  '唯一开仓（QUSDT）名义仅10 USDT、保证金1 USDT、止损锁死亏损上限约0.1 USDT——即便止损因小币流动性断裂而失效，最坏损失也只是1 USDT保证金归零，对账户风险敞口可忽略不计。',
].join('\n');

test('★★★ 结论行说"批准"，论证里含"否决"条件句 → 必须放行（线上 c160）', () => {
  const v = parseRiskOfficerVerdict(C160, OPEN);
  assert.equal(v.approved, true, '★ 结论行是"批准"，不能被论证里的字眼带偏 —— 这是 43% 误拦的根因');
  assert.ok(v.reason.includes('批准'), '★ reason 与 approved 必须一致（否则审计块自相矛盾）');
});

test('★★★ 结论行"批准" + 第二行"若跌破则否决" → 仍必须放行（线上 c155）', () => {
  /*
   * ⚠️ 这是"前 3 行"与"第 1 行"的边界：
   * 第 2 行的"否决"是**条件句**（"若 X 则否决"），不是"我现在否决"。
   * 所以表态区必须**第一行优先**，不能直接取 3 行。
   */
  const text = [
    '## 风险审查结论：**批准** ✅（附强制条件）',
    '条件：若跌破止损位则否决本次开仓并立即平仓。',
  ].join('\n');
  const v = parseRiskOfficerVerdict(text, OPEN);
  assert.equal(v.approved, true, '★ 条件句里的"否决"不是否决 —— 第一行优先');
});

test('★★★ 结论行就是"否决" → 必须拦住（安全方向不变）', () => {
  const v = parseRiskOfficerVerdict('## 否决\n保证金占用过高，账户无法承受。', OPEN);
  assert.equal(v.approved, false, '★ 明确的否决必须拦住');
});

test('★★★ 结论行"不同意"（否定式）→ 必须拦住', () => {
  const v = parseRiskOfficerVerdict('## 不同意\n名义价值超过账户承受能力。', OPEN);
  assert.equal(v.approved, false, '★ "不同意"是模型常用词，且不含"否决/拒绝"');
});

test('★★ 结论行没表态 → 全文兜底仍然生效（不能因为收窄范围而漏判）', () => {
  /*
   * 模型把结论写在末尾时（罕见但会发生），全文兜底必须仍然能找到它。
   */
  const text = ['材料我看了。', '逐条核对后，我的结论是：否决。'].join('\n');
  const v = parseRiskOfficerVerdict(text, OPEN);
  assert.equal(v.approved, false, '★ 结论行没表态时要扫全文兜底');
});

test('★★ 第一行是 JSON 时跳过它（它不是表态）', () => {
  const text = ['{"a":1}', '## 批准', '风险可接受。'].join('\n');
  const v = parseRiskOfficerVerdict(text, OPEN);
  assert.equal(v.approved, true, '★ JSON 行不是结论行，要跳到下一行');
});

test('★ 削减表态仍然识别（reduce 语义不能丢）', () => {
  const v = parseRiskOfficerVerdict('## 风险审批结论：部分批准 · 削减 QUSDT\n名义偏大。', OPEN);
  assert.equal(v.approved, true, '★ 削减属于放行');
  assert.equal(v.reduced, true, '★ 必须识别"削减"');
});
