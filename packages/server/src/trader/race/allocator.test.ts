import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateLine,
  nextCredit,
  windowStats,
  RACE_LIMITS,
  MAX_CREDIT_SHARE,
  type StrategyLine,
} from './allocator.js';

const line = (returns: number[], creditUsd = 1_000): StrategyLine => ({
  id: 'L1', name: '测试线', creditUsd, retired: false,
  trades: returns.map((r) => ({ returnPct: r })),
});

/** 造一批"有正期望、有波动"的收益。 */
const good = (n: number) => Array.from({ length: n }, (_, i) => (i % 5 === 0 ? -0.004 : 0.012));
const bad = (n: number) => Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 0.004 : -0.012));

test('★★★ 样本不足时【不加也不减】—— 这是防"把噪声当能力"的第一道闸', () => {
  /*
   * 这是整个模块**最重要**的一条。
   *
   * 若一个策略真实期望收益 = 0（纯噪声），跑 20 笔后"盈利"的概率约 50%。
   * 5 个这样的策略里最好的那个看起来会很漂亮 —— 但它全是运气。
   *
   * 所以**样本量门槛优先于一切**：不到 30 笔，无论多赚都不加额度。
   */
  const lucky = line(Array.from({ length: 10 }, () => 0.05)); // 10 笔全赚 5%
  const e = evaluateLine(lucky);
  assert.equal(e.verdict, 'hold', '★ 10 笔全赚也不该升级');
  assert.ok(e.reason.includes('样本不足'), `理由要说清是样本问题（实际：${e.reason}）`);
  assert.equal(nextCredit(1_000, e.verdict, 20_000), 1_000, '额度不变');
});

test('★★★ 回撤优先于收益：回撤过大时【即使很赚】也降档', () => {
  /*
   * "先保命，再谈加额度"。
   * 一条线可以累计收益很高，但中途回撤 30% —— 那说明它的尾部风险是真的。
   */
  /* 8 笔 -4.5% → 回撤约 31%（落在 demote 区间 25%~40%，而不是 retire 的 ≥40%）。 */
  const wild = line([...Array.from({ length: 35 }, () => 0.03), ...Array.from({ length: 8 }, () => -0.045)]);
  const e = evaluateLine(wild);
  assert.equal(e.verdict, 'demote', `回撤 ${(e.maxDrawdown * 100).toFixed(0)}% 时该降档（实际 ${e.verdict}）`);
  assert.ok(e.reason.includes('回撤'), '理由要指向回撤');
});

test('★★★ 授信必须封顶 —— 否则一条"看起来很好"的线会吃光全部资金', () => {
  /*
   * 这是"把噪声当能力"最贵的代价：连赢几次 → 额度指数增长 → 一次崩掉伤到本金。
   */
  const total = 20_000;
  const cap = total * MAX_CREDIT_SHARE;
  let credit = 1_000;
  for (let i = 0; i < 20; i += 1) credit = nextCredit(credit, 'promote', total);
  assert.ok(credit <= cap, `★ 连升 20 次也不得超过封顶 ${cap}（实际 ${credit}）`);
});

test('★ 降档不清零 —— 一次正常回撤不该杀死一个好策略', () => {
  const after = nextCredit(1_000, 'demote', 20_000);
  assert.ok(after > 0, '★ 降档后额度仍为正');
  assert.equal(after, 1_000 * RACE_LIMITS.DEMOTE_MULTIPLIER);
  assert.equal(nextCredit(1_000, 'retire', 20_000), 0, '停用才归零');
});

test('★ 只看滚动窗口（最近 N 笔）—— 旧业绩不该永久背书', () => {
  /* 前 100 笔很好、最近 40 笔很烂 → 应当按"最近"判，而不是被历史平均掉。 */
  const faded = line([...Array.from({ length: 100 }, () => 0.02), ...Array.from({ length: 40 }, () => -0.01)]);
  const e = evaluateLine(faded);
  assert.equal(e.samples, RACE_LIMITS.WINDOW, '样本数应当是窗口大小');
  assert.equal(e.verdict, 'demote', '★ 最近在亏就该降档，不能被前面的好业绩平均成 hold');
});

test('★ 正期望、波动合理的线 → 升级', () => {
  const e = evaluateLine(line(good(60)));
  assert.equal(e.verdict, 'promote', `理由：${e.reason}`);
  assert.ok(e.sharpe !== null && e.sharpe > 0);
});

test('★ 负期望的线 → 降档', () => {
  /* 30 笔 → 回撤约 23%（低于 demote 的 25% 回撤线），于是判据只能落在 Sharpe 上。 */
  const e = evaluateLine(line(bad(30)));
  assert.equal(e.verdict, 'demote');
});

test('★ 波动为 0 时 Sharpe 是 null（不是 Infinity）—— 防"从没亏过"的假象', () => {
  /*
   * `mean/0 = Infinity` 会让"从没亏过"看起来完美，而它可能只是**样本太少**。
   * 返回 null 让调用方必须显式处理"还没有结论"。
   */
  const flat = windowStats([0.01, 0.01, 0.01]);
  assert.equal(flat.sharpe, null, '★ 波动为 0 时不能给 Infinity');
  assert.equal(evaluateLine(line(Array.from({ length: 40 }, () => 0.01))).verdict, 'hold', '保守按 hold');
});

test('★ 已停用的线永远是 retire（要人工复盘才能回来）', () => {
  const r: StrategyLine = { ...line(good(60)), retired: true };
  assert.equal(evaluateLine(r).verdict, 'retire');
});

test('★ 样本标准差用 n-1（用总体标准差会低估波动、高估 Sharpe）', () => {
  const s = windowStats([0.02, -0.02]);
  /* 样本标准差 = sqrt(((0.02)^2 + (-0.02)^2) / 1) = 0.02828… */
  assert.ok(Math.abs(s.std - 0.028284) < 1e-5, `样本标准差应约 0.02828（实际 ${s.std}）`);
});
