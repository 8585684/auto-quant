import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflatedSharpe, normalCdf, normalInv } from './deflatedSharpe.js';

test('★ 正态 CDF / 分位数自洽（Φ(0)=0.5、Φ⁻¹(Φ(x))≈x）', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3, `Φ(1.96) 应约 0.975（实际 ${normalCdf(1.96)}）`);
  for (const x of [-2, -0.5, 0, 0.5, 2]) {
    assert.ok(Math.abs(normalInv(normalCdf(x)) - x) < 1e-4, `往返 ${x} 失败`);
  }
});

test('★★★ 同样一条曲线，试的次数越多 → DSR 越低（这就是"通缩"）', () => {
  /*
   * 这是整个模块存在的理由。
   * 调研原文：「K=50 次试验时，**纯靠运气也能跑出 0.4–0.8 的 Sharpe**」。
   */
  /*
   * ⚠️ 数据必须选在**边缘**：信号太强时两次都饱和到 DSR=1，看不出差别
   *（我第一版就踩了这个 —— 报 "1 vs 1"）。这里用 Sharpe ≈ 0.16 的弱信号。
   */
  const returns = Array.from({ length: 50 }, (_, i) => (i % 10 === 0 ? -0.02 : 0.0035));
  const one = deflatedSharpe({ returns, trials: 1 });
  const fifty = deflatedSharpe({ returns, trials: 50 });
  assert.ok(one !== null && fifty !== null);
  assert.ok(fifty.dsr < one.dsr, `★ 试 50 次必须比试 1 次更难过关（${fifty.dsr} vs ${one.dsr}）`);
  assert.ok(one.sharpeThreshold < fifty.sharpeThreshold, '门槛应随试验次数上升');
});

test('★★★ 只试一次时门槛为 0（没有多重比较就没有通缩）', () => {
  const returns = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? -0.01 : 0.013));
  const r = deflatedSharpe({ returns, trials: 1 });
  assert.ok(r !== null);
  assert.ok(Math.abs(r.sharpeThreshold) < 1e-12, `K=1 时门槛应为 0（实际 ${r.sharpeThreshold}）`);
});

test('★★★ 纯噪声（期望为 0）在试很多次后【不能】通过 —— 这正是要防的"运气当能力"', () => {
  /*
   * 造一条"看起来不错但其实是噪声"的曲线：均值为正、波动大。
   * 试 100 次变体后，它不该通过 0.95。
   */
  const noisy = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 0.05 : -0.02));
  const r = deflatedSharpe({ returns: noisy, trials: 100 });
  assert.ok(r !== null);
  assert.ok(r.dsr < 0.95, `★ 40 笔噪声试 100 次后不该过关（DSR ${r.dsr.toFixed(3)}）`);
  assert.ok(r.verdict.includes('未通过'), '结论要直说未通过');
});

test('★ 真实很强、样本很足的曲线 → 即使试很多次也通过', () => {
  /* 200 笔、正期望稳定、波动小 —— 这是"真本事"的形状。 */
  const strong = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? -0.002 : 0.012));
  const r = deflatedSharpe({ returns: strong, trials: 50 });
  assert.ok(r !== null);
  assert.ok(r.dsr >= 0.95, `★ 真强的策略不该被通缩误杀（DSR ${r.dsr.toFixed(3)}）`);
  assert.ok(r.verdict.includes('通过'));
});

test('★ 样本不足 / 波动为 0 → null（"还没有结论"，不是"通过"）', () => {
  assert.equal(deflatedSharpe({ returns: [0.01, 0.02], trials: 10 }), null, '样本 < 4');
  assert.equal(deflatedSharpe({ returns: [0.01, 0.01, 0.01, 0.01], trials: 10 }), null, '波动为 0');
});

test('★ trials < 1 视为非法输入 → null（不静默当 1）', () => {
  const r = Array.from({ length: 50 }, (_, i) => (i % 4 === 0 ? -0.01 : 0.012));
  assert.equal(deflatedSharpe({ returns: r, trials: 0 }), null);
});
