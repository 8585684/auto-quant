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
    /*
     * ⚠️ **风控官必须明确表态**（用户需求 #3）。
     *
     * 它的输出会被 `parseRiskOfficerVerdict` 解析：说"批准"才放行。
     * 桩若返回一句含糊的话（如"我看一下"），解析器会走**保守策略** ——
     * 拦住所有增加风险的动作。所以这个桩必须明确说"批准"。
     *
     * （实测就是这个行为：加风控官后本测试的决策数组变空 —— 因为桩没表态，
     *   保守策略把开仓拦了。那**恰好证明风控官在工作**。）
     */
    if (system.includes('「risk_officer」')) {
      return {
        text: '批准。仓位与当前敞口匹配，未发现集中度问题。',
        latencyMs: 15,
        usage: { promptTokens: 60, completionTokens: 20 },
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

test('★ 八个角色真的都被调用了（不是只问了裁决）', async () => {
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});

  /*
   * **8 = 4 分析师 + bull + bear + judge + 风控官**
   *
   * 风控官是用户需求 #3（"风控由一个智能体来负责"）的落地 ——
   * 它在裁决之后、渲染之前被问一次。
   */
  assert.equal(seen.length, 8, `应当有 8 次角色调用（7 角色 + 风控官），实际 ${seen.length}`);

  /* 关键角色都要在（含风控官） */
  for (const role of ['market_analyst', 'technical', 'newscaster', 'sentiment', 'bull', 'bear', 'judge', 'risk_officer']) {
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

/* -------------------------------------------------------------------------- */
/*  市场调研（联网搜索）接入（用户需求 #2 / #4）                                 */
/* -------------------------------------------------------------------------- */

test('★★ 调研结果真的进入了团队材料（新闻分析师能看到它）', async () => {
  /*
   * 用户原话：
   * > 「总管**委派子代理去做市场调研**（查新闻、各大交易所社区、社交媒体、新闻源等等）
   * >  根据资料反馈给相应的智能体做处理」
   *
   * 这条钉住"调研确实被喂给了角色"，而不是走个形式。
   */
  const seenContexts: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };

  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: wrapped }),
    baseMaxTokens: 4096,
    research: async (symbols) => {
      /* 桩：返回一段可辨识的调研文本。 */
      return `## 联网搜索结果\n独家线索：${symbols.join(',')} 有重大消息 https://example.com/news`;
    },
  });
  await model.complete(SYS, '当前候选 BTCUSDT、ETHUSDT', {});

  assert.ok(
    seenContexts.some((c) => c.includes('独家线索')),
    '★ 调研结果必须出现在角色的材料里',
  );
  assert.ok(
    seenContexts.some((c) => c.includes('BTCUSDT')),
    '★ 调研应当带上从提示词里识别出的标的',
  );
});

test('★ 调研失败【不阻断】整轮决策（行情数据是好的）', async () => {
  /*
   * 搜索是外部依赖。抛错会让"新闻拿不到"升级成"整轮失败" ——
   * 而团队完全可以基于行情决策。
   */
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
    research: async () => {
      throw new Error('搜索端点不可达');
    },
  });

  const result = await model.complete(SYS, USER, {});
  assert.ok(result.text.includes('<decision>'), '★ 调研失败仍要产出决策块');
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok', '★ 仍要是合法 JSON');
});

test('★ 不传 research 时行为与之前一致（既有部署不受影响）', async () => {
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});
  assert.ok(result.text.includes('<decision>'));
  assert.equal(seen.length, 8, '角色数不变（8 = 7 角色 + 风控官）');
});
/* -------------------------------------------------------------------------- */
/*  材料接线：行情数据必须真的进到角色手里（2026-10-12 实测修正）                 */
/* -------------------------------------------------------------------------- */

test('★★ 行情数据（userPrompt）必须进到角色的材料里，而不是被规则顶掉', async () => {
  /*
   * 实测踩到的严重缺陷：第一版把 `systemPrompt`（**规则**）当成了市场材料，
   * 而把 `userPrompt`（**真正的候选池与指标序列**）只当新闻。
   *
   * 后果 —— 模型明确抱怨：
   *   「本轮材料中没有提供任何市场数据，因此无法进行市场结构分析」
   *   「提示词里没有附带任何行情数据、候选池或持仓信息 —— 我手上是空的」
   *
   * 而同一时刻日志显示「list_candidates → 20 个」——
   * **数据取到了，只是没进提示词**。团队于是基于"空材料"讨论了一轮。
   */
  const seenContexts: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };

  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model.complete('【这是规则：必须输出 <decision> 块】', '【这是行情：BTCUSDT 现价 83000，4H EMA20 上行】', {});

  assert.ok(
    seenContexts.some((c) => c.includes('BTCUSDT 现价 83000')),
    '★ 行情数据必须出现在角色的材料里（它来自 userPrompt）',
  );
  assert.ok(
    seenContexts.some((c) => c.includes('这是规则')),
    '★ 规则也要带进去（角色需要知道输出格式），但不能顶掉行情',
  );
});

test('★ 角色的 system 提示词明确说"你没有工具"（防假装取数）', async () => {
  /*
   * 实测：角色以为它能取数，输出了「我先拉取候选池与指标序列再做客观描述」——
   * 而那些动作**永远不会发生**，且会让单角色拖到 100 秒以上。
   */
  const seenSystems: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenSystems.push(messages.find((x) => x.role === 'system')?.content ?? '');
    return call(m, messages, o);
  };
  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});

  assert.ok(seenSystems.length > 0);
  assert.ok(
    seenSystems.every((s) => s.includes('你没有工具') || s.includes('不能调用任何工具')),
    '★ 每个角色的 system 提示词都要说清"没有工具"',
  );
});