import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFunnel, DEFAULT_FUNNEL, type FunnelCandidate, type FunnelStage } from './funnel.js';

const c = (symbol: string, vol: number, change: number, amp: number): FunnelCandidate =>
  ({ symbol, quoteVolume24h: vol, changePercent24h: change, amplitudePercent: amp });

test('★★★ 500 → 30 量级：全市场收敛到可交给 AI 的少数', () => {
  /*
   * 用户的要求：「交易所有 500 个可以交易的币……**层层筛选**」。
   * 这一层是**代码**做的（毫秒级、免费、确定性），不是 LLM。
   */
  const all: FunnelCandidate[] = [];
  for (let i = 0; i < 500; i += 1) {
    /* 大部分是小成交额（会被第一层淘汰）。 */
    all.push(c(`SYM${i}`, (i + 1) * 100_000, (i % 20) - 10, 1 + (i % 30)));
  }
  const r = runFunnel(all);
  assert.ok(r.survivors.length <= 30, `最终应 ≤30（实际 ${r.survivors.length}）`);
  assert.ok(r.survivors.length > 0, '不该一个都不剩');
  assert.equal(r.stages.length, DEFAULT_FUNNEL.length, '逐层都要有报告');
});

test('★★★ 每层的淘汰都要能解释（操作员要能问"我的币为什么没被看到"）', () => {
  const all = [c('BIG', 200_000_000, 5, 8), c('SMALL', 1_000_000, 5, 8)];
  const r = runFunnel(all);
  const first = r.stages[0]!;
  assert.equal(first.name, '流动性');
  assert.equal(first.input, 2);
  assert.equal(first.output, 1);
  assert.equal(first.dropped, 1);
  assert.ok(first.note.includes('成交额'), `说明要写清依据（实际：${first.note}）`);
  assert.ok(first.note.includes('M'), '要带具体阈值');
});

test('★★★ 数值无效（NaN）的标的必须淘汰，不能"静默放行"', () => {
  /*
   * ⚠️ 这是个**真实陷阱**：`NaN >= 5e7` 是 false（看起来会被淘汰），
   * 但如果写成 `c.min !== undefined && NaN < min` 也是 false → **放行**。
   * 两种写法行为相反 —— 所以必须显式检查有限性，不依赖比较运算的偶然行为。
   *
   * 放行 NaN 的后果：AI 会拿到一个"成交额 NaN"的标的，
   * 然后基于**假事实**做判断。
   */
  const all = [c('NANVOL', Number.NaN, 5, 8), c('NANCHG', 200_000_000, Number.NaN, 8), c('OK', 200_000_000, 5, 8)];
  const r = runFunnel(all);
  assert.deepEqual(r.survivors.map((s) => s.symbol), ['OK'], '★ NaN 必须被淘汰');
});

test('★★ 涨跌幅看【绝对值】：我们要"有动静"，方向交给 AI 判断', () => {
  /*
   * 粗筛不该预判方向 —— 那是 AI 的活。
   * 若只看涨幅，会系统性漏掉所有做空机会。
   */
  const stages: FunnelStage[] = [{ name: '有动静', require: { minAbsChangePercent: 3 } }];
  const r = runFunnel([c('UP', 1e8, 5, 8), c('DOWN', 1e8, -5, 8), c('FLAT', 1e8, 0.5, 8)], stages);
  assert.deepEqual(r.survivors.map((s) => s.symbol).sort(), ['DOWN', 'UP'], '★ 涨和跌都该留下');
});

test('★ 排序取前 N：按成交额或振幅（这一层"选谁"的依据）', () => {
  const all = [c('A', 1e8, 1, 3), c('B', 5e8, 1, 2), c('C', 2e8, 1, 20)];
  const byVol = runFunnel(all, [{ name: '按成交额', orderBy: 'quoteVolume', keep: 2 }]);
  assert.deepEqual(byVol.survivors.map((s) => s.symbol), ['B', 'C'], '按成交额降序取前 2');
  const byAmp = runFunnel(all, [{ name: '按振幅', orderBy: 'amplitude', keep: 2 }]);
  assert.deepEqual(byAmp.survivors.map((s) => s.symbol), ['C', 'A'], '按振幅降序取前 2');
});

test('★ 空输入 / 无硬条件 → 不崩、不静默丢数据', () => {
  assert.deepEqual(runFunnel([]).survivors, []);
  const passthrough = runFunnel([c('X', 1, 1, 1)], [{ name: '不过滤' }]);
  assert.equal(passthrough.survivors.length, 1, '没有条件时应当原样通过');
  assert.equal(passthrough.stages[0]!.note.includes('无硬条件'), true);
});

test('★ 全被淘汰时也给出报告（不能静默返回空）', () => {
  const r = runFunnel([c('TINY', 1_000, 1, 1)]);
  assert.equal(r.survivors.length, 0);
  assert.equal(r.stages[0]!.dropped, 1, '★ 淘汰数要如实记录，否则操作员看不到"为什么一个都没有"');
});
