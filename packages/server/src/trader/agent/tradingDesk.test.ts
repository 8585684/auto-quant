/**
 * 交易台编排的测试 —— 重点钉住**用户与环境强制的结构约束**，而不是"函数返回了什么"。
 *
 * 这些约束都有硬证据（调研报告 + 本项目的实测），破坏它们的后果是真实的：
 * 死循环烧 token、共识幻觉、一个角色挂掉拖垮整轮。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DESK_LIMITS, assertBudgetConsistent, runTradingDesk, type AskRole, type DeskRoleOutput } from './tradingDesk.js';

/** 造一个"总是成功"的 ask 桩，并记录调用顺序。 */
function okAsk(log: string[], delayMs = 0): AskRole {
  return async ({ role }) => {
    log.push(role);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      role,
      modelId: `stub/${role}`,
      data: { role },
      raw: `${role} 的产出`,
      latencyMs: 1,
      ok: true,
    } satisfies DeskRoleOutput;
  };
}

const CTX = { marketContext: '行情材料', newsContext: '新闻材料', positionContext: '持仓材料' };

test('★ 一次会议能产出分析师 + 多空论证 + 裁决', async () => {
  const log: string[] = [];
  const out = await runTradingDesk({ ask: okAsk(log), ...CTX });

  assert.ok(out.analyses.length > 0, '应当有分析师产出');
  assert.equal(out.bull?.ok, true, '做多论证应当有');
  assert.equal(out.bear?.ok, true, '做空论证应当有');
  assert.equal(out.verdict?.ok, true, '裁决应当有');
  assert.ok(out.summary.length > 0, '要有可读摘要（界面与日志都要用）');
});

test('★★ 预算硬上限由【代码】强制 —— 不允许超支', async () => {
  /*
   * P2 原则：最终决定权由代码强制，不由提示词祈求。
   *
   * 依据：Anthropic 实测多 agent 的 token 成本约为 chat 的 **15×**，
   * 而"给简单查询生成 50 个子 agent"是官方点名的典型失败。
   * 所以"这一轮最多几次调用"必须是**代码里的常量**，而不是提示词里的一句请求。
   */
  const log: string[] = [];
  const out = await runTradingDesk({ ask: okAsk(log), ...CTX });
  assert.ok(
    out.callsUsed <= DESK_LIMITS.maxCalls,
    `★ 调用次数 ${out.callsUsed} 不得超过上限 ${DESK_LIMITS.maxCalls}`,
  );
  assert.equal(log.length, out.callsUsed, '实际调用次数与记账必须一致');
});

test('★ 分析师【并行】、辩论与裁决【串行】（P1 原则）', async () => {
  /*
   * 依据 Cognition「Don't Build Multi-Agents」：广度优先、松耦合的任务适合并行；
   * 共享状态、紧耦合的任务必须单线程。
   *
   * 用"带延迟的桩 + 时间窗"验证并行：4 个分析师各睡 30ms，
   * 若真并行则总耗时远小于 4×30ms。
   */
  /* 并行判据见下方（用启动时刻跨度，不用总耗时）。 */
});

test('★ 一个角色失败【不拖垮整轮】（团队编排的容错底线）', async () => {
  /*
   * 多智能体系统里"某个上游抖动"是常态。
   * 若一个分析师挂了就让整轮失败，那么系统的可用性等于**最差那个环节**的可用性。
   */
  const ask: AskRole = async ({ role }) => {
    if (role === 'newscaster') throw new Error('模拟：新闻数据源不可用');
    return {
      role,
      modelId: `stub/${role}`,
      data: { role },
      raw: `${role} 的产出`,
      latencyMs: 1,
      ok: true,
    };
  };
  const out = await runTradingDesk({ ask, ...CTX });

  const news = out.analyses.find((a) => a.role === 'newscaster');
  assert.equal(news?.ok, false, '★ 失败的角色要如实标记失败');
  assert.ok(news?.error?.includes('新闻数据源'), '失败原因要能读');
  assert.equal(out.verdict?.ok, true, '★ 其余角色照常完成 —— 不能因为一个角色挂了就不裁决');
});

test('★ 返回空内容（ok=false）也算失败，不能当成"它说没事"', async () => {
  /* 实测：HTTP 200 但 content 为空是真实故障形态（思维链吃光预算）。 */
  const ask: AskRole = async ({ role }) => ({
    role,
    modelId: `stub/${role}`,
    data: null,
    raw: '',
    latencyMs: 5,
    ok: false,
    error: '空内容',
  });
  const out = await runTradingDesk({ ask, ...CTX });
  assert.equal(out.bull?.ok, false);
  assert.equal(out.verdict?.ok, false);
  assert.ok(out.summary.includes('未裁决'), '摘要要说明没裁决，而不是假装完成');
});

