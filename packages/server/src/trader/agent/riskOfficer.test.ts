/**
 * 风控官关卡的测试。
 *
 * ## 为什么这里必须测得细
 *
 * 风控是**安全攸关**的一层。用户要求「系统不再设置内置风控……风格由智能体负责」，
 * 而本模块是那个智能体层的**解析与决策逻辑**。
 *
 * 它的失败模式很具体：
 *   · 解析失败时**当成"批准了"** → 等于没有风控（爆仓风险）；
 *   · 解析失败时**全部否决** → 一次格式抖动让机器人停摆；
 *   · 削减时**改方向** → 越权推翻裁决官；
 *   · 削减时**削了平仓** → 让风控官帮倒忙（该减的仓减得更少）。
 *
 * 这四条都在下面被钉住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

/** 造一条决策（只填本模块用到的字段）。 */
function d(action: string, extra: Partial<Decision> = {}): Decision {
  return { symbol: 'BTCUSDT', action, ...extra } as Decision;
}

/* -------------------------------------------------------------------------- */
/*  明确的表态                                                                */
/* -------------------------------------------------------------------------- */

test('★ 风控官说"批准" → 放行，且不改动决策', () => {
  const decisions = [d('open_long', { positionSizeUsd: 100 })];
  const v = parseRiskOfficerVerdict('批准。仓位与当前敞口匹配。', decisions);
  assert.equal(v.approved, true);
  assert.equal(v.reduced, false);
  assert.equal(v.adjusted, null, '★ 批准时不该改动任何东西');
  assert.ok(v.reason.length > 0);
});

test('★ 风控官说"否决" → 拦下', () => {
  const v = parseRiskOfficerVerdict('否决。当前回撤已达上限，不应再增加敞口。', [d('open_long')]);
  assert.equal(v.approved, false, '★ 否决必须真的拦住');
  assert.equal(v.adjusted, null);
});

test('★★ 说"削减" → 开仓金额减半，且【不改方向】', () => {
  const decisions = [d('open_long', { positionSizeUsd: 200, riskUsd: 10 })];
  const v = parseRiskOfficerVerdict('同意方向，但建议削减仓位到一半。', decisions);

  assert.equal(v.approved, true);
  assert.equal(v.reduced, true);
  assert.ok(v.adjusted, '削减时必须给出调整后的决策');
  assert.equal(v.adjusted![0]!.action, 'open_long', '★ 方向不能被改（那是越权）');
  assert.equal(v.adjusted![0]!.positionSizeUsd, 100, '★ 金额减半');
  assert.equal(v.adjusted![0]!.riskUsd, 5);
  assert.ok(
    String(v.adjusted![0]!.reasoning).includes('风控官削减'),
    '★ 理由里必须留痕 —— 否则事后看会以为"AI 当时就想开这么小的仓"',
  );
});

test('★★ 削减【不能】削平仓/减仓 —— 那是帮倒忙', () => {
  /*
   * "仓位太大"指的是**增加风险**的动作。
   * 平仓、减仓、调保护位是**降低风险**的，削它们等于让该减的仓减得更少。
   */
  const decisions = [
    d('open_long', { positionSizeUsd: 200 }),
    d('close_long'),
    d('reduce_position', { reducePercent: 50 }),
    d('adjust_protection'),
  ];
  const v = parseRiskOfficerVerdict('建议削减。', decisions);
  assert.ok(v.adjusted);

  const close = v.adjusted!.find((x) => x.action === 'close_long');
  assert.ok(close, '平仓决策必须仍在');
  assert.equal(close!.positionSizeUsd, undefined, '★ 平仓不该被改（它本来就没有金额）');

  const reduce = v.adjusted!.find((x) => x.action === 'reduce_position');
  assert.equal(reduce!.reducePercent, 50, '★ 减仓比例不该被削');

  const open = v.adjusted!.find((x) => x.action === 'open_long');
  assert.equal(open!.positionSizeUsd, 100, '开仓才是该削的那个');
});

/* -------------------------------------------------------------------------- */
/*  格式不合时的保守策略（安全攸关）                                            */
/* -------------------------------------------------------------------------- */

test('★★ 表态不明 → 只放行"降低风险"的动作（保守但不停摆）', () => {
  /*
   * 这是本模块**最重要的安全决策**：
   *
   *   · 当成"批准了" → 等于没有风控；
   *   · 全部否决   → 一次格式抖动让机器人停摆（连平仓都做不了）。
   *
   * 取中间：**看不清楚的时候，宁可少冒险** —— 平仓照常，开仓拦住。
   */
  const decisions = [d('open_long'), d('close_long')];
  const v = parseRiskOfficerVerdict('嗯，我再想想。', decisions);

  assert.equal(v.approved, true, '仍要放行（否则连平仓都做不了）');
  assert.ok(v.adjusted);
  assert.equal(v.adjusted!.length, 1, '★ 只放行降低风险的那一条');
  assert.equal(v.adjusted![0]!.action, 'close_long', '★ 平仓必须能通过');
  assert.ok(v.reason.includes('保守策略'), '★ 理由要说清这是保守处理，而不是风控官真的批准了');
});

test('★★ 表态不明且【全是增加风险】的动作 → 全部拦下', () => {
  const decisions = [d('open_long'), d('add_to_position')];
  const v = parseRiskOfficerVerdict('让我看看……', decisions);
  assert.equal(v.approved, false, '★ 全是开仓/加仓时必须拦住');
  assert.equal(v.adjusted!.length, 0);
});

test('★ 表态不明但【全是降低风险】的动作 → 全部放行，且不算削减', () => {
  const decisions = [d('close_long'), d('reduce_position')];
  const v = parseRiskOfficerVerdict('……', decisions);
  assert.equal(v.approved, true);
  assert.equal(v.reduced, false, '没有需要削的东西时不该标成削减');
  assert.equal(v.adjusted, null);
});

test('★ 空输出 → 保守处理（不当成批准）', () => {
  const v = parseRiskOfficerVerdict('', [d('open_long')]);
  assert.equal(v.approved, false, '★ 空输出绝不能当成批准');
  assert.ok(v.reason.includes('保守策略'));
});

/* -------------------------------------------------------------------------- */
/*  理由与担心点                                                              */
/* -------------------------------------------------------------------------- */

test('★ 理由被提取出来（用户要求看得见"为什么"）', () => {
  const v = parseRiskOfficerVerdict(
    '当前回撤 8%，接近上限，建议削减。\n风险：连续 3 笔亏损后情绪指标仍偏乐观。',
    [d('open_long')],
  );
  assert.ok(v.reason.includes('回撤'), '★ 理由要能读');
  assert.ok(v.concern !== null && v.concern.includes('风险'), '★ 担心点要能读');
});

test('理由里的 JSON 行不会被当成理由（模型可能先输出 JSON）', () => {
  const v = parseRiskOfficerVerdict('{"approved":true}\n仓位合适，放行。', [d('open_long')]);
  assert.ok(!v.reason.startsWith('{'), '★ 不该把 JSON 当成理由');
  assert.ok(v.reason.includes('放行'));
});

test('★ 中文"不同意"要被识别成否决（不能只匹配"否决"）', () => {
  const v = parseRiskOfficerVerdict('我不同意这个仓位。', [d('open_long')]);
  assert.equal(v.approved, false);
});
