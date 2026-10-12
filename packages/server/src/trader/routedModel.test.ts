/**
 * 角色路由器与网关工厂的测试。
 *
 * 重点钉住用户的两条要求：
 *   ① 「万一 claude 额度不足了，系统能智能把主管模型换成向下平替，保证系统不中断」
 *   ② 「各个 AI 要有一定容错、纠正机制……这个模式里面的一切都可以让 AI 来自我迭代升级」
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { readFileSync } from 'node:fs';
import { ROLE_TIERS, ROLE_GROUP_LADDERS, createRoutedDecisionModel, tierForRole } from './routedModel.js';
import { looksLikeMagpieGateway } from './magpieGateway.js';
import { FIRM_ROLES, firmRoleOf } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  角色 → 档位映射（"每个智能体用什么模型"的机器表达）                          */
/* -------------------------------------------------------------------------- */

test('★ 体力活角色用便宜档、判断类角色用强档（成本与能力匹配）', () => {
  /*
   * 用户原话：「高智能的模型做什么，低智能的做哪些体力活（例如查资料，整理、重复性工作）」。
   * 分档错了的后果很实际：用 T3 跑打标 = 花 15 倍 token 做不需要智商的事。
   */
  assert.equal(tierForRole('supervisor'), 'T3_deep', '调度官要统筹，必须最强');
  assert.equal(tierForRole('judge'), 'T3_deep', '裁决要强');
  assert.equal(tierForRole('newscaster'), 'T1_fast', '★ 查新闻/打标是体力活，不该用旗舰');
  assert.equal(tierForRole('sentiment'), 'T1_fast');
  assert.equal(tierForRole('execution'), 'T0_code', '★ 执行绝不用 LLM');
  assert.equal(tierForRole('data_sentinel'), 'T0_code', '数据哨兵是纯代码');
});

test('未知角色保守给 T2（宁可稍贵，也不要让新角色没模型可用）', () => {
  assert.equal(tierForRole('some-brand-new-role'), 'T2_mid');
});

test('★ 每个角色都登记了档位（加角色时不能忘）', () => {
  /*
   * 这条防的是"加了角色但忘了登记" —— 那种角色会静默走 T2 默认值，
   * 而它可能本该是 T3（裁决）或 T0（不该用 LLM）。
   */
  const expected = [
    'supervisor', 'judge', 'bull', 'bear', 'portfolio_manager', 'red_team',
    'market_analyst', 'onchain_analyst', 'memory_curator', 'risk_officer',
    'newscaster', 'sentiment', 'technical', 'reporter', 'clerk',
    'data_sentinel', 'execution', 'ops_watchdog',
  ];
  for (const role of expected) {
    assert.ok(ROLE_TIERS[role], `角色 ${role} 没有登记档位`);
  }
});

/* -------------------------------------------------------------------------- */
/*  路由 DecisionModel：降级 + 可观测                                          */
/* -------------------------------------------------------------------------- */

/** 造一个按"模型名前缀"决定行为的桩。 */
function stubFactory(behavior: (modelId: string) => 'ok' | 'quota' | 'empty'): CallModel {
  return async (modelId) => {
    const kind = behavior(modelId);
    if (kind === 'quota') {
      const err = new Error('You have insufficient credits to make this request.') as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    if (kind === 'empty') return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } };
    return { text: `来自 ${modelId}`, latencyMs: 10, usage: { promptTokens: 1, completionTokens: 1 } };
  };
}