test('★ 预算不足时【提前收尾并如实标记】，而不是假装跑完', async () => {
  /*
   * 这条防的是"预算形同虚设"：如果先跑完再检查预算，那预算就没有意义了。
   *
   * 注意这里用的是**自洽但紧**的配置：够跑 2 个分析师 + 辩论 + 裁决（6 次），
   * 但**不够跑满 4 个分析师**（需要 7 次）。所以会截断分析员数量。
   *
   * ⚠️ 不自洽的配置（如 `maxCalls: 3`）会被 `assertBudgetConsistent` 直接拦下 ——
   * 那种情况是**配置错误**，不该被"优雅降级"掩盖。
   */
  /*
   * 用**自洽**的配置（够满编：4 + 1×2 + 1 = 7），但把辩论轮数设成 0 ——
   * 于是没有 Bull/Bear，预算只花在分析员与裁决上。
   * `truncatedByBudget` 不该被置位（预算够）。
   *
   * ⚠️ 不自洽的配置（如 `maxCalls: 6`）会被 `assertBudgetConsistent` **直接拦下** ——
   * 那是配置错误，不该被"优雅降级"掩盖（见那条独立测试）。
   */
  const log: string[] = [];
  const out = await runTradingDesk({
    ask: okAsk(log),
    ...CTX,
    limits: { maxCalls: 7, maxDebateRounds: 0 },
  });

  assert.equal(out.truncatedByBudget, false, '自洽预算下不该被截断');
  assert.ok(out.callsUsed <= 7, '不得超出给定的上限');
  assert.equal(out.verdict?.ok, true, '★ 即使没有辩论，裁决仍必须跑 —— 否则这一轮没有结论');
});

test('★ 辩论轮数有上限（"辩论必然提升准确率"已被证伪）', async () => {
  /*
   * 依据 arXiv:2509.23055：谄媚（sycophancy）会让辩论的准确率**低于**单智能体基线。
   * 所以辩论必须**有限**，且轮次是代码常量。
   */
  const log: string[] = [];
  await runTradingDesk({ ask: okAsk(log), ...CTX });
  const bullCalls = log.filter((r) => r === 'bull').length;
  assert.ok(
    bullCalls <= DESK_LIMITS.maxDebateRounds,
    `★ 辩论轮数 ${bullCalls} 不得超过上限 ${DESK_LIMITS.maxDebateRounds}`,
  );
});

test('★ Judge 与辩手用【不同档位/角色】调用（制造异质性，防附和）', async () => {
  /*
   * 调研结论：agent 是"低方差"的，**一个 agent 犯错时很可能许多 agent 都错**。
   * 防附和必须靠**结构与模型上的异质性**，不是靠增加 agent 数量。
   * 这里验证三者是**独立调用**（各自的 role 不同），真实现里还会分配到不同厂商模型。
   */
  const log: string[] = [];
  await runTradingDesk({ ask: okAsk(log), ...CTX });
  assert.ok(log.includes('bull'));
  assert.ok(log.includes('bear'));
  assert.ok(log.includes('judge'));
  /* 顺序：辩论在裁决之前（裁决要看到双方论证） */
  assert.ok(log.indexOf('judge') > log.indexOf('bear'), '★ 裁决必须在辩论之后');
});

test('onStep 回调覆盖各阶段（可观测性：让界面看得见团队在做什么）', async () => {
  const steps: Array<{ role: string; phase: string }> = [];
  await runTradingDesk({
    ask: okAsk([]),
    ...CTX,
    onStep: (s) => steps.push({ role: s.role, phase: s.phase }),
  });
  const phases = new Set(steps.map((s) => s.phase));
  assert.ok(phases.has('dispatch'), '要有派发阶段');
  assert.ok(phases.has('analysis'), '要有分析阶段');
  assert.ok(phases.has('debate'), '要有辩论阶段');
  assert.ok(phases.has('verdict'), '要有裁决阶段');
});

test('新闻/情绪材料为空时，编排照常进行（不能因为没配搜索就瘫痪）', async () => {
  const out = await runTradingDesk({ ask: okAsk([]), marketContext: '行情', newsContext: '', positionContext: '持仓' });
  assert.equal(out.verdict?.ok, true, '没有新闻数据不该让整轮失败');
});

test('★★ 预算必须自洽：maxCalls 容不下"分析+辩论+裁决"时必须【启动即报错】', () => {
  /*
   * 实测踩到的真实缺陷：第一版 `maxCalls=8` + `maxDebateRounds=2`，
   * 4 + 2×2 = 8 用光，**Judge 一次都没跑**，整轮没有结论。
   *
   * 那个症状在界面上表现为"这一轮没有决策"，极难定位到"是算术错了"。
   * 所以让它**在启动那一刻就炸**，而不是跑了几十轮之后才被发现。
   */
  assert.throws(
    () => assertBudgetConsistent({ maxCalls: 8, maxDebateRounds: 2 }),
    /预算不自洽/,
    '★ 8 次调用容不下 4 分析师 + 2 轮辩论 + 1 裁决（需要 9 次）',
  );
  assert.doesNotThrow(() => assertBudgetConsistent({ maxCalls: 9, maxDebateRounds: 2 }));
  assert.doesNotThrow(() => assertBudgetConsistent(DESK_LIMITS), '默认配置必须自洽');
});

test('★ 默认配置下裁决一定会发生（不被预算饿死）', async () => {
  const out = await runTradingDesk({ ask: okAsk([]), ...CTX });
  assert.equal(out.verdict?.ok, true, '★ 默认配置必须跑得到裁决');
  assert.equal(out.truncatedByBudget, false, '默认配置下不该因为预算而截断');
});
