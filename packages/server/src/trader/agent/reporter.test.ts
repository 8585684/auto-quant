/**
 * **汇报员接线**的测试（2026-10-13）。
 *
 * ## 为什么这个角色值得单独一个测试文件
 *
 * 用户需求 ⑤ 的原话：
 * > 「有主管、分析账户的，有调查新闻的、有监控社区的、有查市场情绪的、
 * >  **有维护系统的程序员、有汇报工作的、有文员**、有交易员、有风控员等等
 * >  一切专业交易所量化机构有的我们都要有」
 *
 * `reporter` 的提示词、档位、token 预算**早就都有了**（`roles.ts` /
 * `routedModel.ts`），**缺的只有调用点** —— 也就是说它是一段
 * "看起来齐全、实际上从没跑过"的配置。这类缺口最难发现：
 * 界面上一切正常，只是操作员永远读不到那段人话。
 *
 * ## 这里钉住的是三条**结构性**性质（不是"函数返回了什么"）
 *
 * | 性质 | 为什么它重要 |
 * |---|---|
 * | 它**真的被调用**，且**排在裁决之后** | "接线了"与"只是定义了"是两件事 |
 * | 它**失败不影响决策** | 用户明确要求：它是附加动作 |
 * | 预算不足时**跳过它、而不是挤掉裁决官** | 这是本项目踩过两次的坑（裁决被饿死） |
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESK_LIMITS,
  accountSnapshot,
  renderReportMaterial,
  runTradingDesk,
  type AskRole,
  type DeskRoleOutput,
} from './tradingDesk.js';
import { ROLES } from './roles.js';

/** 一次调用的入参（测试要断言"问了谁、用什么档、给了什么材料"）。 */
interface SeenCall {
  role: string;
  tier: string;
  context: string;
  task: string;
}

