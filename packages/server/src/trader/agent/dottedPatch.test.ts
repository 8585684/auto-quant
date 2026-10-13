/**
 * **点号路径的补丁不能被静默丢弃**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"它告诉模型成功了"**的失败 —— 最坏的一类：
 * ```
 *   patch_json:   {"riskControl.minPositionSize": 5}
 *   applied_json: minPositionSize = **12**      ← 没改
 *   clamps_json:  []                            ← 也没说"被拒绝"
 * ```
 * 而 `set_params` 的工具文档**推荐的就是点号写法**（原文）：
 * ```
 *   Adjustable: coin selection (coinSource.*), indicators (indicators.*),
 *               how much you risk (riskControl.*, throttle.*, circuitBreaker.*)
 * ```
 * 于是模型改参数 → 看到"补丁已生效" → 下一轮读到**旧值** → 再改一次 → 反复空转。
 *
 * ## 实测现场（`#11` 的策略师，实验 `#79`）
 *
 * 它**正确地诊断出了死锁**（那是本轮最亮眼的一次模型表现）：
 * ```
 *   reason: "DEADLOCK CONFIRMED: minPositionSize(12) > max achievable
 *            notional(equity 20.75 × positionValueRatio 50% = 10.375).
 *            No position can ever be opened — the minimum size exceeds the maximum."
 * ```
 * 而**那个修复被静默丢掉了**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAgentPatch } from './patch.js';
import { defaultStrategyConfig } from '@aq/shared';

test('★★★ 点号路径必须能改到嵌套字段（这是工具文档推荐的写法）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl.minPositionSize': 5 });
  assert.equal(
    r.config.riskControl.minPositionSize,
    5,
    '★ `{"riskControl.minPositionSize": 5}` 必须真的改到它（而不是被静默丢弃）',
  );
  assert.equal(r.rejected, null, '★ 不该整体拒绝');
});

test('★★★ 嵌套写法仍然有效（旧行为逐字节不变）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { riskControl: { minPositionSize: 5 } });
  assert.equal(r.config.riskControl.minPositionSize, 5);
});

test('★★★ 两种写法混用时都要生效（合并，不互相覆盖）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, {
    'riskControl.minPositionSize': 5,
    riskControl: { maxPositions: 7 },
  });
  assert.equal(r.config.riskControl.minPositionSize, 5, '★ 点号那个要生效');
  assert.equal(r.config.riskControl.maxPositions, 7, '★ 嵌套那个也要生效');
});

test('★★★ 多层的点号路径也要能写（`promptSections.entryStandards`）', () => {
  /*
   * ⚠️ 这是最常用的一类：策略师改写自己的规则文本。
   * 若它也只支持一层，模型"改自己的规则"会静默失败。
   */
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'promptSections.entryStandards': '新规则' });
  assert.equal(r.config.promptSections.entryStandards, '新规则');
});

test('★★★ 未知字段仍然被丢弃（展开不放宽安全性）', () => {
  /*
   * ⚠️ 这是**安全边界**：展开只解决"写法"，不该让模型往配置里塞东西。
   */
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl.不存在的字段': 999 });
  assert.equal(
    '不存在的字段' in (r.config.riskControl as Record<string, unknown>),
    false,
    '★ 未知字段必须仍被丢弃',
  );
  const r2 = applyAgentPatch(current, { '完全不存在的段.x': 1 });
  assert.equal(r2.rejected, null, '★ 但也不该整体拒绝（一个坏键不该让整条作废）');
});

test('★ 坏输入（空段）被跳过，而不是整条拒绝', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl..minPositionSize': 5, 'riskControl.maxPositions': 9 });
  assert.equal(r.rejected, null, '★ 不该整条拒绝');
  assert.equal(r.config.riskControl.maxPositions, 9, '★ 好的那个键仍要生效');
});
