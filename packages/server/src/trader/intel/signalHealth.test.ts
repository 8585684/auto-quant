import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessSignal, detectReactionDecay, SIGNAL_LIMITS, type SignalTrade } from './signalHealth.js';

const t = (returnPct: number, signalStrength = 0.8): SignalTrade => ({ returnPct, signalStrength });
/** 造 n 笔：按给定模式。 */
const pattern = (n: number, win: number, lose: number): SignalTrade[] =>
  Array.from({ length: n }, (_, i) => t(i % 2 === 0 ? win : lose));

test('★★★ 样本不足 → 不下结论（防"把方差当失效"）', () => {
  /*
   * 一个策略**正常**也会有连亏 —— 那是方差，不是失效。
   * 所以样本不足时必须说"不知道"，而不是"失效了"。
   */
  const v = assessSignal(pattern(5, 0.02, -0.02));
  assert.equal(v.health, 'insufficient_data');
  assert.equal(v.action, 'keep', '★ 样本不足不该采取任何动作');
  assert.ok(v.reason.includes('样本不足'));
});

test('★★★ 胜率崩塌 → 失效（"逻辑变了"的最直接证据）', () => {
  /* 前 30 笔胜率 70%，最近 30 笔胜率 20% → 明显崩塌。 */
  const trades = [...pattern(30, 0.02, -0.02), ...Array.from({ length: 30 }, (_, i) => t(i % 5 === 0 ? 0.02 : -0.02))];
  const v = assessSignal(trades);
  assert.equal(v.health, 'failed', `实际 ${v.health}（${v.reason}）`);
  assert.equal(v.action, 'disable_and_review');
  assert.ok(v.reason.includes('胜率'), '理由要指向胜率');
});

test('★★★ 连续亏损到降权线 → 衰减中（先降权，不是直接停）', () => {
  /*
   * "先保命，但别一次正常回撤就杀死一个策略"。
   * 降权线（6 笔）与停用线（10 笔）分开，就是为了留出观察窗口。
   */
  /*
   * ⚠️ **基线必须以【盈利】结尾**，否则它会与后面的连亏合并计数。
   *
   * 我第一版用 `pattern(30, …)` —— 它的最后一笔（索引 29）是**亏损**，
   * 于是"基线尾部 1 笔亏 + 6 笔连亏 = 7 笔"，断言 6 就失败了。
   * 测试当场抓到了这个不一致。
   */
  const baseline = [...pattern(29, 0.02, -0.02), t(0.02)];
  const trades = [...baseline, ...Array.from({ length: SIGNAL_LIMITS.STREAK_REDUCE }, () => t(-0.01))];
  const v = assessSignal(trades);
  assert.equal(v.health, 'decaying', `实际 ${v.health}（${v.reason}）`);
  assert.equal(v.action, 'reduce_weight', '★ 先降权，不是停用');
  assert.equal(v.losingStreak, SIGNAL_LIMITS.STREAK_REDUCE, '连亏数应当恰好等于追加的笔数');
});

test('★★★ 连续亏损到停用线 → 失效', () => {
  const trades = [...pattern(30, 0.02, -0.02), ...Array.from({ length: SIGNAL_LIMITS.STREAK_DISABLE }, () => t(-0.01))];
  const v = assessSignal(trades);
  assert.equal(v.health, 'failed');
  assert.equal(v.action, 'disable_and_review');
});

test('★ 稳定有效的信号 → effective（不能被误杀）', () => {
  const v = assessSignal(pattern(80, 0.02, -0.01));
  assert.equal(v.health, 'effective', `实际 ${v.health}（${v.reason}）`);
  assert.equal(v.action, 'keep');
});

test('★★★ 反应衰减：同样强度的消息，价格反应变小 → 预警（能在亏钱【之前】发出）', () => {
  /*
   * 消息面策略失效的**典型机制**不是"模型变笨"，而是**市场把这类消息消化了**：
   * ```
   *   第一阶段：出消息 → 价格反应 5%  → 赚钱
   *   第二阶段：出消息 → 价格反应 2%  → 赚得少
   *   第三阶段：出消息 → 价格几乎不动 → 开始亏
   * ```
   * ⚠️ **胜率在第二阶段可能还很好看**（赚得少但仍是赚）—— 只看胜率会漏掉它。
   */
  const trades = [
    ...Array.from({ length: 20 }, () => t(0.04, 0.8)), /* 前半：单位强度收益高 */
    ...Array.from({ length: 20 }, () => t(0.005, 0.8)), /* 后半：同样强度，反应小得多 */
  ];
  const d = detectReactionDecay(trades);
  assert.ok(d !== null);
  assert.equal(d.ok, true);
  assert.ok(d.decayRatio < 0.5, `★ 应识别出显著衰减（实际 ${d.decayRatio}）`);
  assert.ok(d.note.includes('衰减'), '结论要明说衰减');
});

test('★ 反应正常 → 不误报', () => {
  const trades = Array.from({ length: 40 }, () => t(0.02, 0.8));
  const d = detectReactionDecay(trades);
  assert.ok(d !== null && d.ok);
  assert.ok(d.decayRatio > 0.9, `稳定时不该报衰减（实际 ${d.decayRatio}）`);
});

test('★ 前半单位强度收益非正 → 明确说"不适用"，不给无意义的比值', () => {
  /*
   * "从 0 衰减到 0"不是衰减；"从 -1 到 -0.5"更不是"改善 50%"。
   * 除法的结果在这里没有意义 —— 必须显式拒绝，而不是给一个看起来像结论的数。
   */
  const trades = [
    ...Array.from({ length: 20 }, () => t(-0.01, 0.8)),
    ...Array.from({ length: 20 }, () => t(0.01, 0.8)),
  ];
  const d = detectReactionDecay(trades);
  assert.ok(d !== null);
  assert.equal(d.ok, false, '★ 前半非正时必须标为不适用');
  assert.ok(d.note.includes('无法判断'), '要说明为什么不适用');
});

test('★ 样本不足 → null（"还没有结论"）', () => {
  assert.equal(detectReactionDecay(pattern(5, 0.02, -0.01)), null);
});

test('★ 信号强度全为 0 → 不除零（返回不适用）', () => {
  const trades = Array.from({ length: 30 }, () => t(0.01, 0));
  const d = detectReactionDecay(trades);
  assert.ok(d !== null);
  assert.equal(d.ok, false, '★ 单位强度收益在强度为 0 时无定义');
});

test('★ 门槛自洽（降权线 < 停用线；窗口 < 最小样本的合理范围）', () => {
  assert.ok(SIGNAL_LIMITS.STREAK_REDUCE < SIGNAL_LIMITS.STREAK_DISABLE);
  assert.ok(SIGNAL_LIMITS.MIN_SAMPLES > SIGNAL_LIMITS.WINDOW / 2, '最小样本要与窗口相称');
});
