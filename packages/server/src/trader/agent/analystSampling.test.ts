/**
 * **分析师的取样不能按顺序截取**（2026-10-13 线上实测的真 BUG）。
 *
 * ## 症状
 *
 * `#11`（团队模式）**87 轮零开仓**，而 `#10`（单模型托管）是 209/571 = 36.6%。
 *
 * ## 根因（两个各自正确的决定合起来错了）
 *
 * ```
 *   ① strategy/coins.ts:130
 *      "⚠️ 模型点名/共识的标的先加 —— sourcesBySymbol 的顺序就是优先级…
 *       放在 switch 之前意味着它们排在系统选出的候选【前面】。"
 *      → 这是对的（模型自己要看的东西优先）
 *
 *   ② tradingDesk.ts 的 analystContext
 *      实测"12 个候选（36,583 字符）→ content = 0 字"，所以只取前 6 个
 *      → 这也是对的（宁可少看 6 个，也不要"一个字都写不出"）
 *
 *   合起来：ai_requested 占满前 6 个 → 分析师【永远只看 ai_requested】
 * ```
 *
 * 线上材料实测（`#11` c87）：
 * ```
 *   ###  1–6   ai_requested   GTC / OGN / W / CT / SKL / DOS   ← 分析师只看得到这些
 *   ###  7–14  coinpool       BTC / ETH / SOL / ZEC / NEAR / XRP / HYPE / DOGE
 * ```
 * 而 `#10` 那笔赚钱的开仓正是 **ETHUSDT（coinpool）**。
 *
 * **这是组合性缺陷**：两个决定单独看都对，谁都没想到合起来出问题。
 * 所以修法也必须"两个都保留"——见 `pickForAnalysis` 的三条判据。
 *
 * ## ⚠️ 本文件用**真实材料形状**（走 splitMarketContext）
 *
 * 第一版我用 `### GTCUSDT（…）`（没写序号）造数据，而真实材料是
 * `### 1. GTCUSDT（…）` —— 于是来源解析失败、分层退化成"按顺序取"，
 * **BUG 原地复活而且只在特定格式下复活**。
 * 现在改成**用真实的 `### N. SYMBOL（来源）` 形状**，并直接测
 * `splitMarketContext` 的产出（来源就该在那一层算出来）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickForAnalysis } from './analystSampling.js';
import { splitMarketContext } from './symbolSlices.js';

/* -------------------------------------------------------------------------- */
/*  线上真实材料（取自 #11 c87 的形状）                                           */
/* -------------------------------------------------------------------------- */

const body = 'current_price = 1.23\ncurrent_ema20 = 1.20\n（后面还有 12k 字符的 K 线）';

/** 造一份与线上同形的完整 marketContext（必须带序号 —— 见文件头最后一段）。 */
function marketContext(specs: [string, string][]): string {
  const heads = specs.map(([sym, src], i) => `### ${i + 1}. ${sym}（${src}）\n${body}`);
  return `# 全市场概览\n525 个标的…\n\n${heads.join('\n\n')}`;
}

const REAL = marketContext([
  ['GTCUSDT', 'ai_requested'],
  ['OGNUSDT', 'ai_requested'],
  ['WUSDT', 'ai_requested'],
  ['CTUSDT', 'ai_requested'],
  ['SKLUSDT', 'ai_requested'],
  ['DOSUSDT', 'ai_requested'],
  ['BTCUSDT', 'coinpool + reference — 多来源共振'],
  ['ETHUSDT', 'coinpool'],
  ['SOLUSDT', 'coinpool'],
  ['ZECUSDT', 'coinpool'],
  ['NEARUSDT', 'coinpool'],
  ['XRPUSDT', 'coinpool'],
  ['HYPEUSDT', 'coinpool'],
  ['DOGEUSDT', 'coinpool'],
]);

const slicesOf = (ctx: string): { symbol: string | null; text: string; sources: string[] }[] =>
  splitMarketContext(ctx)!.slices;

/* -------------------------------------------------------------------------- */
/*  来源解析（在 splitMarketContext 那一层）                                      */
/* -------------------------------------------------------------------------- */

