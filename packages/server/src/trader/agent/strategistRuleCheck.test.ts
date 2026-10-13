/**
 * **策略师必须能发现"我定的规则被绕过了"**（2026-10-14 实测抓到的缺口）
 *
 * ## 事故（线上 `#11` `c127`）
 *
 * ```
 *   策略师写的 entryStandards：
 *     「skip 的【唯一】合法理由是 (a) 无标的 ≥0.8% 位移 或 (b) 点差/深度不足。
 *       No other condition gates entry.
 *       若 (a) 满足 → 【必须】开仓，'选择不交易'是违规」
 *
 *   bull 的论证：BLURUSDT 位移 +2.43% ≥ 0.8% → 触发
 *   裁决官的判决：skip，理由「反弹追多是接飞刀，两边赔率都不成立」
 *                ← 规则外的第 (c) 个理由
 * ```
 * **规则被绕过了，而策略师连续多轮都没发现。**
 *
 * ## 缺口有两处（本文件各钉一条）
 *
 * ```
 *   ① `recentDecisions` 只给 action、不给 reasoning
 *      → 它读得到"BLUR 被 skip 了"，读不到"为什么" → 无从判断规则是否被遵守
 *   ② `strategistTask` 没让它去核对规则遵守情况
 *      → 数据齐了它也不知道该找什么（本项目反复出现的"能力在、没人告诉它要用"）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';

const PORTS = codeOnly(readFileSync(new URL('./ports.ts', import.meta.url), 'utf8'));
const ORCH = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

test('★★★ `recentDecisions` 必须给每条决策的 `reasoning`（否则规则无法被校准）', () => {
  assert.ok(
    /reasoning: x\.reasoning/.test(PORTS),
    '★ 必须把 reasoning 给策略师 —— 只看得到 action 就无从判断"规则是否被遵守"',
  );
  /* 截断是刻意的：一轮 20 条完整理由会吃掉策略师的上下文预算。 */
  assert.ok(
    /slice\(0, 200\)/.test(PORTS),
    '★ 必须截断到 200 字（一轮 20 条完整理由会挤掉它的推理空间）',
  );
});

test('★★★ `strategistTask` 必须让它去核对规则遵守情况', () => {
  assert.ok(
    /核对你写的入场标准有没有被遵守/.test(ORCH),
    '★ task 里必须显式要求它核对规则遵守情况 —— 数据齐了也要有人告诉它去找什么',
  );
  assert.ok(
    /recent_decisions/.test(ORCH),
    '★ 必须点名用哪个工具（它手上有这个工具，但要告诉它用它来干这件事）',
  );
});

test('★ 发现不一致时【不替它选】—— 改规则与放宽规则都是正当结论', () => {
  /*
   * ⚠️ 措辞必须中立：策略师的职责就是定规则，我不该在 task 里
   * 暗示"必须加强约束"（那会逼出坏交易）。
   */
  assert.ok(
    /把规则改得更明确/.test(ORCH) && /放宽规则/.test(ORCH),
    '★ 两个方向都要给（改明确 / 放宽）—— 我不替它选',
  );
});

test('★ 不能放任不一致（task 必须说清"这不是可选项"）', () => {
  assert.ok(
    /不要放任这个不一致存在/.test(ORCH),
    '★ 必须说清它的严重性 —— 否则它可能读到了也不处理',
  );
});
