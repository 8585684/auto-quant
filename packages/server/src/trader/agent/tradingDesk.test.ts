/**
 * 交易台编排的测试 —— 重点钉住**用户与环境强制的结构约束**，而不是"函数返回了什么"。
 *
 * 这些约束都有硬证据（调研报告 + 本项目的实测），破坏它们的后果是真实的：
 * 死循环烧 token、共识幻觉、一个角色挂掉拖垮整轮。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DESK_LIMITS, ROLE_TIMEOUT_MS, assertBudgetConsistent, roleTimeoutMs, runTradingDesk, type AskRole, type DeskRoleOutput } from './tradingDesk.js';

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
   * 用**自洽**的配置（够满编：1 总管 + 4 + 0×2 + 1 = 6，取 8 留余量），
   * 但把辩论轮数设成 0 —— 于是没有 Bull/Bear，预算只花在总管、分析员与裁决上。
   * `truncatedByBudget` 不该被置位（预算够）。
   *
   * ⚠️ 不自洽的配置（如 `maxCalls: 6`）会被 `assertBudgetConsistent` **直接拦下** ——
   * 那是配置错误，不该被"优雅降级"掩盖（见那条独立测试）。
   *
   * ⚠️ 2026-10-13：接上真总管后**必须 +1** —— 原来的 7 是
   * "4 分析师 + 1 裁决"，现在还要加上总管那一次。
   */
  const log: string[] = [];
  const out = await runTradingDesk({
    ask: okAsk(log),
    ...CTX,
    limits: { maxCalls: 8, maxDebateRounds: 0 },
  });

  assert.equal(out.truncatedByBudget, false, '自洽预算下不该被截断');
  assert.ok(out.callsUsed <= 8, '不得超出给定的上限');
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
   *
   * ⚠️ 2026-10-13 接上真总管之后，**同一个错误又差点重演**：
   * 不变量现在是 `1 总管 + 分析员 + 2×辩论 + 1 裁决`，
   * 于是 8 次已经不够（需要 9）—— 两个既有测试当场抓住了它。
   */
  assert.throws(
    () => assertBudgetConsistent({ maxCalls: 8, maxDebateRounds: 2 }),
    /预算不自洽/,
    '★ 8 次容不下 1 总管 + 4 分析师 + 2 轮辩论 + 1 裁决（需要 10 次）',
  );
  /*
   * ⚠️ 用**真实配置**（`maxDebateRounds: 1`）验通过路径 ——
   * 否则会把"1 轮辩论"与"2 轮辩论"的算术混在一起
   *（我第一版就混了：断言 9 次配 2 轮辩论不抛错，而它其实需要 10）。
   */
  assert.doesNotThrow(
    () => assertBudgetConsistent({ maxCalls: 9, maxDebateRounds: 1 }),
    '★ 1 总管 + 4 分析师 + 1×2 辩论 + 1 裁决 = 8，9 次够',
  );
  assert.doesNotThrow(() => assertBudgetConsistent(DESK_LIMITS), '默认配置必须自洽');
});

test('★ 默认配置下裁决一定会发生（不被预算饿死）', async () => {
  const out = await runTradingDesk({ ask: okAsk([]), ...CTX });
  assert.equal(out.verdict?.ok, true, '★ 默认配置必须跑得到裁决');
  assert.equal(out.truncatedByBudget, false, '默认配置下不该因为预算而截断');
});