test('★★★ `splitMarketContext` 必须把【来源】一起解析出来', () => {
  const slices = slicesOf(REAL);
  assert.equal(slices.length, 14);
  assert.deepEqual(slices[0]!.sources, ['ai_requested'], '★ 单来源');
  assert.deepEqual(slices[6]!.sources, ['coinpool', 'reference'], '★ `+` 分隔的多来源');
});

test('★★★ 来源解析不出时是【空数组】（不是 ["unknown"]）', () => {
  /*
   * ⚠️ 让消费者能区分"没有来源信息"与"来源就是 unknown" ——
   * 前者说明材料格式变了（要看），后者是正常情况。
   */
  const ctx = marketContext([
    ['AAAUSDT', 'ai_requested'],
    ['BBBUSDT', 'coinpool'],
  ]).replace('### 2. BBBUSDT（coinpool）', '### 2. BBBUSDT');
  assert.deepEqual(slicesOf(ctx)[1]!.sources, []);
});

/* -------------------------------------------------------------------------- */
/*  分层取样                                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ 先钉住"旧行为确实有这个问题"（否则后面的修复没有说服力）', () => {
  /*
   * 14 个候选取前 6 个 = 全是 ai_requested，且**完全看不到 ETHUSDT**
   *（而它是 #10 那笔赚钱的开仓标的）。
   */
  const old = slicesOf(REAL).slice(0, 6).map((s) => s.symbol);
  assert.deepEqual(old, ['GTCUSDT', 'OGNUSDT', 'WUSDT', 'CTUSDT', 'SKLUSDT', 'DOSUSDT']);
  assert.ok(!old.includes('ETHUSDT'), '★ 前提校验：旧行为看不到 ETHUSDT');
});

test('★★★ 分层取样后，coinpool 必须【有代表】（主流币不能再被系统性漏掉）', () => {
  const { picked } = pickForAnalysis(slicesOf(REAL), 6);
  assert.equal(picked.length, 6, '★ 总数不能超过 limit');
  const srcs = picked.map((s) => s.sources[0]);
  assert.ok(
    srcs.includes('coinpool'),
    `★ coinpool 必须至少有 1 个代表（实际取到：${picked.map((s) => s.symbol).join(', ')}）`,
  );
  assert.ok(
    srcs.includes('ai_requested'),
    '★ ai_requested 也必须至少有 1 个代表（"模型点名优先"这个语义不能丢）',
  );
});

test('★★★ 必须【保序】（模型读起来仍然是"从强到弱"）', () => {
  const slices = slicesOf(REAL);
  const { picked } = pickForAnalysis(slices, 6);
  const idx = picked.map((p) => slices.findIndex((x) => x.symbol === p.symbol));
  for (let i = 1; i < idx.length; i += 1) {
    assert.ok(
      (idx[i] ?? 0) > (idx[i - 1] ?? 0),
      `★ 取样结果必须保持原顺序（实际下标序 ${idx.join(',')}）`,
    );
  }
});

test('★★★ 只有【一种来源】时行为必须与 slice(0, n) 完全一致（能安全上线的关键）', () => {
  /*
   * ⚠️ 这条断言防的是"修了 A 破了 B"：
   * 绝大多数机器人只配了一种来源（`static` 或 `coinpool`），
   * 对它们来说这个改动**必须无感** —— 否则就是拿一个大改动去换一个局部修复。
   */
  const single = marketContext([
    ['AAAUSDT', 'coinpool'],
    ['BBBUSDT', 'coinpool'],
    ['CCCUSDT', 'coinpool'],
    ['DDDUSDT', 'coinpool'],
    ['EEEUSDT', 'coinpool'],
  ]);
  const { picked } = pickForAnalysis(slicesOf(single), 3);
  assert.deepEqual(
    picked.map((s) => s.symbol),
    ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'],
    '★ 单一来源时必须等价于 slice(0, 3)',
  );
});

test('★★★ 候选数 ≤ limit 时全部保留（不能凭空丢东西）', () => {
  const small = marketContext([
    ['AAAUSDT', 'ai_requested'],
    ['BBBUSDT', 'coinpool'],
    ['CCCUSDT', 'coinpool'],
    ['DDDUSDT', 'coinpool'],
  ]);
  const { picked, droppedBySource } = pickForAnalysis(slicesOf(small), 6);
  assert.equal(picked.length, 4, '★ 不足 limit 时不该丢任何候选');
  assert.deepEqual(droppedBySource, {}, '★ 没有丢弃时不该有 droppedBySource');
});

