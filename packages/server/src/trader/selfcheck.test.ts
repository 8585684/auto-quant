/**
 * 自检的测试。
 *
 * ## 为什么这里要测得细
 *
 * 用户需求 #6 的原话：
 * > 「**不要有任何 BUG，也不要老让我来测试和发现问题，你要自己发现问题自己解决**」
 *
 * 自检就是那个"自己发现"的机制。而它的失败模式**恰好是它要防的东西**：
 *
 *   · **漏报** → 用户又得自己发现问题（等于自检没做）；
 *   · **误报** → 用户被噪音淹没，然后开始忽略自检（比漏报更糟）；
 *   · **静默无输出** → "自检跑了但没问题"与"自检根本没跑"长得一样。
 *
 * 三种都在下面被钉住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findDeterministicProblems,
  parseAiFindings,
  renderEvidenceForModel,
  type SelfCheckEvidence,
} from './selfcheck.js';

/** 一份"一切正常"的基线证据。 */
function healthy(over: Partial<SelfCheckEvidence> = {}): SelfCheckEvidence {
  return {
    windowHours: 6,
    status: 'running',
    failedCycles: [],
    errorLogsByScope: [],
    warnLogsByScope: [],
    consecutiveFailures: 0,
    minutesSinceLastSuccess: 5,
    cycleIntervalMinutes: 15,
    pendingExperiments: 0,
    totalRuns: 100,
    openPositions: 0,
    nakedPositions: [],
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  确定性发现                                                                */
/* -------------------------------------------------------------------------- */

test('★★ 一切正常时【也要给一条 info】—— 否则"没发现"与"没跑"分不清', () => {
  /*
   * 静默返回空数组是本项目反复踩的"看不出异常的失败"：
   * 操作员（和我）无法区分"自检跑了且健康"与"自检根本没跑"。
   */
  const findings = findDeterministicProblems(healthy());
  assert.equal(findings.length, 1, '健康时恰好一条');
  assert.equal(findings[0]!.severity, 'info');
  assert.ok(findings[0]!.title.includes('未发现'), '要说清是"未发现"而不是沉默');
});

test('★★ 连续失败 ≥3 次 → critical（决策循环已熔断）', () => {
  const findings = findDeterministicProblems(
    healthy({
      consecutiveFailures: 3,
      failedCycles: [{ cycleNumber: 42, error: 'AI 服务不可用', at: '2026-10-12T00:00:00Z' }],
    }),
  );
  const crit = findings.find((f) => f.severity === 'critical');
  assert.ok(crit, '★ 连续失败必须是 critical');
  assert.ok(crit!.title.includes('3'), '标题要带具体次数');
  assert.ok(crit!.detail.includes('AI 服务不可用'), '证据里要有真实错误');
});

test('★ 失败 2 次不算 critical（阈值 3，避免噪音）', () => {
  const findings = findDeterministicProblems(healthy({ consecutiveFailures: 2 }));
  assert.equal(findings.filter((f) => f.severity === 'critical').length, 0);
});

test('★★ 长时间没成功按【周期倍数】判断，而不是写死分钟数', () => {
  /*
   * ⚠️ 这条是本模块最容易写错的地方。
   *
   * 周期本身可以由 AI 调整（1–120 分钟）。如果写死"超过 30 分钟算异常"，
   * 那么一个把周期设成 60 分钟的机器人会**每轮都被误报** ——
   * 而误报比漏报更糟（用户开始忽略自检）。
   *
   * 所以判据是"距上次成功 / 配置周期"。
   */
  /* 周期 60 分钟、距上次 100 分钟（1.7 倍）→ 不该 critical。 */
  const slowButFine = findDeterministicProblems(
    healthy({ cycleIntervalMinutes: 60, minutesSinceLastSuccess: 100 }),
  );
  assert.equal(
    slowButFine.filter((f) => f.severity === 'critical').length,
    0,
    '★ 长周期机器人 1.7 倍不该被判 critical（那是误报）',
  );

  /* 周期 15 分钟、距上次 100 分钟（6.7 倍）→ 该 critical。 */
  const stuck = findDeterministicProblems(
    healthy({ cycleIntervalMinutes: 15, minutesSinceLastSuccess: 100 }),
  );
  assert.ok(
    stuck.some((f) => f.severity === 'critical'),
    '★ 短周期机器人 6.7 倍没成功必须报',
  );
});

test('★ 从未成功过 + 有失败 → 提示"一出生就坏"（配置问题）', () => {
  const findings = findDeterministicProblems(
    healthy({
      minutesSinceLastSuccess: null,
      totalRuns: 0,
      failedCycles: [{ cycleNumber: 1, error: '配置里没有任何候选标的', at: '2026-10-12T00:00:00Z' }],
    }),
  );
  const f = findings.find((x) => x.title.includes('从来没有成功'));
  assert.ok(f, '★ 要报这个形状');
  assert.ok(f!.nextStep.includes('配置'), '★ 下一步要指向配置（这类问题的真因通常在配置）');
});

test('★ 同一来源的错误日志只报一条（按 scope 归类，不刷屏）', () => {
  /*
   * 一个坏掉的连接可能刷出几百条错误。逐条报会把自检变成噪音源 ——
   * 而那正是"用户开始忽略自检"的起点。
   */
  const findings = findDeterministicProblems(
    healthy({
      errorLogsByScope: [{ scope: 'binance:userdata', count: 137, sample: '连接已断开' }],
    }),
  );
  const byScope = findings.filter((f) => f.title.includes('binance:userdata'));
  assert.equal(byScope.length, 1, '★ 同一个 scope 只报一条');
  assert.ok(byScope[0]!.title.includes('137'), '但要带完整计数');
});

test('★ 单条错误日志不报（避免噪音）', () => {
  const findings = findDeterministicProblems(
    healthy({ errorLogsByScope: [{ scope: 'x', count: 1, sample: '偶发' }] }),
  );
  assert.equal(findings.filter((f) => f.title.includes('x 有')).length, 0);
});

test('★ 参数实验长期不结算 → 提示"自我迭代卡住了"', () => {
  /*
   * 对应"AI 自我迭代"那一环（用户需求 #F）：改了参数却不知道有没有用。
   */
  const findings = findDeterministicProblems(healthy({ pendingExperiments: 7 }));
  const f = findings.find((x) => x.title.includes('参数实验'));
  assert.ok(f, '★ 要报出来');
  assert.ok(f!.detail.includes('有没有用'), '要说清后果');
});

test('★ 每条发现都必须有"下一步查什么"（用户要"快速定位"）', () => {
  const findings = findDeterministicProblems(
    healthy({
      consecutiveFailures: 5,
      pendingExperiments: 9,
      errorLogsByScope: [{ scope: 'team', count: 4, sample: 'x' }],
      minutesSinceLastSuccess: 200,
    }),
  );
  assert.ok(findings.length >= 3, '这份证据该有多条发现');
  for (const f of findings) {
    assert.ok(f.nextStep.length > 0, `★ 发现「${f.title}」没有下一步指引`);
    assert.ok(f.detail.length > 0, `★ 发现「${f.title}」没有证据`);
  }
});

/* -------------------------------------------------------------------------- */
/*  给模型的材料                                                              */
/* -------------------------------------------------------------------------- */

test('★ 材料里要有"看起来正常"的数字（模型需要基线才能判断多寡）', () => {
  const text = renderEvidenceForModel(healthy());
  assert.ok(text.includes('失败轮次：0'), '要给出基线');
  assert.ok(text.includes('配置周期：15 分钟'), '要给出周期（判断是否异常的基准）');
  assert.ok(text.includes('没有错误级日志'), '空也要说明');
});

test('★ 材料里【不给结论】—— 结论让模型自己下', () => {
  /*
   * 把结论塞进材料等于"我把答案告诉它"，那不算自检。
   * 材料只给事实。
   */
  const text = renderEvidenceForModel(healthy({ consecutiveFailures: 5 }));
  assert.ok(!text.includes('critical'), '材料里不该有严重度标签');
  assert.ok(!text.includes('建议'), '材料里不该有建议');
});

/* -------------------------------------------------------------------------- */
/*  AI 输出解析                                                               */
/* -------------------------------------------------------------------------- */

test('★ 解析模型的发现（`[严重度] 标题 :: 证据 :: 下一步`）', () => {
  const { findings } = parseAiFindings(
    '- [critical] 模型降级频繁 :: 首选额度可能耗尽 :: 查 /v1/magpie/quotas\n' +
      '- [warning] 新闻材料为空 :: 搜索端点返回 401 :: 检查 MAGPIE_GATEWAY_KEY',
  );
  assert.equal(findings.length, 2);
  assert.equal(findings[0]!.severity, 'critical');
  assert.ok(findings[0]!.title.includes('降级'));
  assert.ok(findings[0]!.nextStep.includes('quotas'));
  assert.equal(findings[1]!.severity, 'warning');
});

test('★ 中文严重度标签也能识别', () => {
  const { findings } = parseAiFindings('- [严重] 数据断流 :: 行情 30 分钟没更新 :: 查行情连接');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'critical');
});

test('★★ 解析不出来时【不编造发现】，但保留原文', () => {
  /*
   * 自检的输出是**给人看的报告**（不是要执行的动作），所以容错口径与风控官不同：
   *   · 不编造（返回空数组）；
   *   · 但**保留原文** —— 用户要"下次唤醒时快速定位"，
   *     一段没解析成功的原文仍然比"什么都没有"有用得多。
   */
  const { findings, raw } = parseAiFindings('我看了看，感觉还行吧。');
  assert.equal(findings.length, 0, '★ 不能编造');
  assert.ok(raw.includes('还行'), '★ 原文要保留');
});

test('★ 解析结果有长度上限（防止把整篇塞进数据库）', () => {
  const long = '- [info] ' + 'x'.repeat(2000) + ' :: ' + 'y'.repeat(2000);
  const { findings } = parseAiFindings(long);
  assert.ok((findings[0]?.title.length ?? 0) <= 200, '标题要截断');
  assert.ok((findings[0]?.detail.length ?? 0) <= 600, '证据要截断');
});

test('★★ 停止的机器人【不能】被报"卡住"（生产实测的误报）', () => {
  /*
   * ## 这是真实发生的误报
   *
   * 2026-10-12 首次在生产上跑自检，输出是：
   *
   * ```
   *   #9（已停止）: [critical] 已 12873 分钟没有成功决策（643.7 个周期）
   *   #11（已停止）: [critical] 已 70 分钟没有成功决策（4.7 个周期）
   * ```
   *
   * **停止的机器人当然不会成功决策** —— 那不是故障，是操作员把它关了。
   * 而这条误报恰好落在最显眼的 critical 上。
   *
   * 判据本身没错（"几个周期没成功 = 卡住"），错在**没先看前提**。
   * 这正是本模块注释里写的风险："误报比漏报更糟 —— 用户开始忽略自检"。
   */
  const findings = findDeterministicProblems(
    healthy({
      status: 'stopped',
      cycleIntervalMinutes: 15,
      minutesSinceLastSuccess: 12_873,
    }),
  );
  assert.equal(
    findings.filter((f) => f.severity === 'critical').length,
    0,
    '★ 停止的机器人不该报 critical',
  );
  assert.ok(
    findings.some((f) => f.title.includes('stopped')),
    '★ 但要说明"因为不在运行所以不检查"—— 沉默会让人以为检查过了',
  );
});

test('★ 运行中的机器人照常检查（修复不能把真问题一起挡掉）', () => {
  const findings = findDeterministicProblems(
    healthy({ status: 'running', cycleIntervalMinutes: 15, minutesSinceLastSuccess: 200 }),
  );
  assert.ok(
    findings.some((f) => f.severity === 'critical' && f.title.includes('没有成功决策')),
    '★ 运行中的机器人卡住必须报',
  );
});
/* -------------------------------------------------------------------------- */
/*  裸奔仓位（唯一会直接亏钱的一项）                                             */
/* -------------------------------------------------------------------------- */

test('★★★ 有裸奔仓位 → critical，且**排在最前面**', () => {
  /*
   * 杠杆仓位没有保护单意味着：价格反向走时**没有任何自动止损** ——
   * 亏损上限是"爆仓"而不是"止损价"。
   *
   * 它必须排在最前面，因为自检的输出是给人看的，而人从第一条开始读。
   */
  const findings = findDeterministicProblems(
    healthy({
      openPositions: 2,
      nakedPositions: [{ symbol: 'BTCUSDT', side: 'long', quantity: 0.5 }],
      /* 同时有别的严重问题，验证排序。 */
      consecutiveFailures: 5,
    }),
  );
  assert.equal(findings[0]!.severity, 'critical');
  assert.ok(findings[0]!.title.includes('裸奔'), `★ 第一条应当是裸奔，实际是「${findings[0]!.title}」`);
  assert.ok(findings[0]!.detail.includes('BTCUSDT'), '证据里要有具体标的');
});

test('★★ 裸奔检查不能漏 —— 这是持续观察的核心价值', () => {
  /*
   * 这个状态**只会在特定窗口里出现**（部署打断在途轮次、保护单被撤/过期、
   * 手动开的仓），正常运行时界面上"看起来正常"。
   *
   * 2026-10-12 我是**人工**去查的（#10 两个持仓都有保护）。
   * 人工查一次不算"持续观察" —— 而用户要的正是持续观察。
   */
  const findings = findDeterministicProblems(
    healthy({ openPositions: 3, nakedPositions: [{ symbol: 'X', side: 'short', quantity: 1 }] }),
  );
  assert.ok(findings.some((f) => f.severity === 'critical' && f.title.includes('裸奔')));
});

test('★ 没有裸奔仓位时不报这一条（避免噪音）', () => {
  const findings = findDeterministicProblems(healthy({ openPositions: 5, nakedPositions: [] }));
  assert.equal(findings.filter((f) => f.title.includes('裸奔')).length, 0);
});

test('★ 多个裸奔仓位只报一条，但列出具体标的（不刷屏）', () => {
  const findings = findDeterministicProblems(
    healthy({
      openPositions: 3,
      nakedPositions: [
        { symbol: 'AUSDT', side: 'long', quantity: 1 },
        { symbol: 'BUSDT', side: 'long', quantity: 2 },
        { symbol: 'CUSDT', side: 'short', quantity: 3 },
      ],
    }),
  );
  const naked = findings.filter((f) => f.title.includes('裸奔'));
  assert.equal(naked.length, 1, '★ 只报一条');
  assert.ok(naked[0]!.title.includes('3'), '标题要带总数');
  assert.ok(naked[0]!.detail.includes('AUSDT') && naked[0]!.detail.includes('CUSDT'), '证据要列出标的');
});

test('★ 材料里要写明持仓保护状况（AI 层也需要这个事实）', () => {
  const text = renderEvidenceForModel(
    healthy({ openPositions: 2, nakedPositions: [{ symbol: 'ZECUSDT', side: 'short', quantity: 0.07 }] }),
  );
  assert.ok(text.includes('持仓保护'), '要有这一节');
  assert.ok(text.includes('没有保护单'), '要标出问题');
  assert.ok(text.includes('ZECUSDT'), '要列出具体标的');
});