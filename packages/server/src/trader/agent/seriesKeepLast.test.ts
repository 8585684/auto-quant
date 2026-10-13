/**
 * **K 线序列不能压得太狠 —— 模型算不出真实止损**（2026-10-13 线上实测）。
 *
 * ## 模型自己指出的问题（裁决官原文）
 *
 * `#11` 的 `c103`：
 * ```
 *   「最大不确定性是**序列被截断（每周期省略前 25 根）**，
 *     看不到真实摆动低点/均量，**BLUR/ETH 的止损只能估算**」
 * ```
 * 而"止损只能估算"直接导致它拒绝开仓 —— 它的入场标准要求
 * "可执行的失效位"，而**估算出来的失效位不算可执行**。
 *
 * ## 量化代价（用线上真实材料测的）
 *
 * 单个候选（`OGNUSDT`，原文 11,867 字符，40 条序列 × 约 30 点）：
 * ```
 *   keepLast= 5 →  3,711 字符（31%）   ← 旧值
 *   keepLast=10 →  5,626 字符（47%）   ← 新值（多 51%）
 *   keepLast=30 → 11,867 字符（100%）
 * ```
 * 分析师材料：`38,689 → 49,373` 字符（+28%）。
 *
 * ## ⚠️ 为什么不能直接给完整序列
 *
 * 材料规模直接决定角色会不会超时/写不出内容（本项目已踩过三次）：
 * ```
 *   6 标的（26,281 字符）→ 15.1s · content= 434 字  ✅
 *   12 标的（54,971 字符）→ mt=2048 时 content= 0 字  ❌
 * ```
 * 20 个候选给完整序列 = 24 万字符 → **必崩**。
 *
 * ⚠️ 这是止血，不是根治。根治是"按币并行"（每人一个标的）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';

const DESK = readFileSync(new URL('./tradingDesk.ts', import.meta.url), 'utf8');

test('★★★ 分析师材料必须用 `keepLast = 10`（不能退回 5）', () => {
  /*
   * ⚠️ 判据是**调用处显式传 10**，而不是"默认值是 10" ——
   * 默认值改了不会影响这个调用点（它原来就没传参）。
   */
  const code = codeOnly(DESK);
  assert.ok(
    /compactMarketContext\(input\.marketContext, 10\)/.test(code),
    '★ 必须显式传 10 —— 5 个点算不出真实摆动低点，模型会因"止损只能估算"而拒绝开仓',
  );
});

test('★★★ 不能传一个"等于不压缩"的值（那会让材料回到 24 万字符）', () => {
  const code = codeOnly(DESK);
  const m = /compactMarketContext\(input\.marketContext,\s*(\d+)\)/.exec(code);
  assert.ok(m !== null, '★ 应该能找到调用点');
  const keep = Number(m![1]);
  assert.ok(keep >= 8, `★ keepLast 不能小于 8（实际 ${keep}）—— 少于 8 个点看不出摆动结构`);
  assert.ok(keep <= 15, `★ keepLast 不能大于 15（实际 ${keep}）—— 材料会失控，角色写不出内容`);
});

test('★ 关掉压缩的开关必须还在（便于对照测试）', () => {
  const code = codeOnly(DESK);
  assert.ok(
    /AQ_COMPACT_CONTEXT === 'off'/.test(code),
    '★ `AQ_COMPACT_CONTEXT=off` 的退路不能被删',
  );
});