test('★★★ 必须【均衡取样】：两类样本量相当，而不是"5 个热点 + 1 个主流"', () => {
  const { picked, droppedBySource } = pickForAnalysis(slicesOf(REAL), 6);
  const srcs = picked.map((s) => s.sources[0]);
  const nAi = srcs.filter((s) => s === 'ai_requested').length;
  const nCoin = srcs.filter((s) => s === 'coinpool').length;
  /*
   * ⚠️ 实测形状（轮流分配）：`GTC, OGN, W, BTC, ETH, SOL` = 3 + 3。
   *
   * ## 为什么这条断言比"coinpool 至少有 1 个"更强
   *
   * 第一版分配策略是"保底 1 个后按顺序补"，它给出 `5 个 ai + 1 个 coin`
   * —— **也满足"coinpool 至少有 1 个"**，但分析师仍然把 5 个名额花在
   * `ai_requested`（极端波动标的）上。
   * 那只是"修掉了最坏情况"，不是"修对了"：分析师要给裁决官**方向感**，
   * 而方向感应该来自两类的均衡样本。
   *
   * ⚠️ 这里断言"**两边都不少于 2**"而不是"恰好 3+3" ——
   * 后者会把 `limit` 或来源个数的任何变化都变成测试失败，
   * 而"两边都有像样的样本量"才是真正要守的性质。
   */
  assert.ok(nAi >= 2, `★ ai_requested 样本量太少（${nAi}）—— 单看主流会漏掉热点`);
  assert.ok(nCoin >= 2, `★ coinpool 样本量太少（${nCoin}）—— 单看热点会漏掉主流`);
  assert.equal(picked.length, 6, '★ 总数必须等于 limit');
  /* 丢弃统计要能说清（供材料里如实说明）。 */
  assert.equal(droppedBySource['ai_requested'], 3, '★ 6 个 ai 里丢 3 个');
  assert.equal(droppedBySource['coinpool'], 5, '★ 8 个 coin 里丢 5 个');
});

test('★★★ 取样必须包含 ETH 这类主流币（它是 #10 那笔赚钱的开仓标的）', () => {
  /*
   * ⚠️ 这是最贴近"这次修复到底有没有用"的判据：
   * `#10`（单模型托管）赚的那笔正是 **ETHUSDT**，而它是 `coinpool` 来源、
   * 排在 `ai_requested` 后面 —— 在旧行为下**永远进不了分析师的材料**。
   */
  const { picked } = pickForAnalysis(slicesOf(REAL), 6);
  assert.ok(
    picked.some((s) => s.symbol === 'ETHUSDT'),
    `★ 取样必须包含 ETHUSDT（实际：${picked.map((s) => s.symbol).join(', ')}）`,
  );
});

test('★ 来源未知的段落不能被丢掉（它们仍要参与取样）', () => {
  /*
   * ⚠️ 解析失败的段落在真实材料里是可能的（格式变了、或第三方候选源）。
   * 它们**不该被静默丢弃** —— 那正是本项目反复强调的"看不出异常的失败"。
   */
  const mixed = marketContext([
    ['AAAUSDT', 'ai_requested'],
    ['BBBUSDT', 'coinpool'],
    ['CCCUSDT', 'coinpool'],
    ['DDDUSDT', 'coinpool'],
  ]).replace('### 2. BBBUSDT（coinpool）', '### 2. BBBUSDT');
  const { picked } = pickForAnalysis(slicesOf(mixed), 4);
  assert.equal(picked.length, 4, '★ 全部都要保留');
  assert.ok(
    picked.some((s) => s.symbol === 'BBBUSDT'),
    '★ 来源解析失败的候选不能被静默丢掉',
  );
});

test('★ 边界：limit = 0 / 空数组 / limit 大于总数 都不能抛', () => {
  assert.deepEqual(pickForAnalysis([], 6).picked, []);
  assert.deepEqual(pickForAnalysis(slicesOf(REAL), 0).picked, []);
  assert.equal(pickForAnalysis(slicesOf(REAL), 99).picked.length, 14);
});
