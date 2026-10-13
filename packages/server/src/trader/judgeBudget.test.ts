/**
 * **裁决官的 JSON 数组不能被输出预算截断**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是"零决策"的**最后一环**，而它极难发现：
 * ```
 *   ① 裁决官的结论"不行动"看起来是【一个判断】，不是"输出被截断"
 *   ② 审计块里只显示前 4000 字 —— 而截断发生在更后面
 *   ③ raw_response 里那一行 `{` 看起来很自然（谁会去数括号？）
 * ```
 * 我前几轮一直在查"提示词、模型、门槛"，**而真相是"预算不够"**。
 *
 * ## 实测现场（`#2552 c75`）
 *
 * 裁决官输出了正确的 13 条 `skip`，而线上落库的是：
 * ```
 *   ```json
 *   [
 *     {"symbol":"WUSDT","action":"skip","confidence":80,"reasoning":"急跌后短修复但1
 *   </team>
 * ```
 * **数组在第一个元素中间被截断** → `extractFirstJsonArray` 报 `bad-json`
 * → `decisions = []` → **整轮零决策**。
 *
 * 而它的推理部分（1,171 字）是**完整的** —— 推理把预算用光，数组只分到 83 字符。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ROLE_MAX_TOKENS } from './routedModel.js';

const ROUTED = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');
const TRADING_DESK = readFileSync(
  new URL('./agent/tradingDesk.ts', import.meta.url),
  'utf8',
);

test('★★★ 裁决官的输出预算必须容得下"推理 + 13 条 skip 的数组"', () => {
  /*
   * 实测算术：
   * ```
   *   judge 的推理 ≈ 1,200 字 ≈ 1,800 tokens
   *   13 条 skip 的 JSON ≈ 1,500 字 ≈ 2,200 tokens
   *   合计 ≈ 4,000 tokens —— **4096 是刚好不够**
   * ```
   */
  const judge = ROLE_MAX_TOKENS.judge ?? 0;
  assert.ok(
    judge >= 6_000,
    `★ 裁决官的预算必须 ≥ 6,000（实测 4,096 不够：推理+13条数组 ≈ 4,000 且留余量；实际 ${judge}）`,
  );
  /* ⚠️ 但也不能无限大 —— T3 的超时是 180 秒，而实测 8192 tokens 约 40–80 秒。 */
  assert.ok(
    judge <= 16_384,
    `★ 也不能过大（T3 超时 180 秒，实际 ${judge}）`,
  );
});

test('★★★ 提示词必须要求"先输出数组，再写理由"', () => {
  /*
   * ⚠️ 这比"把预算调大"更根本：预算总有上限，
   * 而**先写关键字段**让"被截断"这件事不再致命。
   */
  assert.ok(
    TRADING_DESK.includes('先输出 JSON 数组，再写你的理由'),
    '★ 必须明确要求顺序（数组在前）',
  );
  assert.ok(
    TRADING_DESK.includes('数组是机器读的，必须完整'),
    '★ 并说明为什么（让模型理解这条要求，而不是机械遵守）',
  );
  /* ⚠️ 旧的"结论之后必须附一个 JSON 数组"必须改掉 —— 那句话正是 BUG 的来源。 */
  assert.ok(
    !TRADING_DESK.includes('结论之后**必须**附一个 JSON 数组'),
    '★ "结论之后"那句必须删（它让数组排在最后，正好被截断）',
  );
});

test('★ 预算表里 judge 是最大的那几个之一（它是输出最长的角色）', () => {
  /*
   * ⚠️ 裁决官要写：结论 + 置信度 + 依据 + "不同意哪一方" +
   * 不确定性 + 失效条件 + **N 条候选的完整数组**。
   * 它比任何单个分析师都长。
   */
  const judge = ROLE_MAX_TOKENS.judge ?? 0;
  for (const role of ['newscaster', 'sentiment', 'technical']) {
    const v = ROLE_MAX_TOKENS[role] ?? 0;
    assert.ok(
      judge > v,
      `★ judge(${judge}) 应当大于 ${role}(${v}) —— 它要写完整数组`,
    );
  }
});