/** 造一个"总是成功"的 ask 桩，并记录每次调用的完整入参。 */
function okAsk(seen: SeenCall[]): AskRole {
  return async ({ role, tier, context, task }) => {
    seen.push({ role, tier, context, task });
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

/** 只关心"问了哪些角色、什么顺序"时的简化桩。 */
function rolesOnly(log: string[]): AskRole {
  return async ({ role }) => {
    log.push(role);
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

/* -------------------------------------------------------------------------- */
/*  ① 它真的被调用                                                              */
/* -------------------------------------------------------------------------- */

test('★★★ 每轮决策结束后会跑一次汇报员（用户需求 ⑤ 的"汇报工作的"）', async () => {
  /*
   * ⚠️ 这条测试存在的理由就是那个缺口本身：`reporter` 的提示词与档位
   * 早就在仓库里，而**生产代码里没有任何地方跑它** ——
   * 那意味着"汇报工作的"这个岗位是虚设的，而界面上看不出来。
   */
  const seen: Array<{ role: string; tier: string; context: string; task: string }> = [];
  const out = await runTradingDesk({ ask: okAsk(seen), ...CTX });

  const reporter = seen.find((s) => s.role === 'reporter');
  assert.ok(reporter !== undefined, '★ 必须真的调用汇报员（不是只定义了提示词）');

  /* ② 档位必须是 T1_fast —— 与 `firm.ts` / `TIER_BY_ROLE` 里 reporter 的定义一致。 */
  assert.equal(reporter!.tier, 'T1_fast', '★ 汇报员是 T1 体力活档（firm.ts 里就是这么标的）');

  /* ③ 提示词必须来自 `roles.ts` 里**已经写好的那一份** —— 不能在这里另写一段。 */
  assert.equal(
    reporter!.task,
    ROLES.reporter.system,
    '★ 必须用 roles.ts 里那份提示词（含"5 行以内""不许美化"），不能另写',
  );

  /* ④ 产出要放进 DeskOutcome（否则跑完了没人拿得到）。 */
  assert.equal(out.report, 'reporter 的产出', '★ 汇报结果必须放进 DeskOutcome.report');
  assert.ok(out.summary.includes('已汇报'), '★ 摘要要体现"已汇报"');
});

test('★★★ 汇报员排在【裁决之后】—— 顺序就是那条不变量', async () => {
  /*
   * ⚠️ 这条不是"顺序洁癖"，它是**"预算不足时不挤掉裁决官"的机制本身**：
   *
   * ```
   *   汇报员在裁决【之后】→ 它的 canAsk() 检查发生在裁决已经跑完之后
   *   → 预算不够时被牺牲的永远是它，裁决官结构上不可能被它挤掉
   * ```
   *
   * 若哪天有人把它挪到裁决之前（例如"让它先看分析师产出再写"），
   * 那个保证就没了 —— 而症状会回到本项目踩过两次的老样子：
   * **裁决官被饿死、整轮没有结论，而界面上看起来像"模型决定观望"**。
   */
  const order: string[] = [];
  await runTradingDesk({ ask: rolesOnly(order), ...CTX });

  const atJudge = order.indexOf('judge');
  const atReporter = order.indexOf('reporter');
  assert.ok(atJudge >= 0 && atReporter >= 0);
  assert.ok(
    atReporter > atJudge,
    `★ 汇报员必须在裁决之后（实际顺序：${order.join(' → ')}）`,
  );
  /* 它还要在辩论之后 —— 它汇报的是"这一轮的结论"。 */
  assert.ok(atReporter > order.indexOf('bear'), '★ 汇报员要在辩论之后');
});

test('★★ 汇报员拿到的材料是【这一轮的事实】，不是 13 万字符的市场材料', async () => {
  /*
   * ## 为什么这条必须有
   *
   * 汇报员的任务是**写 5 行摘要**。若把完整市场材料（线上实测 130,420 字符）
   * 塞给它，会有两个后果，而两个都不报错：
   * ```
   *   ① 为了一段摘要读 13 万字符 —— 慢、贵，而且它多半会去【复述】
   *      它本该压缩的东西（提示词原话："不要复述原始产出"）
   *   ② 那个材料里有 12 个候选的完整指标序列，与"讲人话"毫无关系
   * ```
   * 所以这里直接断言"喂它大材料，它拿到的仍然很小"。
   */
  const big = [
    '# 账户',
    '权益 20.75 USDT | 可用 12.30（59.3%）| 持仓数 1',
    '# 全市场概览（币安 525 个 USDT 永续）',
    ...Array.from({ length: 3000 }, (_, i) => `SYM${i}USDT 1.23 -1.5% 456M`),
    ...Array.from({ length: 6 }, (_, i) =>
      `### ${i + 1}. CAND${i}USDT（coinpool）\ncurrent_price = ${i}\n` +
      `价格: [${Array.from({ length: 40 }, (_, j) => j).join(', ')}]`),
  ].join('\n');
  assert.ok(big.length > 50_000, `前提校验：材料要够大（实际 ${big.length}）`);

  const seen: SeenCall[] = [];
  /*
   * ⚠️ 裁决官必须给一份**可解析的决策数组** —— 否则汇报材料走的是
   * "抽不到数组"那条分支（见下面那条专门测它的用例），
   * 而这条测试要验的是"动作分布被算出来了"。
   */
  const ask: AskRole = async ({ role, tier, context, task }) => {
    seen.push({ role, tier, context, task });
    const raw =
      role === 'judge'
        ? '结论：都不做。\n[{"symbol":"BTCUSDT","action":"skip"},{"symbol":"ETHUSDT","action":"skip"}]'
        : `${role} 的产出`;
    return {
      role,
      modelId: `stub/${role}`,
      data: { role },
      raw,
      latencyMs: 1,
      ok: true,
    } satisfies DeskRoleOutput;
  };
  const out = await runTradingDesk({ ask, ...CTX, marketContext: big });
  const reporter = seen.find((s) => s.role === 'reporter');
  assert.ok(reporter !== undefined);

  assert.ok(
    reporter!.context.length < 2_000,
    `★ 汇报员的材料必须很小（实际 ${reporter!.context.length} 字符，市场材料 ${big.length}）`,
  );
  /* ⚠️ 但**候选的指标序列一个都不能进来** —— 那与"讲人话"无关。 */
  assert.ok(!reporter!.context.includes('CAND0USDT'), '★ 候选指标序列不该进汇报材料');
  /* ② 账户状态必须**在**里面（它要回答的第一个问题就是"账户什么状态"）。 */
  assert.ok(reporter!.context.includes('权益 20.75'), '★ 账户状态必须给它');
  /* ③ 决策条数与动作分布要在（而不是把数组原样贴给它）。 */
  assert.ok(reporter!.context.includes('共 2 条'), '★ 要说清这一轮有几条决策');
  assert.ok(reporter!.context.includes('skip 2 条'), '★ 要给出动作分布');
  assert.equal(out.report, 'reporter 的产出');
});

/* -------------------------------------------------------------------------- */
/*  ② 失败不影响决策                                                            */
/* -------------------------------------------------------------------------- */

test('★★★ 汇报员失败【不影响决策】—— 它是附加动作', async () => {
  /*
   * ## 用户的要求
   *
   * > 「它是**附加**动作，失败不能影响决策。」
   *
   * ## 为什么这条不是"想当然"
   *
   * 汇报员排在**最后**，而它一旦抛穿，`runTradingDesk` 就会整体抛错 ——
   * 于是**一轮本来已经裁决完、决策已经成型的会议会因为一段摘要而作废**。
   * 那正是本项目反复强调的"一个角色挂掉拖垮整轮"。
   *
   * ⚠️ 这里走的是 `safeAsk` 那条既有路径（把异常转成 `ok: false`），
   * **不是**自己写的 try/catch —— 见 `safeAsk` 的说明：自己写一个语义不同的
   * 版本曾经让"角色级超时"失效（实测有角色跑了 398 秒）。
   */
  const seen: string[] = [];
  const ask: AskRole = async ({ role }) => {
    seen.push(role);
    /* 裁决官给一份**完整可解析的决策数组** —— 它必须原样活下来。 */
    if (role === 'judge') {
      return {
        role,
        modelId: 'stub/judge',
        data: null,
        raw: '结论：偏多。\n[{"symbol":"BTCUSDT","action":"open_long","stopLoss":60000}]',
        latencyMs: 1,
        ok: true,
      } satisfies DeskRoleOutput;
    }
    if (role === 'reporter') throw new Error('模拟：汇报员挂了');
    return {
      role,
      modelId: `stub/${role}`,
      data: { role },
      raw: `${role} 的产出`,
      latencyMs: 1,
      ok: true,
    } satisfies DeskRoleOutput;
  };

  const out = await runTradingDesk({ ask, ...CTX });

  assert.ok(seen.includes('reporter'), '前提校验：汇报员确实被问过');
  /* ① 决策本身完好 —— 裁决官照常产出，且那段数组仍可解析。 */
  assert.equal(out.verdict?.ok, true, '★ 汇报员失败不能让裁决消失');
  assert.ok(
    out.verdict?.raw.includes('"action":"open_long"'),
    '★ 决策内容必须原样保留（附加动作不能改结论）',
  );
  /* ② 失败要如实标记，不能假装它没跑过、也不能编一段摘要。 */
  assert.equal(out.report, null, '★ 失败时 report 必须是 null（而不是空串或编造的内容）');
  assert.ok(out.summary.includes('未汇报'), '★ 摘要要如实说"未汇报"');
  /* ③ 其余角色一个都没受影响。 */
  assert.equal(out.bull?.ok, true);
  assert.equal(out.bear?.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  ③ 预算不足时不调用它（不挤掉裁决官）                                          */
/* -------------------------------------------------------------------------- */

test('★★★ 预算不足时【跳过汇报员】，而裁决官必须照常跑', async () => {
  /*
   * ## 这是本项目踩过两次的那个坑
   *
   * ```
   *   第一版 maxCalls=8 配 maxDebateRounds=2 → 4 + 2×2 = 8 次用光，
   *   Judge 一次都没跑，整轮没有结论。
   * ```
   * 症状看起来像"模型决定观望"，**从表面极难定位到"是算术错了"**。
   *
   * ## 这里用【自洽但紧】的预算
   *
   * `{maxCalls: 8, maxDebateRounds: 1}` 恰好等于不变量
   *（1 总管 + 4 分析师 + 1×2 辩论 + 1 裁决 = 8）——
   * 于是**没有任何余量给汇报员**，而裁决必须仍然跑得到。
   *
   * ⚠️ 这**正是设计意图**：汇报员排在最后，所以它是被牺牲的那一个；
   * 而裁决官由 `assertBudgetConsistent` 的不变量保护，不可能被它挤掉。
   */
  const seen: string[] = [];
  const out = await runTradingDesk({
    ask: rolesOnly(seen),
    ...CTX,
    limits: { maxCalls: 8, maxDebateRounds: 1 },
  });

  assert.ok(!seen.includes('reporter'), `★ 预算不足时不该调用汇报员（实际：${seen.join(', ')}）`);
  assert.equal(out.report, undefined, '★ 没被调用时 report 是 undefined（与"失败"的 null 区分开）');
  /* ② 关键：裁决官**没有被挤掉** —— 这才是这条测试真正要守的东西。 */
  assert.equal(out.verdict?.ok, true, '★★ 裁决官必须照常跑（它才是不可牺牲的那个）');
  assert.ok(seen.includes('judge'), '★ 裁决官必须被调用');
  assert.ok(out.callsUsed <= 8, `不得超支（实际 ${out.callsUsed}）`);
  assert.ok(out.summary.includes('未汇报'), '★ 摘要要如实说"未汇报"');
});

test('★ 预算够时报告"已汇报"，不够时报告"未汇报"（可观测性）', async () => {
  /*
   * ⚠️ 汇报员没跑这件事**必须可见**。它的成因是"预算紧"，
   * 而"预算紧"在界面上本来就该是一个能被看见的状态 ——
   * 静默跳过会让操作员以为"这一轮没什么可汇报的"。
   */
  const steps: Array<{ role: string; phase: string; note: string }> = [];
  await runTradingDesk({
    ask: okAsk([]),
    ...CTX,
    limits: { maxCalls: 8, maxDebateRounds: 1 },
    onStep: (s) => steps.push(s),
  });
  const reportSteps = steps.filter((s) => s.role === 'reporter');
  assert.ok(reportSteps.length > 0, '★ 即使被跳过也要记一条 onStep（否则它是静默的）');
  assert.ok(
    reportSteps.some((s) => s.note.includes('预算不足')),
    '★ 要说清"为什么没汇报"（预算不足），而不是含糊地说"未参与"',
  );
});

test('★ 汇报员的 onStep 记在 report 阶段（界面靠它显示这一步）', async () => {
  const steps: Array<{ role: string; phase: string; note: string }> = [];
  await runTradingDesk({ ask: okAsk([]), ...CTX, onStep: (s) => steps.push(s) });
  const done = steps.filter((s) => s.role === 'reporter' && s.phase === 'report');
  assert.ok(done.length > 0, '★ 要有 report 阶段');
  assert.ok(done.some((s) => s.note.includes('完成')), '★ 成功时要报"完成"（与其它角色同一措辞）');
});

test('★ 摘要里"做多/做空"各自说各自的话（防串行改动的复制粘贴）', async () => {
  /*
   * ⚠️ 这条是**我这次改动里真实犯过的一个错**的回归保护。
   *
   * 往 `summary` 里加"已汇报/未汇报"那一项时，我把 `bull` 那一行的
   * fallback 从「做多论证缺失」误改成了「做空论证缺失」——
   * 于是摘要会显示「做多论证已出 · 做空论证缺失」而实际上两个都在，
   * **操作员据此会以为空头那边没干活**。
   *
   * 它**编译通过、测试全绿**（既有测试只查 `summary.length > 0`），
   * 所以只能靠"把两条线的措辞分别钉住"来防。
   */
  const out = await runTradingDesk({ ask: okAsk([]), ...CTX });
  assert.equal(out.bull?.ok, true);
  assert.equal(out.bear?.ok, true);
  assert.ok(out.summary.includes('做多论证已出'), '★ 做多的结论不能被说成别的');
  assert.ok(out.summary.includes('做空论证已出'), '★ 做空的结论不能被说成别的');
  assert.ok(!out.summary.includes('做空论证缺失'), '★ 两个都成功了，不该出现任何"缺失"');
  assert.ok(!out.summary.includes('做多论证缺失'), '★ 同上');
});

/* -------------------------------------------------------------------------- */
/*  两个纯函数（材料构造）—— 它们才是"不塞大材料"这条性质的落点                    */
/* -------------------------------------------------------------------------- */

test('★★★ accountSnapshot：摘得到账户段，且拿不到时【明说拿不到】', () => {
  /*
   * ⚠️ 汇报员的提示词里写着「数据不足就明说，不要用常识补」。
   * 若这里返回空串，模型看到的是一栏空白 —— 它要么跳过这个问题
   *（操作员于是以为账户没问题），要么拿别的线索编一个。
   */
  const withAccount = '# 账户\n权益 20.75 USDT | 持仓数 1\n# 全市场概览\nSYM1USDT 1.2\n';
  const got = accountSnapshot(withAccount);
  assert.ok(got.includes('权益 20.75'), '★ 必须摘到账户内容');
  assert.ok(!got.includes('全市场概览'), '★ 不能把下一节也带进来（那正是"塞大材料"的入口）');

  const noAccount = '# 全市场概览\nSYM1USDT 1.2\n';
  const none = accountSnapshot(noAccount);
  assert.ok(
    none.includes('数据不足'),
    `★ 拿不到时必须明说"数据不足"（实际：${none}）—— 空串会让模型去编`,
  );

  /* ③ 必须有长度上限：材料是外部输入，长度不可控。 */
  const huge = `# 账户\n${'x'.repeat(5000)}`;
  assert.ok(accountSnapshot(huge).length <= 700, '★ 必须有上限（不能让账户段自己变成大材料）');
  assert.ok(accountSnapshot(huge).includes('截断'), '★ 截断了就要说出来（不能悄悄砍）');
});

test('★★★ renderReportMaterial：事实齐全，且【不含市场数据】', () => {
  /*
   * 它是"不塞大材料"这条性质的**唯一落点** —— 所以直接测它，
   * 而不是起一整个会议去间接观察。
   */
  const text = renderReportMaterial({
    account: '# 账户\n权益 20.75 USDT',
    analyses: [
      { role: 'market_analyst', ok: true },
      { role: 'technical', ok: false, error: '超过 120 秒未返回' },
    ],
    bull: { ok: true },
    bear: { ok: false, error: '空内容' },
    verdict: { ok: true },
    decisions: [{ action: 'skip' }, { action: 'skip' }, { action: 'open_long' }],
    callsUsed: 9,
    maxCalls: 9,
    truncatedByBudget: false,
  });

  /* ① 三个问题各自的事实都要在。 */
  assert.ok(text.includes('权益 20.75'), '要账户状态');
  assert.ok(text.includes('1/2 成功'), '要各角色成败（1 个成功 / 共 2 个）');
  assert.ok(text.includes('technical'), '★ 失败的角色要**点名** —— 否则失败被"信息有限"掩盖');
  assert.ok(text.includes('超过 120 秒未返回'), '★ 失败原因要能读');
  assert.ok(text.includes('skip 2 条'), '★ 动作分布要算出来（而不是把数组原样贴进去）');
  assert.ok(text.includes('open_long 1 条'));
  assert.ok(text.includes('9/9'), '要预算用量');

  /* ② 材料要小 —— 它只该有"事实"，不该有一行行情。 */
  assert.ok(text.length < 1_000, `★ 汇报材料必须小（实际 ${text.length} 字符）`);
});

test('★★★ 抽不到决策数组时必须【如实说】，不能讲成"团队决定观望"', () => {
  /*
   * ⚠️ 这是本项目最贵的一类失败（"看不出异常的失败"）：
   *
   * ```
   *   裁决官的数组被输出预算截断 → extractFirstJsonArray 报 bad-json
   *   → 执行层按"不行动"处理 → 界面上看起来像"模型决定观望"
   * ```
   * 实测为此查了好几轮"提示词、模型、门槛"，**而真相是"预算不够"**。
   *
   * 若汇报员把这件事讲成"团队认为没有机会"，它就在**替一个系统故障
   * 编一个听起来正常的理由** —— 那比不汇报更糟。
   */
  const text = renderReportMaterial({
    account: '（没有账户段）',
    analyses: [],
    bull: null,
    bear: null,
    verdict: { ok: true },
    decisions: null,
    callsUsed: 8,
    maxCalls: 9,
    truncatedByBudget: false,
  });
  assert.ok(text.includes('没有可解析的决策数组'), '★ 必须明说"抽不到数组"');
  assert.ok(text.includes('按"不行动"处理'), '★ 要说清后果（本轮不会有动作）');
  /*
   * ⚠️ 断言的是**它被要求"如实汇报"**，而不是"材料里没有某个措辞" ——
   * 后者是一个**空断言**（我只要不写那句话它就永远通过）。
   * 这里要钉住的是：材料**明确把它定性为故障**，而不是留给模型自己去圆。
   */
  assert.ok(
    text.includes('不要替一个系统故障编一个正常的理由'),
    '★ 必须明确要求它【不要】把这个故障讲成一个正常的判断',
  );
  /* 而"抽不到数组"时**不能**再给一个动作分布（那会是编造的）。 */
  assert.ok(!text.includes('条：'), '★ 抽不到数组时不该给出任何动作分布');
});

test('★ 预算截断这件事要如实传给汇报员（"结论是在受限条件下得出的"）', () => {
  const text = renderReportMaterial({
    account: '（没有账户段）',
    analyses: [],
    bull: null,
    bear: null,
    verdict: null,
    decisions: [],
    callsUsed: 6,
    maxCalls: 9,
    truncatedByBudget: true,
  });
  assert.ok(text.includes('提前收尾'), '★ 受限要如实说明 —— 否则摘要会读起来像"一轮正常的会议"');
});

/* -------------------------------------------------------------------------- */
/*  预算常量的自洽性                                                             */
/* -------------------------------------------------------------------------- */

test('★★ 默认预算容得下汇报员（否则这个岗位等于又没接线）', () => {
  /*
   * ⚠️ 与"接线了但没有调用点"是同一类问题：若默认配置容不下第 9 次，
   * 汇报员在生产里**永远不会跑**，而测试只要不查这一点就全是绿的。
   *
   * 账：1 总管 + 4 分析师 + 1×2 辩论 + 1 裁决 + **1 汇报员** = 9。
   */
  const needed =
    1 /* 总管 */ + 4 /* 满编分析师 */ + DESK_LIMITS.maxDebateRounds * 2 /* 辩论 */ + 1 /* 裁决 */ +
    1 /* 汇报员 */;
  assert.ok(
    DESK_LIMITS.maxCalls >= needed,
    `★ 默认 maxCalls=${DESK_LIMITS.maxCalls} 必须容得下 ${needed} 次（含汇报员）`,
  );
});