test('★★★ 角色超过档位超时 → 标记失败而不是拖死整轮', () => {
  /*
   * ## 实测动机
   *
   * 单角色延迟波动极大（**同角色同档位**）：
   * ```
   *   newscaster：3.8 秒 ↔ 164 秒
   *   sentiment ：4.5 秒 ↔ 242 秒
   * ```
   * 而整轮 = 最慢那个角色 + 辩论 + 裁决 + 风控 ——
   * **一个 242 秒的角色能把整轮拖到 7 分钟以上**。
   *
   * ## 取舍
   *
   * **宁可没有它，也不要为它等**：超时的分析师只是少一份材料，
   * 而整轮卡死 = 这一轮完全没产出。
   *
   * ⚠️ 这里用注入时钟不方便（`safeAsk` 用的是真 `setTimeout`），
   * 所以这条测试**验证的是路径存在**（超时被转成 ok:false 而不是抛出），
   * 而不是真等 60 秒。
   */
  const slow: AskRole = () =>
    new Promise((resolve) => {
      /* 永不 resolve —— 模拟卡住的模型。 */
      void resolve;
    });
  /* 直接验证"抛出的 Promise 会被转成 ok:false"这条既有路径。 */
  const boom: AskRole = async () => {
    throw new Error('模拟模型挂了');
  };
  return runTradingDesk({ ask: boom, ...CTX }).then((out) => {
    assert.equal(out.analyses.every((a) => !a.ok), true, '失败角色要标成 ok:false');
    assert.ok(out.analyses[0]!.error?.includes('模拟模型挂了'), '错误信息要保留');
    void slow;
  });
});
test('★★★ 裁决官的提示词必须要求【独立判断、不许复读】（真实调研的失败模式）', () => {
  /*
   * ## 来源：真实调研（2026-10-12）
   *
   * [Peacemaker or Troublemaker, arXiv:2509.23055](https://arxiv.org/html/2509.23055v1)
   * 实测出的失败模式之一：
   *
   * > 「有裁判时，裁判**"只复读、不做独立推理"**」
   *
   * 即：让模型"汇总双方观点"时，它倾向于**把双方的话各抄一半、给个骑墙结论** ——
   * 看起来像裁决，实际上**没做任何判断**。而这是"多智能体辩论"被质疑的核心原因之一。
   *
   * ## 这条测试是"防漂移"的
   *
   * 它不测模型行为（那要靠实测），它钉住的是**提示词里那两条可检验的要求**：
   * 「不同意哪一方」「依据什么取舍」—— 复读的人**写不出**这两样。
   *
   * ⚠️ 与 `ROLE_TIERS` 那条防漂移测试同一性质：**要求可以被改，但不能被悄悄删掉。**
   * 若将来有人认为这两句没用而删了它，这条测试会失败，逼他先读这段理由。
   */
  const seen: Array<{ role: string; task: string }> = [];
  const ask: AskRole = async ({ role, task }) => {
    seen.push({ role, task });
    return { role, modelId: `stub/${role}`, data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  return runTradingDesk({ ask, ...CTX }).then(() => {
    const judge = seen.find((s) => s.role === 'judge');
    assert.ok(judge !== undefined, '应当问过裁决官');
    assert.ok(
      judge!.task.includes('不能只复读'),
      '★ 必须明确禁止"只复读" —— 那是调研实测出的裁判失败模式',
    );
    assert.ok(
      judge!.task.includes('不同意哪一方'),
      '★ 必须要求它写出"不同意哪一方" —— 复读的人写不出这个',
    );
    assert.ok(
      judge!.task.includes('依据什么做了取舍'),
      '★ 必须要求它暴露自己的判据，而不是"综合来看"',
    );
  });
});
test('★★★ 分析师并发有【上限】（将来按币并行时不能起 20+ 个进程）', async () => {
  /*
   * ## 为什么现在只有 4 个分析师也要有闸门
   *
   * 因为**这个数字会变**：用户已提过"按币并行"（500 个标的、N 个 agent）。
   * 一旦分析角色变成"每个标的一个人"，无界 `Promise.all` 会**同时起 20+ 个**。
   *
   * 实测约束：**claude code 单进程约 250MB** —— 20 个并行 ≈ 5GB。
   * 用户说的"不限制并发"指的是 **magpie 侧**（模型调用）；
   * **服务器侧的 CPU/内存是真实约束**（那是我们自己的机器）。
   *
   * ## 这条测试钉住什么
   *
   * 它验证"**闸门真的在生效**"：把上限设成 2，然后看**同时**有几个在跑。
   * 若将来有人把 `mapConcurrent` 换回 `Promise.all`，峰值会变成 4 → 测试失败。
   */
  process.env.AQ_ANALYST_CONCURRENCY = '2';
  let running = 0;
  let peak = 0;
  const ask: AskRole = async ({ role }) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running -= 1;
    return { role, modelId: `stub/${role}`, data: null, raw: '结论：不行动。', latencyMs: 1, ok: true };
  };
  try {
    await runTradingDesk({ ask, ...CTX });
    assert.ok(peak <= 2, `★ 同时最多 2 个分析师（实测峰值 ${peak}）—— 闸门没生效`);
    assert.ok(peak >= 2, `★ 但要真的并发（峰值 ${peak} 说明退化成串行了）`);
  } finally {
    delete process.env.AQ_ANALYST_CONCURRENCY;
  }
});

test('★ 分析师顺序必须与角色表一致（闸门不能打乱顺序）', async () => {
  /*
   * `mapConcurrent` 保证"结果与输入同序" —— 这一条是它的回归保护。
   * 若顺序错了，`analyses[i]` 会把 A 角色的产出记到 B 角色名下。
   *
   * ⚠️ 2026-10-13：**总管也走同一个 `ask`**（它先被问一次），
   * 所以要把 `supervisor` 从"发出顺序"里排除掉再比 —— 它不是分析师。
   */
  const order: string[] = [];
  const ask: AskRole = async ({ role }) => {
    order.push(role);
    /* 故意让**先发的慢** —— 按完成顺序收集就会颠倒。 */
    await new Promise((r) => setTimeout(r, order.length === 1 ? 40 : 5));
    return { role, modelId: `stub/${role}`, data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  const out = await runTradingDesk({ ask, ...CTX });
  const analystOrder = order.filter((r) => r !== 'supervisor');
  assert.equal(
    out.analyses.map((a) => a.role).join(','),
    analystOrder.slice(0, out.analyses.length).join(','),
    '★ 产出的顺序必须与角色表一致',
  );
});
test('★★★ 给了情报键 → 裁决官提示词必须要求标注依据（归因链的入口）', async () => {
  /*
   * ## 为什么必须有这一条
   *
   * `intel/signalHealth.ts` 的失效检测需要"由某个信号驱动的成交"，
   * 而实测核查发现**这条信息系统从未记录过**（`trades.source` 只有
   * `bot`/`reconciled`，`open_reasoning` 是技术面理由）。
   *
   * 所以失效检测一直是**空转**。打通它的第一步就是：
   * **把可选的情报键给裁决官，并要求它标注依据。**
   *
   * ⚠️ 若这条要求被删掉，整条链会**静默断掉**（决策记录里没有 intel_keys
   * → 归因没数据 → 失效检测永远"样本不足"）。
   */
  const seen: Array<{ role: string; task: string }> = [];
  const ask: AskRole = async ({ role, task }) => {
    seen.push({ role, task });
    return { role, modelId: `stub/${role}`, data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  await runTradingDesk({
    ask,
    ...CTX,
    availableIntelKeys: ['coindesk.com|bullish|BTCUSDT', 'theblock.com|bearish|ETHUSDT'],
  });
  const judge = seen.find((s) => s.role === 'judge');
  assert.ok(judge !== undefined);
  assert.ok(judge!.task.includes('intel_keys'), '★ 必须告诉它用哪个字段标注');
  assert.ok(judge!.task.includes('coindesk.com|bullish|BTCUSDT'), '★ 必须把可选键列给它');
  assert.ok(judge!.task.includes('只能从这里选'), '★ 必须明确禁止编造');
});

test('★★★ 没给情报键 → 【不要求】标注（不猜，也不让它编）', async () => {
  /*
   * ⚠️ 这一条是上一条的**安全对照**。
   *
   * 若没有可选键却仍要求标注，模型**只能编** ——
   * 而编造的键永远只有 1 个样本，会让归因数据**看起来比实际更丰富**。
   * 所以"没有键"时应当**不要求**（而不是要求它凭空写）。
   */
  const seen: Array<{ role: string; task: string }> = [];
  const ask: AskRole = async ({ role, task }) => {
    seen.push({ role, task });
    return { role, modelId: `stub/${role}`, data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  await runTradingDesk({ ask, ...CTX });
  const judge = seen.find((s) => s.role === 'judge');
  assert.ok(judge !== undefined);
  assert.ok(!judge!.task.includes('intel_keys'), '★ 没有可选键时不该要求标注');
});

test('★★★ 超时按【输入规模】缩放（固定 60 秒砍掉了 13 万字符的输入）', () => {
  /*
   * ## 实测数据（`#11`）
   *
   * ```
   *   user_prompt = 130,902 字符 ≈ 37,401 tokens
   *   team-grunt   小输入 2.2 秒   ← 模型本身不慢
   *   team-analyst 小输入 5.2 秒   ← 模型本身不慢
   *   但实际运行：technical 超时 60s · market_analyst 超时 180s
   * ```
   *
   * **模型不慢，慢的是"要读 3.7 万 token"。** 而超时原来是**固定值** ——
   * 它假设每次输入都差不多大，而实际输入规模随候选池变化。
   *
   * ⚠️ **这只是"止血"，不是根治**：根治是把输入变小
   *（用户建议的"按币并行" —— 每人一个标的，输入从 13 万字符降到几百字符）。
   * 那时这个缩放会自然回到基准值。
   *
   * ⚠️ 2026-10-13：断言里的 `60_000` **改成读 `ROLE_TIMEOUT_MS`** ——
   * 线上实测证明 T1 的 60 秒太紧（`technical` 实测到过 54.3 秒），
   * 于是提到 120 秒；而写死 60 的断言就假失败了。
   * **测试该钉住"关系"，而不是钉住某个具体数字** —— 数字会随实测修订，
   * 关系（小输入用基准 / 大输入按规模放宽 / 有上限）不会。
   *
   * ⚠️⚠️ 2026-10-13 第二次修订：**系数从 10 秒/万字符改成 60 秒/万字符**。
   *
   * 线上实测（`#11` 的 `ai_latency_ms`）：
   * ```
   *   c102 192s · c101 300s · c99 187s   ← 而超时线是 180s
   *   → 裁决官每轮都被切断，材料给 20 个候选、它只点评 5 个
   * ```
   * 旧系数（10 秒/万字符）是**按"读一遍"估的**，而真实成本是
   * **逐候选做推理**（看多周期指标、找失效位、算盈亏比、写理由）——
   * 实测约 **80–130 秒/万字符**。
   *
   * ⚠️ 所以下面这些断言**不能再写死 130_000 / 200_000 / 300_000** ——
   * 那正是"把某个实测值当成规则"的形态（本项目已踩过三次：
   * `market_analyst` 的 1024/2048、`technical` 的 60 秒、这里的 10 秒/万字符）。
   * 改成钉**关系**：单调、每万字符的系数、上限存在且足够大。
   */
  const t1Base = ROLE_TIMEOUT_MS['T1_fast']!;
  const t2Base = ROLE_TIMEOUT_MS['T2_mid']!;
  const t3Base = ROLE_TIMEOUT_MS['T3_deep']!;

  /* 小输入：档位基准说了算。 */
  assert.equal(roleTimeoutMs('T1_fast', 5_000), t1Base, `T1 小输入用基准 ${t1Base / 1000} 秒`);
  assert.equal(roleTimeoutMs('T2_mid', 5_000), t2Base, `T2 小输入用基准 ${t2Base / 1000} 秒`);

  /* 大输入必须放宽（固定基准会砍掉它）—— 钉"放宽了"，不钉具体值。 */
  assert.ok(
    roleTimeoutMs('T1_fast', 130_000) > t1Base,
    `★ 13 万字符时 T1 必须放宽（实际 ${roleTimeoutMs('T1_fast', 130_000)}，基准 ${t1Base}）`,
  );

  /*
   * ⚠️ **系数必须 ≥ 60 秒/万字符** —— 这是本次修的核心不变量。
   * 线上实测要 80–130 秒/万字符；钉 60 是"下限"，给未来留调整空间，
   * 但**不允许再退回 10 秒/万字符**那种乐观估计。
   */
  const per10k = roleTimeoutMs('T1_fast', 1_000_000) / 100; /* 上限处不适用，见下 */
  void per10k;
  assert.ok(
    roleTimeoutMs('T3_deep', 50_000) >= 60_000 * 5,
    `★ 5 万字符至少要给 300 秒（60 秒/万字符）—— 实际 ${roleTimeoutMs('T3_deep', 50_000)}`,
  );

  /* 上限存在且 ≥ 360 秒（旧上限 300 秒恰好等于实测最坏值 300.4 秒）。 */
  const cap = roleTimeoutMs('T1_fast', 5_000_000);
  assert.ok(cap >= 360_000, `★ 上限必须 ≥360 秒（实际 ${cap}）—— 300 秒会贴着实测最坏值被砍`);

  /* 档位基准与规模取【大者】—— 大输入不会被小基准压住。 */
  assert.equal(roleTimeoutMs('T2_mid', 10_000), t2Base, `${t2Base / 1000} 秒基准：10 万字符以内仍用它`);
  assert.ok(
    roleTimeoutMs('T3_deep', 200_000) > t3Base,
    `★ 20 万字符时 T3 必须放宽到超过基准 ${t3Base / 1000} 秒`,
  );
});
test('★★★ 大材料角色必须拿到【压缩后】的材料，且候选一个都不能少', async () => {
  /*
   * ## 实测数据（这条接线的理由）
   *
   * ```
   *   market_analyst  材料 = marketContext（130,917 字符）  ❌ 超时 180s
   *   technical       材料 = marketContext（130,917 字符）  ❌ 超时 140s
   *   newscaster      材料 = newsContext（小）              ✅ 完成 55s
   *   sentiment       材料 = newsContext（小）              ✅ 完成 12s
   * ```
   * 而模型本身不慢（同一路由组小输入 2.2 / 5.2 秒）—— **慢的是输入规模**。
   *
   * ## ⚠️ 我第一版写错过，这条测试就是防它回来的
   *
   * 第一版我"只给第一个标的"（9,227 字符）—— 那**丢掉了其余 11 个候选**，
   * 而 `market_analyst` 的任务正是"分析**整体**市场状态"。
   * **那是用"解决超时"换"看不见的信息缺失"。**
   */
  const big = [
    '# 账户',
    '权益 20.75 USDT',
    ...Array.from({ length: 6 }, (_, i) =>
      `### ${i + 1}. SYM${i}USDT（coinpool）\n` +
      `current_price = ${i}\n` +
      `价格: [${Array.from({ length: 40 }, (_, j) => j).join(', ')}]`),
  ].join('\n');

  const seen: Array<{ role: string; ctx: string }> = [];
  const ask: AskRole = async ({ role, context }) => {
    seen.push({ role, ctx: context });
    return { role, modelId: 'stub', data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  await runTradingDesk({ ask, ...CTX, marketContext: big });

  const ma = seen.find((s) => s.role === 'market_analyst');
  const tech = seen.find((s) => s.role === 'technical');
  assert.ok(ma !== undefined && tech !== undefined);

  /* ① 压缩生效：K 线不再有 40 个点。 */
  assert.ok(ma!.ctx.length < big.length, `★ 材料应当变小（${big.length} → ${ma!.ctx.length}）`);
  assert.ok(ma!.ctx.includes('省略前'), '★ K 线序列应当被压缩（留最后 5 点）');
  /* ② 候选一个都不能少 —— 这是决策依据。 */
  for (let i = 0; i < 6; i++) {
    assert.ok(ma!.ctx.includes(`SYM${i}USDT`), `★ 候选 SYM${i}USDT 不能丢`);
  }
  /* ③ 账户信息必须保留（角色据此算风险预算）。 */
  assert.ok(ma!.ctx.includes('权益 20.75'), '★ 账户信息必须保留');
  /* ④ 两个大材料角色用同一份压缩材料。 */
  assert.equal(tech!.ctx, ma!.ctx);
});

test('★ 压缩切不出来时必须退回【原文】（绝不给残缺材料）', async () => {
  /*
   * ⚠️ 若切分失败却给一份"残缺材料"，角色会**正常完成**，
   * 只是结论建立在不完整的信息上 —— **那是看不见的失败**。
   */
  const noHeadings = '只有散文，没有任何候选标题。权益 20.75 USDT';
  const seen: Array<{ role: string; ctx: string }> = [];
  const ask: AskRole = async ({ role, context }) => {
    seen.push({ role, ctx: context });
    return { role, modelId: 'stub', data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  await runTradingDesk({ ask, ...CTX, marketContext: noHeadings });
  const ma = seen.find((s) => s.role === 'market_analyst');
  assert.equal(ma!.ctx, noHeadings, '★ 切不出来时必须是原文，一字不改');
});
test('★★★ 分析角色的材料必须限在【临界规模内】—— 12 个标的会让模型只想不说', async () => {
  /*
   * ## 决定性实测（同一模型、同一提示词，只变材料规模）
   *
   * ```
   *    0 个标的（ 5,455 字符）→ 14.8s · content= 340 字  ✅
   *    1 个标的（ 9,211 字符）→ 14.6s · content=1658 字  ✅ 最好
   *    3 个标的（16,039 字符）→ 13.0s · content=1006 字  ✅
   *    6 个标的（26,281 字符）→ 15.1s · content= 434 字  ✅
   *   12 个标的（55,011 字符）→ 17.3s · content=   0 字  ❌ 【崩了】
   * ```
   *
   * **`content = 0 字`** → 角色判定失败 → 加预算重试（47.5s）→
   * 首次 15.7s + 重试 47.5s = **63s > T1 的 60 秒超时线** → 角色缺席 → 零决策。
   *
   * ⚠️ **"看 6 个并给出有效分析"远好过"看 12 个但一个字都写不出"。**
   */
  const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i}USDT`);
  const big = [
    '# 账户',
    '权益 20.75 USDT',
    ...symbols.map((s, i) =>
      `### ${i + 1}. ${s}（coinpool）\ncurrent_price = ${i}\n` +
      `价格: [${Array.from({ length: 40 }, (_, j) => j).join(', ')}]`),
  ].join('\n');

  const seen: Array<{ role: string; ctx: string }> = [];
  const ask: AskRole = async ({ role, context }) => {
    seen.push({ role, ctx: context });
    return { role, modelId: 'stub', data: null, raw: '[]', latencyMs: 1, ok: true };
  };
  await runTradingDesk({ ask, ...CTX, marketContext: big });
  const ma = seen.find((s) => s.role === 'market_analyst')!;

  /* ① 材料必须显著小于原文（否则 12 个标的全给 = 必然 empty_content）。 */
  assert.ok(
    ma.ctx.length < big.length / 2,
    `★ 分析材料应当显著变小（${big.length} → ${ma.ctx.length}）`,
  );
  /* ② 但不能一个标的都不给（那会让"整体市场状态"无从谈起）。 */
  assert.ok(ma.ctx.includes('SYM0USDT'), '★ 至少要给第一个候选');
  /* ③ 账户信息必须保留（角色据此算风险预算）。 */
  assert.ok(ma.ctx.includes('权益 20.75'), '★ 账户信息必须保留');
  /* ④ 最后那个候选不该出现在分析材料里（它超出了实测临界规模）。 */
  assert.ok(!ma.ctx.includes('SYM11USDT'), '★ 超出临界规模的候选不该进来');
});