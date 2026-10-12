/**
 * 团队看板工作流区的测试。
 *
 * ## 为什么这些测试存在（每一条都对应一个会骗人的界面）
 *
 * 用户 2026-10-12 的反馈是「**用户无法看清楚 AI 运行状态**」。
 * 而"看不清状态"在实现上有三种典型成因，每一条都能让界面**安静地说假话**：
 *
 *   ① **并行步骤按时间排** → 4 个分析师的步骤互相交错，看不出谁在干什么；
 *   ② **"规划中"和"在岗未参与"混为一谈** → 操作员以为"社区监控有人在看"，
 *      而实际上**根本没有人在看**（`firm.ts` 里那一大段注释就是为这件事写的）；
 *   ③ **把"没有后续步骤"当成"已完成"** → 一个**卡住的**角色被显示成"做完了"。
 *
 * 这三条都是"编译全绿、屏幕上少一句话"的那种 bug，只有断言能拦住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRM_ROLES, firmRoleOf, type FirmRole } from '@aq/shared';
import { clock, rosterEntries, stateOfLastStep, type TeamStep } from './roster.js';

/** 造一条 `cycle_step`。 */
function step(role: string | null, message: string, phase?: string, level = 'info'): TeamStep {
  return {
    at: new Date(Date.UTC(2026, 9, 12, 4, 0, 0)).toISOString(),
    message,
    role,
    phase: phase ?? null,
    level,
  };
}

/* -------------------------------------------------------------------------- */
/*  ① 归并与顺序                                                               */
/* -------------------------------------------------------------------------- */

test('★★ 并行角色的步骤按【岗位】归并，而不是按时间切碎', () => {
  /*
   * 实测日志的真实形状（`tradingDesk.ts` 的 `note()` 并行触发）：
   *
   *   [analysis] technical：完成（4112ms）
   *   [analysis] sentiment：完成（5770ms）
   *   [analysis] newscaster：完成（12018ms）
   *   [analysis] market_analyst：完成（24740ms）
   *
   * 按时间显示会得到 4 行互不相干的消息；按岗位归并才能显示成"编制表"。
   */
  const steps = [
    step('technical', '开始分析', 'analysis'),
    step('sentiment', '开始分析', 'analysis'),
    step('technical', '完成（4112ms）', 'analysis'),
    step('sentiment', '完成（5770ms）', 'analysis'),
  ];
  const entries = rosterEntries(steps, FIRM_ROLES);
  const technical = entries.find((e) => e.role.id === 'technical');
  assert.equal(technical?.stepCount, 2, '★ 同一岗位的两步必须归到一起');
  assert.equal(technical?.state, 'done', '★ 看到"完成"应标记为已完成');
  assert.equal(technical?.latest?.message, '完成（4112ms）', '★ 摘要取【最后一步】，不是第一步');
});

