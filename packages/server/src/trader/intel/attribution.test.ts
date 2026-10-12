import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signalKeyOf, tradesForSignal, signalsWithEnoughSamples, type Attribution } from './attribution.js';
import { assessSignal, SIGNAL_LIMITS } from './signalHealth.js';

const at = (over: Partial<Attribution> = {}): Attribution => ({
  signalKey: 'coindesk.com|bullish|BTCUSDT',
  returnPct: 0.01,
  signalStrength: 0.8,
  closedAt: 1_000,
  ...over,
});

test('★★★ 归因主键：标的【排序】后拼接（否则样本被劈成两半）', () => {
  /*
   * ⚠️ 若 `BTC,ETH` 与 `ETH,BTC` 被当成两个信号，
   * 样本会被劈成两半 → **都达不到 MIN_SAMPLES** → 失效检测永远不生效。
   */
  const a = signalKeyOf({ sourceHost: 'CoinDesk.com', direction: 'bullish', symbols: ['BTCUSDT', 'ETHUSDT'] });
  const b = signalKeyOf({ sourceHost: 'coindesk.com', direction: 'bullish', symbols: ['ETHUSDT', 'BTCUSDT'] });
  assert.equal(a, b, '★ 顺序不同、域名大小写不同，都应当是同一个信号');
  assert.equal(a, 'coindesk.com|bullish|BTCUSDT,ETHUSDT', `实际 ${a}`);
});

test('★★★ 取出某个信号的成交：按时间排序（失效检测依赖时间顺序）', () => {
  /*
   * `assessSignal` 的"连续亏损"是**从最后一笔往前数** ——
   * 若顺序错了，"连续"就毫无意义。
   */
  const all = [
    at({ closedAt: 300, returnPct: 0.03 }),
    at({ closedAt: 100, returnPct: 0.01 }),
    at({ closedAt: 200, returnPct: -0.02 }),
  ];
  const t = tradesForSignal(all, 'coindesk.com|bullish|BTCUSDT');
  assert.deepEqual(t.map((x) => x.returnPct), [0.01, -0.02, 0.03], '★ 必须按 closedAt 升序');
});

test('★ 只取该信号的成交（不混入别的信号）', () => {
  const all = [at(), at({ signalKey: 'other.com|bearish|ETHUSDT' })];
  assert.equal(tradesForSignal(all, 'coindesk.com|bullish|BTCUSDT').length, 1);
});

test('★★★ 只返回够样本量的信号（避免为只出现 1 次的信号跑评估）', () => {
  const all = [
    ...Array.from({ length: 25 }, () => at()),
    ...Array.from({ length: 3 }, () => at({ signalKey: 'rare.com|bullish|X' })),
  ];
  const enough = signalsWithEnoughSamples(all, SIGNAL_LIMITS.MIN_SAMPLES);
  assert.deepEqual(enough, ['coindesk.com|bullish|BTCUSDT'], `实际 ${enough.join(',')}`);
});

test('★★★ 与 signalHealth 串起来：归因 → 评估（接线验证）', () => {
  /*
   * 这条是**接线验证**：若 `Attribution` 的字段名与 `SignalTrade` 不匹配，
   * 这里会立刻失败 —— 否则现象是"归因记了、评估永远 insufficient_data"，**静默**。
   */
  const all = [
    ...Array.from({ length: 20 }, () => at({ returnPct: 0.02 })),
    ...Array.from({ length: 20 }, () => at({ returnPct: -0.01 })),
  ];
  const trades = tradesForSignal(all, 'coindesk.com|bullish|BTCUSDT');
  const v = assessSignal(trades);
  assert.notEqual(v.health, 'insufficient_data', '★ 40 笔样本不该是"样本不足"');
  assert.equal(v.samples, 40);
});

test('★★★ 反应衰减需要 signalStrength —— 归因必须带上它', () => {
  /*
   * `detectReactionDecay` 比较"单位信号强度带来的平均收益"。
   * 若归因不记 `signalStrength`，那个函数会因"强度全为 0"而**永远返回不适用**。
   */
  const early = Array.from({ length: 20 }, (_, i) =>
    at({ returnPct: 0.04, signalStrength: 0.8, closedAt: i }));
  const late = Array.from({ length: 20 }, (_, i) =>
    at({ returnPct: 0.005, signalStrength: 0.8, closedAt: 100 + i }));
  const trades = tradesForSignal([...early, ...late], 'coindesk.com|bullish|BTCUSDT');
  assert.ok(trades.every((t) => t.signalStrength > 0), '★ 强度必须带过来，否则衰减检测不适用');
});

test('★ 空输入 → 空结果（不崩）', () => {
  assert.deepEqual(tradesForSignal([], 'x'), []);
  assert.deepEqual(signalsWithEnoughSamples([], 20), []);
});
