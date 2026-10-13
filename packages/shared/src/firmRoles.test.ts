/**
 * **加新角色之前必须先查三处**（2026-10-13 的真实事故换来的）。
 *
 * ## 事故：我在两轮里重复实现了三个已有角色
 *
 * ```
 *   第一轮：在 trader/agent/roles.ts 新增 engineer / reporter / clerk，
 *           理由写得很充分（"用户需求⑤点名要有，而系统里没有"）。
 *           而我当时的判据只有：roles.ts 与 ROLE_MAX_TOKENS。
 *
 *   第二轮：实现 runHealthCheck() 并接进审视路径 —— 然后才发现
 *           firm.ts:246 的 `system_engineer` 状态已经是 `staffed`，
 *           而且 selfcheck.ts（15KB）+ selfcheckRunner.ts（10KB）+
 *           selfcheck.test.ts（14KB）**早就把它实现完整了**，每 30 分钟在跑。
 *
 *   → 我把那 477 行 revert 掉了（commit 2fd25d7）。
 * ```
 *
 * ## 为什么会犯这个错
 *
 * 我查的判据是「`roles.ts` 里有没有这个角色」——
 * 而**这份 `firm.ts` 里一直摆着答案**。
 * **我搜的地方不对，而我以为搜过了就不必再搜。**
 *
 * ## 这三条断言防的就是"同一个错误的下一次"
 *
 * ```
 *   ① 本文件（FIRM_ROLES）         —— 组织架构层
 *   ② routedModel.ts 的 ROLE_TIERS —— 路由层
 *   ③ 实现层（grep 角色 id）        —— 有没有人在干这件事
 * ```
 * ①② 可以静态断言（本文件就是干这个的）。
 * ③ 没法通用断言，所以这里退一步：**断言"planned 的角色仍然老实标着 planned"** ——
 * 至少让"我新增了实现但忘了改状态"和"我重复实现了已有角色"两件事
 * 至少在**数据上**能被看见。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRM_ROLES, firmRoleOf } from './firm.js';

test('★★★ 用户需求⑤点名的岗位必须都在组织架构里（这是"查第一处"）', () => {
  /*
   * 用户的原话：
   * 「有主管、分析账户的、有调查新闻的、有监控社区的、有查市场情绪的、
   *   有维护系统的程序员、有汇报工作的、有文员、有交易员、有风控员等等」
   */
  const required: [string, string][] = [
    ['主管', 'supervisor'],
    ['调查新闻', 'newscaster'],
    ['查市场情绪', 'sentiment'],
    ['维护系统的程序员', 'system_engineer'],
    ['汇报工作', 'reporter'],
    ['文员', 'clerk'],
    ['风控员', 'risk_officer'],
  ];
  for (const [what, id] of required) {
    assert.ok(
      firmRoleOf(id) !== undefined,
      `★ 用户点名的「${what}」必须在本文件里有定义（id=${id}）—— 加实现之前先查这里`,
    );
  }
});

test('★★★ `system_engineer` 必须是 `staffed`（它真的有实现在跑）', () => {
  /*
   * ⚠️ 这条断言的全部价值在于**它当时能拦住我**：
   * 我第二轮想实现"系统体检"时，如果先跑了这个文件，
   * 就会看到 `system_engineer` 已经是 `staffed` —— 然后去查它的实现，
   * 而不是新写一个 `runHealthCheck`。
   */
  const r = firmRoleOf('system_engineer');
  assert.ok(r !== undefined, '★ 必须有 system_engineer');
  assert.equal(
    r.status,
    'staffed',
    '★ system_engineer 有完整实现（自检，每 30 分钟跑），状态必须是 staffed 而不是 planned',
  );
});

test('★★★ 每个角色的 `duty` 必须说清"具体干什么"（不是"认真负责"那种空话）', () => {
  /*
   * 用户要的是"看板能直观显示有哪些智能体、都是什么分工"。
   * 所以 `duty` 是给操作员看的一句话 —— 它必须具体到能判断"这个岗位在不在干活"。
   */
  for (const r of FIRM_ROLES) {
    assert.ok(r.duty.trim().length >= 8, `★ ${r.id} 的 duty 太短（"${r.duty}"）`);
    assert.ok(
      !/^(认真|努力|负责|好好)/.test(r.duty.trim()),
      `★ ${r.id} 的 duty 是空话（"${r.duty}"）—— 要写清做什么判断`,
    );
  }
});

test('★★★ 角色 id 必须唯一（重复 id 会让界面上两个位置显示同一件事）', () => {
  const ids = FIRM_ROLES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `★ 有重复的角色 id：${ids.join(', ')}`);
});