test('★★ 输出顺序按【编制表】固定，某一轮少派了谁也不跳位', () => {
  /*
   * 位置会跳的界面，操作员每轮都要重新找"技术面在哪一行" ——
   * 而团队模式是 7×24 一直跑的，每一轮都重新找一遍是纯粹的浪费。
   */
  const a = rosterEntries([step('judge', '已裁决', 'verdict'), step('technical', '完成', 'analysis')], FIRM_ROLES);
  const b = rosterEntries([step('technical', '完成', 'analysis'), step('judge', '已裁决', 'verdict')], FIRM_ROLES);

  assert.deepEqual(
    a.map((x) => x.role.id),
    b.map((x) => x.role.id),
    '★ 输入顺序不同时输出顺序必须一致（都按编制表）',
  );
  assert.ok(
    a.findIndex((x) => x.role.id === 'supervisor') < a.findIndex((x) => x.role.id === 'technical'),
    '★ 管理在最上面（那是决策链的起点），技术面在后面',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② "规划中" ≠ "在岗未参与" —— 这是最重要的一条                              */
/* -------------------------------------------------------------------------- */

test('★★★ 规划中的岗位必须与「在岗但本轮未参与」分开，否则界面在骗人', () => {
  /*
   * 用户列的理想组织里有**还没实现**的角色。把它们显示成"在岗、这轮没轮到"
   * 会让操作员以为"社区有人在看着" —— 而实际上没有人在看。
   * 反过来，把在岗但没叫的显示成"规划中"会让他以为"这个功能还没做"。
   *
   * 两种误读都会让判断走偏，所以这里钉死。
   */
  const entries = rosterEntries([step('technical', '完成', 'analysis')], FIRM_ROLES);

  const planned = entries.find((e) => e.role.id === 'community_monitor');
  assert.equal(planned?.state, 'planned', '★ 社区监控是【规划中】—— firm.ts 里标的就是 planned');
  assert.equal(planned?.latest, null);

  const idle = entries.find((e) => e.role.id === 'bull');
  assert.equal(idle?.state, 'idle', '★ 多头研究员已实现，但这一轮没叫它 → 在岗未参与');

  assert.notEqual(planned?.state, idle?.state, '★★ 两者绝不能是同一个状态');
});

test('★ 编制表里**每个**已实现岗位在没参与时都是 idle，不是 planned', () => {
  const entries = rosterEntries([], FIRM_ROLES);
  for (const entry of entries) {
    const expected = entry.role.status === 'planned' ? 'planned' : 'idle';
    assert.equal(entry.state, expected, `${entry.role.id} 的状态应当是 ${expected}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  ③ 状态判定                                                                 */
/* -------------------------------------------------------------------------- */

test('★★ 失败优先于完成（失败过的角色不能被显示成"已完成"）', () => {
  /*
   * 一个角色可能先失败、随后被重试成功；也可能反过来。
   * 只要这一轮出现过失败，界面上就不能说它"已交出产出" ——
   * 那会让操作员以为结论是完整的。
   */
  assert.equal(
    stateOfLastStep([step('newscaster', '失败：新闻数据源不可用', 'analysis', 'error'), step('newscaster', '完成', 'analysis')]),
    'failed',
    '★ error 级别必须赢过"完成"措辞',
  );
  assert.equal(stateOfLastStep([step('newscaster', '失败：新闻数据源不可用', 'analysis')]), 'failed', '★ 措辞也算失败信号');
  assert.equal(stateOfLastStep([step('technical', '完成（4112ms）', 'analysis')]), 'done');
});

test('★★★ 只有"开始"没有"完成"时是【进行中】，不能显示成已完成', () => {
  /*
   * 这一条防的是最糟的一种误读：**一个卡住的角色被显示成"做完了"**。
   * 服务端只推"发生了"，不推"成没成"（见 `tradingDesk.ts` 的 `note()`）——
   * 所以"没有后续步骤"绝不能被解释成"已完成"。
   */
  assert.equal(stateOfLastStep([step('technical', '开始分析', 'analysis')]), 'active');
  assert.equal(stateOfLastStep([]), 'active');
});

test('★ 没有角色的步骤不进编制表（普通/智能托管模式的步骤不该混进来）', () => {
  const entries = rosterEntries([step(null, '按需取数 #1'), step('technical', '完成', 'analysis')], FIRM_ROLES);
  const technical = entries.find((e) => e.role.id === 'technical');
  assert.equal(technical?.stepCount, 1, '★ 只有带角色的步骤才算进某个岗位');
  assert.ok(
    entries.every((e) => e.latest === null || e.latest.message !== '按需取数 #1'),
    '★ 无角色步骤不能挂到任何岗位的摘要上',
  );
});

/* -------------------------------------------------------------------------- */
/*  ④ 不丢信息                                                                 */
/* -------------------------------------------------------------------------- */

test('★★ 编制表之外的新角色不会被丢掉（后端加岗位、前端还没登记时）', () => {
  /*
   * 丢掉它们会让"某个角色在干活但界面看不到" —— 比显示成"未登记分工"糟得多。
   */
  const entries = rosterEntries([step('quantum_analyst', '完成', 'analysis')], FIRM_ROLES);
  const extra = entries.find((e) => e.role.id === 'quantum_analyst');
  assert.ok(extra, '★ 未登记的岗位也要显示出来');
  assert.equal(extra?.state, 'done');
  assert.match(extra?.role.duty ?? '', /还没登记/, '★ 并且要诚实说明"界面还没登记它的分工"');
});

test('★ 用自定义编制表时结果只包含那张表里的岗位（可注入 = 可测）', () => {
  const tiny: FirmRole[] = [firmRoleOf('bull')!, firmRoleOf('bear')!];
  const entries = rosterEntries([step('bull', '第 1 轮：构建做多论证', 'debate')], tiny);
  assert.deepEqual(entries.map((e) => e.role.id), ['bull', 'bear']);
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 时刻                                                                     */
/* -------------------------------------------------------------------------- */

test('★ 时刻是 24 小时制 HH:MM:SS，取不到时是破折号（不是 1970 年）', () => {
  const iso = new Date(2026, 9, 12, 9, 5, 3).toISOString();
  assert.equal(clock(iso), '09:05:03');
  assert.equal(clock(null), '—', '★ 没有时刻就说"没有"，不要显示 08:00:00 那种假值');
  assert.equal(clock('不是时间'), '—');
});