test('★★ 核心：首选额度尽 → 自动降级，且【每一次尝试都被报告】', async () => {
  /*
   * 用户要求两件事同时成立：
   *   ① 系统不中断（降级成功）
   *   ② 看得见发生了什么（"降级了几次、为什么"必须能观测）
   */
  const seen: Array<{ role: string; modelId: string; ok: boolean; note: string }> = [];
  let call = 0;
  const router = new ModelRouter({
    call: async (modelId, messages, options) => {
      call += 1;
      /* 第一次失败（额度尽），之后成功 */
      if (call === 1) {
        const err = new Error('endpoint is unavailable') as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return { text: '平替成功', latencyMs: 10, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });

  const model = createRoutedDecisionModel({
    router,
    request: { role: 'judge', tier: 'T3_deep' },
    baseMaxTokens: 4096,
    onAttempt: (info) => seen.push(info),
  });

  const result = await model.complete('系统提示', '用户提示', {});
  assert.equal(result.text, '平替成功', '★ 系统不能因为首选额度尽就停摆');
  assert.equal(seen.length, 2, '★ 两次尝试都要被报告（失败的 + 成功的）');
  assert.equal(seen[0]!.ok, false, '★ 第一次失败必须可见');
  assert.equal(seen[0]!.role, 'judge', '报告里要带角色 —— 多智能体下"谁失败了"是关键信息');
  assert.equal(seen[1]!.ok, true);
  assert.ok(seen[0]!.note.length > 0, '★ 失败原因要能读（不能只是一个 ok:false）');
});

test('★ 空内容会重试（不是立刻判失败）', async () => {
  let call = 0;
  const router = new ModelRouter({
    call: async () => {
      call += 1;
      return call === 1
        ? { text: '  ', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } }
        : { text: '第二次有内容', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'clerk', tier: 'T1_fast' }, baseMaxTokens: 512 });
  const r = await model.complete('s', 'u', {});
  assert.equal(r.text, '第二次有内容');
});

test('usage 三个字段一路带到适配层（缓存/思考 token 不能在最后一跳丢）', async () => {
  /*
   * 项目里踩过这个坑：适配层漏掉 cachedTokens，前面所有工作白做，
   * 界面上"缓存命中率"永远显示不出来。
   */
  const router = new ModelRouter({
    call: async () => ({
      text: 'ok', latencyMs: 7,
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 86, reasoningTokens: 12 },
    }),
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'bull', tier: 'T3_deep' }, baseMaxTokens: 1024 });
  const r = await model.complete('s', 'u', {});
  assert.equal(r.usage.cachedTokens, 86, '★ 缓存 token 必须带出来');
  assert.equal(r.usage.reasoningTokens, 12, '★ 思考 token 必须带出来');
  assert.equal(r.usage.promptTokens, 100);
});

test('中止信号一路透传到路由器', async () => {
  let gotSignal: AbortSignal | undefined;
  const router = new ModelRouter({
    call: async (_m, _msg, options) => {
      gotSignal = options.signal;
      return { text: 'ok', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'bear', tier: 'T3_deep' }, baseMaxTokens: 512 });
  const ac = new AbortController();
  await model.complete('s', 'u', { signal: ac.signal });
  assert.equal(gotSignal, ac.signal, '★ 停止时必须能掐断在途请求');
});

/* -------------------------------------------------------------------------- */
/*  magpie 网关识别                                                            */
/* -------------------------------------------------------------------------- */

test('★ 能识别 magpie 网关（判据是 baseUrl，不需要用户多勾一个开关）', () => {
  assert.equal(looksLikeMagpieGateway('http://127.0.0.1:3425/v1'), true);
  assert.equal(looksLikeMagpieGateway('http://172.19.0.1:3425/v1'), true);
  assert.equal(looksLikeMagpieGateway('http://127.0.0.1:3425/mcp/magpie/web-search'), true);
  assert.equal(looksLikeMagpieGateway('https://api.deepseek.com'), false);
  assert.equal(looksLikeMagpieGateway(''), false);
});

/* -------------------------------------------------------------------------- */
/*  组织架构与路由表的一致性（防"看不见的角色"）                                 */
/* -------------------------------------------------------------------------- */

test('★★ 路由表里的每个角色都必须在组织架构里有定义（否则界面上看不见它）', () => {
  /*
   * ## 为什么这条测试重要
   *
   * 两张表分别在两个包里：
   *   · `ROLE_TIERS`（本包）—— 决定"每个角色用哪个档位的模型"；
   *   · `FIRM_ROLES`（`@aq/shared`）—— 决定"界面上有哪些角色、各自负责什么"。
   *
   * 服务端加了新角色、界面不显示 → **操作员看不见有人在干活**。
   * 那正是用户反复要求的"看得见系统在做什么"的反面，而且很难被发现
   * （毕竟系统功能是好的，只是没显示）。
   */
  const missing = Object.keys(ROLE_TIERS).filter((id) => firmRoleOf(id) === undefined);
  assert.deepEqual(missing, [], `★ 这些角色在路由表里但组织架构里没有：${missing.join(', ')}`);
});

test('★ 组织架构里标 `staffed` 的角色都应当在路由表里有档位', () => {
  /*
   * 反方向的漂移：界面上写着"在岗"，而路由表不知道该给它什么档位 ——
   * 那会让 `tierForRole()` 回退到 T2（能跑，但"在岗"是虚的）。
   */
  const unrouteable = FIRM_ROLES
    .filter((r) => r.status === 'staffed')
    .filter((r) => !(r.id in ROLE_TIERS))
    .map((r) => r.id);
  assert.deepEqual(unrouteable, [], `★ 这些角色标了在岗但路由表里没有：${unrouteable.join(', ')}`);
});

test('★ 组织架构的每个角色都有中文名与职责说明（界面要显示）', () => {
  for (const r of FIRM_ROLES) {
    assert.ok(r.label.length > 0, `★ 角色 ${r.id} 没有中文名`);
    assert.ok(r.duty.length > 8, `★ 角色 ${r.id} 的职责说明太短（界面要显示"它在做什么"）`);
  }
});

test('★ 组织架构里没有重复的角色 id', () => {
  const ids = FIRM_ROLES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '有重复的角色 id');
});
test('★★★ 关键角色必须绑定到【按工种建的路由组】（否则走发现层自动排序会撞上慢模型）', () => {
  /*
   * ## 为什么必须钉住
   *
   * 用户建议过「按工种建 magpie 路由组，绑定给对应的智能体」，
   * 而我在第 43 轮**建了 4 个组却一直没接线**。不接线的后果实测（`#2447`）：
   *
   * ```
   *   market_analyst（T2 档）→ 发现层自动排的 group/auto-hy3（思维链模型）
   *   → 耗时 39s / 121s / >180s 剧烈波动 → 超时失败
   *   → 它是"判断有没有机会"的核心角色 → 裁决官无依据 → 【零决策】
   * ```
   *
   * 而 `team-analyst` 是我按"分析"挑的 3 个模型（优选→兜底），
   * **不含思维链模型** —— 那正是为了避开这种耗时波动。
   */
  assert.ok(
    ROLE_GROUP_LADDERS['market_analyst']?.includes('group/team-analyst'),
    '★ market_analyst 必须绑 team-analyst（它是唯一 T2 分析角色，实测撞慢模型会超时）',
  );
  for (const role of ['technical', 'newscaster', 'sentiment']) {
    assert.ok(
      ROLE_GROUP_LADDERS[role]?.includes('group/team-grunt'),
      `★ ${role} 是体力活，应当绑 team-grunt（要快 + 免费）`,
    );
  }
});

test('★ 路由组映射只列【验证过的】角色（不能一次全换）', () => {
  /*
   * ⚠️ 一次把所有角色都绑到组上会让我**分不清"哪一处改动导致了什么"**。
   * 所以只列验证过的；其余保持发现层自动排序。
   */
  const bound = Object.keys(ROLE_GROUP_LADDERS);
  assert.ok(bound.length <= 6, `★ 绑定的角色应当克制（当前 ${bound.length} 个：${bound.join(',')}）`);
  /* 辩论/裁决（T3）暂时不绑 —— 还没验证过 team-judge 的实际表现。 */
  for (const t3 of ['judge', 'bull', 'bear']) {
    assert.equal(ROLE_GROUP_LADDERS[t3], undefined, `★ ${t3} 暂不绑定（未验证 team-judge）`);
  }
});

test('★ 可以用环境变量关掉（出问题能立刻回到旧行为）', () => {
  /*
   * `AQ_ROLE_GROUPS=off` 时 `ask()` 不传 ladder → 回到发现层排序。
   * 这条是**运维安全阀**：若路由组引入了新问题，不必改代码就能回退。
   *
   * ⚠️ 这里只能断言"这个开关的名字在源码里" ——
   * 真正验证它需要构造完整调用链（见 `routedModel.ts` 里那行三元）。
   */
  const src = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("AQ_ROLE_GROUPS"), '★ 必须有这个开关');
  assert.ok(src.includes("=== 'off'"), '★ 且 off 时真的不传 ladder');
});
test('★★★ T1 的候选链必须【多于一个组】—— 单组一次 5xx 就让整档不可用', () => {
  /*
   * ## 实测踩到（2026-10-12）
   *
   * 我第一版只写 `['group/team-grunt']`，于是线上出现：
   * ```
   *   technical：失败：档位 T1_fast 的候选链全部处于冷却期（1 个模型）
   *             —— group/team-grunt(上游 5xx，先重试一次，仍失败则换)
   * ```
   * **三个 T1 角色共用这一个组** → 一次 5xx → **三个同时不可用**。
   *
   * ## 为什么"组内还有 3 个模型"救不了
   *
   * 组是**网关侧的一个入口**：网关返回 5xx 时，路由器看到的是
   * "**这个候选失败了**"，它**不知道组内还有别的**，于是把整组标成冷却。
   *
   * ## 所以链上必须多挂几个组
   *
   * 它们分属不同供应商组合，**同时挂掉的概率远低于单个组**。
   */
  for (const role of ['technical', 'newscaster', 'sentiment', 'market_analyst']) {
    const chain = ROLE_GROUP_LADDERS[role];
    assert.ok(chain !== undefined, `★ ${role} 应当绑了路由组`);
    assert.ok(
      chain!.length >= 2,
      `★ ${role} 的链必须 ≥2 个组（当前 ${chain!.length}：${chain!.join(' → ')}）—— ` +
        '单组一次 5xx 就会让整个档位不可用',
    );
    /* 顺序有意义：最快的排第一。 */
    assert.equal(chain![0], role === 'market_analyst' ? 'group/team-analyst' : 'group/team-grunt');
  }
});

test('★ 兜底链里不能有重复项（重复 = 白试一次）', () => {
  for (const [role, chain] of Object.entries(ROLE_GROUP_LADDERS)) {
    assert.equal(new Set(chain).size, chain!.length, `★ ${role} 的链里有重复：${chain!.join(' → ')}`);
  }
});