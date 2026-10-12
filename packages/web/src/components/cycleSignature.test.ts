import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cycleSignature } from './DecisionFeed.js';

/**
 * ★★★ **缺字段的历史记录不能让整块看板崩掉**（2026-10-12 实测抓到的真 BUG）。
 *
 * ## 事故形状
 *
 * 本地库里有一条记录 `[{"symbol":"BTCUSDT","action":"open_long"}]` ——
 * **只有 symbol 与 action**（既没有 `confidence`，`decisions_json` 也极短）。
 * 而 `cycleSignature` 原来直接读 `record.decisions.length`，于是抛
 * `Cannot read properties of undefined (reading 'length')`。
 *
 * 关键在于**它发生在渲染路径上**：`FeedErrorBoundary` 捕获后
 * 把**整块决策看板**换成一张错误卡 —— 实测现象是"最近决策"里出现
 * 「这一块渲染失败」，而**团队看板完全不显示**。
 *
 * ## 为什么要给旧数据兜底
 *
 * 决策记录是**跨版本累积**的 —— 早先的写入路径、测试数据未必带全字段。
 * 看板必须容忍旧数据，否则**一次版本升级就会让历史全部打不开**。
 */
test('★★★ 缺 decisions / executionLog 字段时不抛错（旧记录必须能打开）', () => {
  const legacy = {
    id: 9,
    error: null,
    decisions: undefined,
    executionLog: [{ status: 'ok', action: 'open_long', symbol: 'BTCUSDT', detail: null }],
  } as never;

  /* 修复前：这一行会抛 TypeError，进而让整块看板被错误边界替换。 */
  const sig = cycleSignature(legacy);
  assert.equal(typeof sig, 'string', '有两个数组之一非空时应当能算出签名（可合并）');
});

test('★ 两个数组都缺 → 返回 null（这一轮不参与合并）', () => {
  const empty = { id: 1, error: null, decisions: undefined, executionLog: undefined } as never;
  assert.equal(cycleSignature(empty), null);
});

test('★ 失败轮次永远单独显示（不受字段缺失影响）', () => {
  const failed = { id: 2, error: '崩了', decisions: undefined, executionLog: undefined } as never;
  assert.equal(cycleSignature(failed), null, '失败轮次要单独显示，不参与合并');
});

test('★ 正常记录仍能算出稳定签名（回归：改动不能破坏原行为）', () => {
  const ok = {
    id: 3,
    error: null,
    decisions: [{ action: 'open_long', symbol: 'BTCUSDT', confidence: 80 }],
    executionLog: [],
  } as never;
  const a = cycleSignature(ok);
  assert.ok(a !== null && a.includes('open_long'), '签名要包含动作');
  assert.equal(a, cycleSignature(ok), '同一内容签名必须稳定（合并依赖它）');
});