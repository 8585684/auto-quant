/**
 * **下游（辩论者/裁决官）必须能看到候选的完整序列**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"看不出来"的 BUG**：裁决官**一个候选都看不到**，
 * 而它仍然会给出看起来很合理的裁决（"另 6 候选无指标序列"）——
 * 从界面上完全看不出它其实什么都没看到。
 *
 * ## 事故的形状
 *
 * ```
 *   材料结构： # 账户 → # 全市场概览（525 标的，约 1.8 万字）→ # 候选标的（12 个）
 *   原代码：   marketContext.slice(0, 12000)
 *   → 前 12000 字符【全部落在"全市场概览"里】→ 覆盖 0 个候选
 * ```
 * 实测：`完整材料 130,420 字符 · 前 12,000 字符覆盖 **0 个候选**`。
 *
 * ## 而它的后果被"分工"掩盖了
 *
 * `debateMaterial` 的注释里写着"完整材料已由分析师消化，下面是前段"——
 * 听起来合理。**但"前段"里没有候选**，所以下游拿到的不是"摘要"，
 * 而是**与交易无关的那部分**（全市场概览）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { headOfMarket } from './tradingDesk.js';

/** 造一份与真实结构同形的材料（概览很长、候选在后面）。 */
function material(candidates: number, eachChars = 3_000): string {
  const overview = [
    '# 账户',
    '权益 20.75 USDT',
    '# 全市场概览（币安 525 个 USDT 永续）',
    ...Array.from({ length: 400 }, (_, i) => `SYM${i}USDT 1.23 -1.5% 456M`),
  ].join('\n');
  const cands = Array.from({ length: candidates }, (_, i) =>
    `### ${i + 1}. CAND${i}USDT（coinpool）\ncurrent_price = ${i}\n` +
    `价格: [${Array.from({ length: Math.max(1, eachChars / 10) }, (_, j) => j).join(', ')}]`,
  ).join('\n');
  return `${overview}\n${cands}\n`;
}

test('★★★ 关键回归：材料开头是长概览时，仍必须包含候选段', () => {
  /*
   * ⚠️ 这是那个 BUG 的**直接形状**：概览占满了预算 → 候选一个都没有。
   */
  const src = material(12);
  const out = headOfMarket(src, 24_000);
  assert.ok(out.totalCandidates >= 10, `★ 应当识别出候选段（实际 ${out.totalCandidates}）`);
  assert.ok(
    out.candidatesShown >= 1,
    '★★★ 必须至少给出一个候选的完整序列（否则裁决官是"盲审"）',
  );
  /* 而且给出的必须是**完整段**（不是切一半的指标序列）。 */
  assert.ok(
    out.text.includes('### 1. CAND0USDT'),
    '★ 第一个候选必须在里面',
  );
  assert.ok(
    out.text.includes('价格: ['),
    '★ 且它的指标序列必须在里面（不能只给标题）',
  );
});

test('★★★ 概览不能被整段丢掉 —— 它是"大盘背景"（辩论要用）', () => {
  const out = headOfMarket(material(12), 24_000);
  assert.ok(out.text.includes('# 账户'), '★ 账户段必须保留');
  assert.ok(
    out.text.includes('全市场概览'),
    '★ 概览段必须保留（辩论"顺势还是逆势"要靠它）',
  );
});

test('★ 没有候选段时退回前缀（持仓管理轮不该拿到空材料）', () => {
  const noCand = '# 账户\n权益 20.75\n# 当前持仓\nETHUSDT 多 0.01\n';
  const out = headOfMarket(noCand, 24_000);
  assert.equal(out.totalCandidates, 0);
  assert.ok(out.text.includes('权益 20.75'), '★ 应当退回前缀，而不是给空串');
});

test('★ 候选极长时至少给一个（宁可超预算，也不要给"没有候选"）', () => {
  /*
   * ⚠️ 一个候选段就可能超过预算（实测未压缩时单段 11,993 字符）。
   * 那时**必须给第一个** —— 否则回到"零候选"的 BUG。
   */
  const one = material(1, 40_000);
  const out = headOfMarket(one, 12_000);
  assert.equal(out.candidatesShown, 1, '★ 至少要给第一个候选');
  assert.ok(out.text.includes('CAND0USDT'));
});

test('★ 切分用行首锚定（正文里偶然出现的 ### 1. 不该被当候选段）', () => {
  const withInline = '# 账户\n权益 20.75\n正文里提到 ### 1. 这不是候选段\n# 概览\nA 1 B 2\n';
  const out = headOfMarket(withInline, 24_000);
  /* 行内那处不该被当成候选起点 —— 所以 `totalCandidates` 应当是 0（没有真候选）。 */
  assert.equal(out.totalCandidates, 0, '★ 只认行首的 ### N. ');
});
