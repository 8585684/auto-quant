/**
 * 团队 DecisionModel 的端到端测试。
 *
 * 这是 S3 的**验收测试**：证明"一次 `complete()` 背后真的跑了一个团队，
 * 并且产出交易循环能解析的格式"。
 *
 * 判据不是"函数返回了字符串"，而是**那段字符串能被交易循环的契约认出来**：
 * `<decision>[...]</decision>` —— 见 `strategy/prompt.ts` 的输出格式要求。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { createTeamDecisionModel } from './routedModel.js';
import { extractFirstJsonArray } from './agent/deskOutput.js';

/**
 * 造一个"每个角色都给一段像样输出"的桩。
 *
 * ⚠️ 关键：**裁决（judge）必须返回 JSON 数组** —— 那是交易循环唯一认的东西。
 * 其余角色返回散文即可（它们只进审计块）。
 */
function roleAwareCall(): { call: CallModel; seen: string[] } {
  const seen: string[] = [];
  const call: CallModel = async (modelId, messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    seen.push(system.slice(0, 40));
    /*
     * 判据是"问的是哪个角色"。真实实现里角色名在 system 提示词里
     *（见 `createTeamDecisionModel` 的 ask）。
     */
    if (system.includes('「judge」')) {
      return {
        text: '结论：偏多，但仓位要小。\n[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":100,"stopLoss":60000,"takeProfit":70000,"confidence":70}]',
        latencyMs: 20,
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    }
    return {
      text: `我是 ${system.includes('「') ? system.slice(system.indexOf('「') + 1, system.indexOf('」')) : '未知角色'}，这是我的产出。`,
      latencyMs: 15,
      usage: { promptTokens: 80, completionTokens: 20 },
    };
  };
  return { call, seen };
}

const SYS = '你是交易员。必须把决策放在 <decision> 块里。';
const USER = '当前市场材料……';

test('★★ 团队模式一次 complete() 背后跑完整个交易台，并产出可解析的决策', async () => {
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
  });

  const result = await model.complete(SYS, USER, {});

  /* ① 交易循环的契约：必须有 <decision> 块 */
  assert.ok(result.text.includes('<decision>'), '★ 必须有 decision 块（不然交易循环解析不到）');
  assert.ok(result.text.includes('</decision>'));

  /* ② 内容必须是**可解析的决策数组**，而不是一句散文 */
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok', '★ decision 块里必须是合法 JSON 数组');
  assert.equal(extracted.decisions?.length, 1);
  assert.equal((extracted.decisions?.[0] as Record<string, unknown>).action, 'open_long');

  /* ③ 审计信息也要在（用户要求看得见"为什么这么决策"） */
  assert.ok(result.text.includes('<team>'), '★ 要有团队审计块');
});

test('★ 七个角色真的都被调用了（不是只问了裁决）', async () => {
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});

  /* 7 = 4 分析师 + bull + bear + judge */
  assert.equal(seen.length, 7, `应当有 7 次角色调用，实际 ${seen.length}`);

  /* 关键角色都要在 */
  for (const role of ['market_analyst', 'technical', 'newscaster', 'sentiment', 'bull', 'bear', 'judge']) {
    assert.ok(
      seen.some((s) => s.includes(`「${role}」`)),
      `★ 角色 ${role} 没有被调用`,
    );
  }
});

test('★ 系统提示词（含输出格式要求）被带进团队 —— 不能丢', async () => {
  /*
   * 这条防的是一个很容易犯的错：团队角色提示词**替换掉**了交易循环的 system，
   * 于是团队不知道要输出 `<decision>` 格式 —— 整轮白跑。
   */
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const seenContexts: string[] = [];
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };
  const model2 = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model2.complete('【唯一的输出格式要求：<decision>】', USER, {});

  assert.ok(
    seenContexts.some((c) => c.includes('<decision>')),
    '★ 交易循环的输出格式要求必须出现在团队材料里',
  );
});

test('★ 整条角色链失败时返回空决策块 —— 不抛出、不编造动作', async () => {
  /*
   * 一次团队会议失败（额度尽、网关抖动）不该让整轮决策抛错。
   * 返回"不行动 + 说清原因"比抛错有用：前者操作员看得懂，后者只在日志里留栈。
   */
  const failing: CallModel = async () => {
    const err = new Error('insufficient credits') as Error & { status?: number };
    err.status = 429;
    throw err;
  };
  const model = createTeamDecisionModel({ router: new ModelRouter({ call: failing }), baseMaxTokens: 1024 });
  const result = await model.complete(SYS, USER, {});

  assert.ok(result.text.includes('<decision>'), '仍要有 decision 块');
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok');
  assert.deepEqual(extracted.decisions, [], '★ 全失败时必须是不行动，不能编造');
  assert.ok(!result.text.includes('open_long'), '★ 绝不能凭空造出开仓动作');
});

test('onStep 把团队的每一步报出来（可观测性）', async () => {
  const { call } = roleAwareCall();
  const steps: string[] = [];
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(`${s.phase}:${s.role}`),
  });
  await model.complete(SYS, USER, {});
  assert.ok(steps.length > 0, '★ 要有步骤回调（界面靠它显示团队在做什么）');
  assert.ok(steps.some((s) => s.startsWith('analysis')), '要有分析阶段');
  assert.ok(steps.some((s) => s.startsWith('verdict')), '要有裁决阶段');
});
