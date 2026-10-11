/**
 * 模型中枢的测试 —— **重点钉住用户最关心的那条：额度不足时自动向下平替**。
 *
 * 用户 2026-10-12 的原话：
 *
 * > 「万一claude额度不足了，系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
 *
 * 所以这里不是测"函数返回了什么"，而是测**系统在故障下还能不能干活**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_PROFILES, ladderForTier, profileOf } from './modelCatalog.js';
import { ModelHealthRegistry, classifyFailure, pickAvailable } from './modelHealth.js';
import { ModelRouter, budgetFor, type CallModel } from './modelRouter.js';

/* -------------------------------------------------------------------------- */
/*  模型档案                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 每个档位都有候选链，且 T1/T2 必须有免费兜底（额度见底时的生命线）', () => {
  /*
   * 实测事实：`workbuddy-ai` 只剩 3.13/350 credits、`cline` 只剩 $0.50。
   * 所以"没有免费兜底"的档位 = 额度一尽就停摆。
   */
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ladder = ladderForTier(tier);
    assert.ok(ladder.length > 0, `档位 ${tier} 不能是空的`);
    assert.ok(
      ladder.some((m) => m.free),
      `★ 档位 ${tier} 必须有免费候选 —— 否则额度用尽时系统会停摆`,
    );
  }
});

test('T1/T2 的候选链把免费模型排在前面（体力活用付费额度是浪费）', () => {
  const t1 = ladderForTier('T1_fast');
  assert.equal(t1[0]!.free, true, '★ T1 首选应当是免费的（打标/摘要这类活不需要顶级智商）');
});

test('T3 的候选链把强模型排在前面（辩论与裁决需要智商）', () => {
  const t3 = ladderForTier('T3_deep');
  assert.equal(t3[0]!.free, false, 'T3 首选应当是最强的，不是免费的');
});

test('档案里的实测数据自洽（有耗时的都应是已验证）', () => {
  for (const m of MODEL_PROFILES) {
    if (m.measuredMs !== null) {
      assert.equal(m.verified, true, `${m.id} 有实测耗时却没标记 verified`);
      assert.ok(m.measuredMs > 0, `${m.id} 的耗时必须是正数`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  失败分类 —— 决定"重试"还是"降级"                                            */
/* -------------------------------------------------------------------------- */

test('★ 429 有两种含义，必须靠 message 区分（实测结论）', () => {
  /*
   * 实测：magpie 用 429 同时表达"限流"与"端点不可用/额度尽"。
   * 只看状态码会把"额度尽"误判成"限流"，于是永远在原地重试、永不降级。
   */
  const quota = classifyFailure({
    status: 429,
    message: 'OpenCode Zen Free: Upstream request failed: Endpoint is unavailable.',
  });
  assert.equal(quota.kind, 'endpoint_down', '★ 429 + Endpoint unavailable 必须判为降级');
  assert.equal(quota.shouldFallback, true);

  const limited = classifyFailure({ status: 429, message: 'rate limit exceeded, retry later' });
  assert.equal(limited.kind, 'rate_limited', '429 + rate limit 应判为限流');
  assert.equal(limited.shouldFallback, false, '限流应当先退避重试，不是立刻换模型');
  assert.equal(limited.shouldRetry, true);
});

test('★ HTTP 200 但内容为空 + finish=length → 加大预算重试，【不降级】', () => {
  /*
   * 实测：gpt-6-astra 在 max_tokens=16/128 时 content=null、reasoning=435/475。
   * 这不是"模型坏了"，是"思维链把预算吃光了" —— 降级会白白丢掉最强模型。
   */
  const v = classifyFailure({ status: 200, message: '', emptyContent: true, finishReason: 'length' });
  assert.equal(v.kind, 'empty_content');
  assert.equal(v.shouldFallback, false, '★ 不该降级 —— 加预算重试就行');
  assert.equal(v.shouldRetry, true);
});

test('★ 400 请求错【不降级】—— 降级会掩盖真正的 bug', () => {
  const v = classifyFailure({ status: 400, message: 'invalid request: model must be a nonempty string' });
  assert.equal(v.kind, 'bad_request');
  assert.equal(v.shouldFallback, false);
  assert.equal(v.shouldRetry, false);
});

test('404 knows no model → 立刻降级', () => {
  const v = classifyFailure({ status: 404, message: 'magpie knows no model "x"; did you mean…' });
  assert.equal(v.kind, 'model_missing');
  assert.equal(v.shouldFallback, true);
  assert.equal(v.shouldRetry, false);
});

/* -------------------------------------------------------------------------- */
/*  健康注册表 —— 冷却而不是永久拉黑                                             */
/* -------------------------------------------------------------------------- */

test('★ 单次失败不冷却（实测：同一模型可用性会波动）', () => {
  /*
   * 实测 `ling-3.1-flash-free`：mt=512 成功、mt=16/128/2048 失败。
   * 如果一次失败就拉黑，一个瞬时抖动会把好模型永久踢出候选链。
   */
  let now = 1_000_000;
  const h = new ModelHealthRegistry(2, 60_000, () => now);
  h.recordFailure('m1', 'boom');
  assert.equal(h.isAvailable('m1'), true, '★ 第一次失败不该冷却');
  h.recordFailure('m1', 'boom');
  assert.equal(h.isAvailable('m1'), false, '连续第二次失败才冷却');
  now += 60_001;
  assert.equal(h.isAvailable('m1'), true, '冷却到期后应恢复可用');
});

test('成功会清零连续失败计数', () => {
  const h = new ModelHealthRegistry(2, 60_000, () => 1_000_000);
  h.recordFailure('m1', 'x');
  h.recordSuccess('m1');
  h.recordFailure('m1', 'x');
  assert.equal(h.isAvailable('m1'), true, '成功之后重新计数');
});

/* -------------------------------------------------------------------------- */
/*  路由器 —— 端到端：额度不足时自动平替                                          */
/* -------------------------------------------------------------------------- */

/** 造一个可控的调用桩：按模型名决定成功还是失败。 */
function stubCall(behavior: Record<string, { ok: boolean; status?: number; message?: string; text?: string }>): CallModel {
  return async (modelId) => {
    const b = behavior[modelId] ?? { ok: true, text: '默认成功' };
    if (!b.ok) {
      const err = new Error(b.message ?? 'boom') as Error & { status?: number };
      if (b.status !== undefined) err.status = b.status;
      throw err;
    }
    return {
      text: b.text ?? '成功',
      latencyMs: 10,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };
}

test('★★ 核心用例：首选模型额度耗尽 → 自动平替到下一个，系统不中断', async () => {
  /*
   * 这是用户最关心的场景：
   *   「万一claude额度不足了，系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
   *
   * 首选（最强的那个）返回"额度尽"，路由器应当自动换到下一个候选并成功。
   */
  const ladder = ladderForTier('T3_deep').map((m) => m.id);
  const first = ladder[0]!;
  const second = ladder[1]!;

  const router = new ModelRouter({
    call: stubCall({
      [first]: { ok: false, status: 429, message: 'You have insufficient credits to make this request.' },
      [second]: { ok: true, text: '平替成功' },
    }),
  });

  const result = await router.callByTier('T3_deep', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 100 });

  assert.equal(result.text, '平替成功', '★ 必须拿到内容 —— 系统不能因为首选额度尽就停摆');
  assert.equal(result.modelId, second, '★ 应当自动换到第二候选');
  assert.equal(result.attempts.length, 2, '应当能看到"试了两个模型"');
  assert.equal(result.attempts[0]!.ok, false, '★ 第一次尝试的失败必须被记录（可观测）');
  assert.equal(result.attempts[1]!.ok, true);
});

test('★ 首选 404（模型下线）也能平替', async () => {
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: stubCall({
      [ladder[0]!]: { ok: false, status: 404, message: 'magpie knows no model "x"' },
      [ladder[1]!]: { ok: true, text: 'ok' },
    }),
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 });
  assert.equal(r.modelId, ladder[1]!);
});

test('★ 400 请求错必须原样抛出，【不许】靠换模型掩盖', async () => {
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: stubCall({
      [ladder[0]!]: { ok: false, status: 400, message: 'invalid request: json: cannot unmarshal' },
      [ladder[1]!]: { ok: true, text: '不该走到这里' },
    }),
  });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /invalid request/,
    '★ 400 是代码 bug，换模型只会掩盖它',
  );
});

