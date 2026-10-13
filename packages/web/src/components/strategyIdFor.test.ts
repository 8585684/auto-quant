import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_DRIVEN_MODES } from '@aq/shared';
import { strategyIdFor } from './TraderModals.js';

/* -------------------------------------------------------------------------- */
/*  创建机器人：strategyId 该传什么                                              */
/* -------------------------------------------------------------------------- */

test('★ AI 托管必须传 null —— 服务端会拒绝带策略的请求', () => {
  /*
   * ## 用户 2026-10-03 报的「创建不了机器人」
   *
   * 截图里红框写着：
   *
   *   ⚠️ 智能托管模式不引用任何策略 —— 请不要为它选择策略。
   *
   * **那不是界面提示，那就是服务端抛出来的错误文字**（前端 `setError(err.message)`
   * 把它显示在了表单上）。根因是前端无条件传 `Number(strategyId)`：
   *
   *   前端：strategyId: Number(strategyId)          // 永远是 #9
   *   服务端：if (ai_managed && strategyId !== null) throw …
   *
   * 而 `d338b35`「智能托管与策略彻底解耦」之后服务端已经要求可空
   * （迁移把 `traders.strategy_id` 改成 `ON DELETE SET NULL`），
   * **是前端的类型与注释停留在了解耦之前**。
   *
   * 这条用例钉住"提交时必须传 null"。策略模式仍然要传真实 id。
   */
  assert.equal(
    strategyIdFor('ai_managed', 9),
    null,
    '★ AI 托管不能把下拉框里那个 id 带上去 —— 服务端会因为它直接拒绝创建',
  );
  assert.equal(strategyIdFor('strategy', 9), 9, '策略模式必须带上真实策略 id');
});

test('★ 下拉框 disabled 不等于请求里没有 —— 这正是当初踩的坑', () => {
  /*
   * 界面上那个 `Select` 在 AI 托管时是 `disabled` 的，看起来"选不了策略"。
   * 但 `disabled` 只阻止**用户交互**，`strategyId` 这个 state 仍然是一个真实
   * 策略 id（默认就是列表第一个，`#9`）—— 提交时照样被带上。
   *
   * **"界面上选不了"与"请求里没有"是两件事。** 这条用例用"一个仍然有值的
   * selected"来模拟那个状态：无论传进来什么数字，AI 托管都必须归零。
   */
  for (const selected of [1, 9, 42, 999]) {
    assert.equal(
      strategyIdFor('ai_managed', selected),
      null,
      `AI 托管下不论 state 里残留哪个 id（${selected}），都不能发给服务端`,
    );
  }
});

test('★★ ai_team 也必须传 null —— 复核发现的 P0（前端原本漏了它）', () => {
  /*
   * 用户 2026-10-12 加了「AI 团队（多智能体）」模式。而 `strategyIdFor`
   * 原来写死 `mode === 'ai_managed' ? null : selected` —— 于是：
   *
   *     strategy   -> 9
   *     ai_managed -> null
   *     ai_team    -> 9        ← ★ 把真实策略 id 提交上去
   *
   * 而服务端对所有 AI 驱动模式都拒绝非 null 的 `strategyId`：
   *
   *     throw new Error('AI 托管模式不引用任何策略 —— 请不要为它选择策略。')
   *
   * **后果：`ai_team` 机器人在界面上根本创建不出来**，而且报错指向"策略"，
   * 与用户实际做的事完全对不上。
   *
   * 这与上面那条 `ai_managed` 的 bug **是同一个**，只是换到了新模式的路径上 ——
   * 根因是"哪些模式由 AI 驱动"这条规则被**各自写了一遍模式名**。
   *
   * 修法是让它用共享的 `isAiDriven()`（`packages/shared/src/domain.ts`）——
   * **一处定义，处处生效**。这条测试就是那个承诺的执行者。
   */
  assert.equal(strategyIdFor('ai_team', 9), null, '★ ai_team 必须传 null（否则服务端拒绝）');
});

test('★ 所有 AI 驱动模式都必须传 null（加新模式时这条会红，提醒你登记）', () => {
  /*
   * 防的是"又加了一个 AI 模式、又漏改这里"。
   *
   * 判据不是"列出已知模式"，而是**遍历共享的 AI_DRIVEN_MODES** ——
   * 未来在共享包里登记新模式时，这里自动覆盖；而如果忘了登记，
   * 那说明"AI_DRIVEN_MODES 本身漏了"，是另一个更该修的缺陷。
   */
  for (const mode of AI_DRIVEN_MODES) {
    assert.equal(strategyIdFor(mode, 42), null, `★ 模式 ${mode} 是 AI 驱动的，必须传 null`);
  }
});

test('固定策略模式仍然要传真实 id（别把 AI 的规则套到它头上）', () => {
  assert.equal(strategyIdFor('strategy', 42), 42);
});