test('★ 空内容会重试并最终成功（不是立刻失败）', async () => {
  const ladder = ladderForTier('T2_mid').map((m) => m.id);
  let call = 0;
  const router = new ModelRouter({
    call: async (modelId) => {
      call += 1;
      if (call === 1) return { text: '   ', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } };
      return { text: '第二次有内容了', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });
  const r = await router.callByTier('T2_mid', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 });
  assert.equal(r.text, '第二次有内容了');
  assert.equal(r.attempts[0]!.ok, false, '第一次的空内容要被记录');
});

test('★ 整条链都不可用时【抛出】，不假装成功', async () => {
  /*
   * P2 原则（最终决定权由代码强制）：没有可用模型时必须报出来，
   * 而不是静默返回一个空结果 —— 那会让上层以为"模型说没事"。
   */
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const behavior: Record<string, { ok: boolean; status?: number; message?: string }> = {};
  for (const id of ladder) behavior[id] = { ok: false, status: 429, message: 'insufficient credits' };

  const router = new ModelRouter({ call: stubCall(behavior), maxFallbacks: 3 });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /候选链全部处于冷却期|都失败/,
  );
});

test('T0_code 档不调用模型（这类工作必须由代码完成）', async () => {
  const router = new ModelRouter({ call: stubCall({}) });
  await assert.rejects(
    () => router.callByTier('T0_code', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /T0_code/,
  );
});

/* -------------------------------------------------------------------------- */
/*  输出预算                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 思维链模型的输出预算被放大（否则实测会得到 content=null）', () => {
  const reasoningModel = MODEL_PROFILES.find((m) => m.reasoning && m.tier === 'T3_deep');
  assert.ok(reasoningModel, '档案里应当有思维链模型');
  const budget = budgetFor(reasoningModel, 100);
  assert.ok(budget > 100, `★ 思维链模型预算应放大，实际 ${budget}`);

  const plain = MODEL_PROFILES.find((m) => !m.reasoning);
  assert.ok(plain);
  assert.equal(budgetFor(plain, 100), 100, '非思维链模型不该被放大');
});

/* -------------------------------------------------------------------------- */
/*  候选挑选                                                                   */
/* -------------------------------------------------------------------------- */

test('pickAvailable 跳过冷却中的模型', () => {
  const h = new ModelHealthRegistry(1, 60_000, () => 1_000_000);
  h.recordFailure('a', 'x');
  assert.equal(pickAvailable(['a', 'b'], h), 'b');
  assert.equal(pickAvailable(['a'], h), null, '全冷却时返回 null（由调用方决定怎么办）');
});

test('profileOf 能按 id 取到档案', () => {
  assert.ok(profileOf('workbuddy-ai/deepseek-v4.1-flash'));
  assert.equal(profileOf('不存在的模型'), undefined);
});
