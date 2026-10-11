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

/* -------------------------------------------------------------------------- */
/*  复核发现的问题的回归测试（2026-10-12）—— 每条都对应一个真实缺陷              */
/* -------------------------------------------------------------------------- */

test('★★ budgetFor 绝不能【缩小】预算（复核发现的 P1-D）', () => {
  /*
   * 第一版的 `Math.min(maxOutput, base*4)` 在 `maxOutput < base*4` 时
   * 返回的比 base 还小 —— 例如 big-pickle（maxOutput=32000）配 base=131072
   * → 返回 32000（base 的 0.24 倍），**正好制造它要防的 `content: null`**。
   *
   * 原来的测试用 `find(m => m.reasoning && m.tier === 'T3_deep')` 取到 kimi-k3，
   * 而它 `maxOutputTokens === 0`（走 base×4 那条路）——
   * **测试恰好只覆盖了唯一不会暴露 bug 的那个模型**。
   *
   * 所以这里**遍历所有思维链模型**，而不是挑一个。
   */
  const reasoning = MODEL_PROFILES.filter((m) => m.reasoning);
  assert.ok(reasoning.length > 0);
  for (const m of reasoning) {
    const base = 131_072;
    const budget = budgetFor(m, base);
    assert.ok(
      budget >= base,
      `★ ${m.id}（maxOutput=${m.maxOutputTokens}）的预算 ${budget} 小于基准 ${base} —— 绝不能缩小`,
    );
  }
});

test('★ budgetFor 对【报了上限】的思维链模型仍然放大，但不超过上限', () => {
  const withLimit = MODEL_PROFILES.find((m) => m.reasoning && m.maxOutputTokens > 0);
  assert.ok(withLimit, '档案里应当有"报了输出上限"的思维链模型');
  const budget = budgetFor(withLimit, 1000);
  assert.ok(budget > 1000, '★ 应当放大');
  assert.ok(budget <= withLimit.maxOutputTokens, '★ 不超过供应商声明的上限');
});

test('★ 冷却【到期后会清零失败计数】（复核发现的 P1-E）', () => {
  /*
   * 原来只在 recordSuccess 里清零，于是到期后 `consecutiveFailures` 仍是阈值，
   * **下一次单点失败立刻又冷却** —— 一个"每 5 分钟试一次就再关 5 分钟"的模型
   * 实际可用率接近 0，与本类"单次失败不足以判死"的承诺相反。
   */
  let now = 1_000_000;
  const h = new ModelHealthRegistry(2, 60_000, () => now);
  h.recordFailure('m', 'a');
  h.recordFailure('m', 'b');
  assert.equal(h.isAvailable('m'), false, '连续两次失败应冷却');

  now += 60_001;
  assert.equal(h.isAvailable('m'), true, '到期后应恢复');
  /* ★ 关键：到期后**一次**失败不该立刻又冷却 */
  h.recordFailure('m', 'c');
  assert.equal(h.isAvailable('m'), true, '★ 到期后计数必须已清零 —— 单次失败不该立刻重新冷却');
});

test('★★ 被 token 上限截断 → 加大预算【重试同一个模型】（复核发现的 P1-C）', async () => {
  /*
   * `classifyFailure` 对 `empty_content + finishReason='length'` 明确返回
   * `shouldRetry: true, shouldFallback: false`，理由写的是"加大 max_tokens 重试"。
   * 但第一版的实现是"换下一个候选"—— 循环顶部跳过了 `tried`，
   * **同一个模型永远不会被第二次选中**，那条分支等于白写。
   *
   * 而换模型会白白丢掉最强的那个（它只是这次话说得多了一点，不是坏了）。
   */
  const calls: Array<{ model: string; maxTokens: number }> = [];
  const router = new ModelRouter({
    call: async (modelId, _msgs, options) => {
      calls.push({ model: modelId, maxTokens: options.maxTokens });
      /* 第一次（小预算）被截断，第二次（大预算）成功 */
      if (calls.length === 1) {
        return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'length' };
      }
      return { text: '成功了', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' };
    },
  });

  const r = await router.callByTier('T3_deep', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 4096 });

  assert.equal(r.text, '成功了');
  assert.equal(calls.length, 2, '应当重试了一次');
  assert.equal(calls[1]!.model, calls[0]!.model, '★ 必须重试【同一个】模型，而不是换模型');
  assert.ok(
    calls[1]!.maxTokens > calls[0]!.maxTokens,
    `★ 第二次的预算必须【更大】（${calls[0]!.maxTokens} → ${calls[1]!.maxTokens}）`,
  );
});

test('★ 空内容但【不是】被截断 → 走降级路径（不与截断混淆）', async () => {
  /*
   * 区分这两种情况是 `finishReason` 存在**唯一**的理由：
   *   · 被截断 → 加大预算重试同一模型（它没坏）
   *   · 真空回复 → 重试/降级（可能真的坏了）
   */
  const calls: string[] = [];
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: async (modelId) => {
      calls.push(modelId);
      if (calls.length === 1) {
        /* 空内容，但 finishReason 不是 length → 真空回复 */
        return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'stop' };
      }
      return { text: 'ok', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' };
    },
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 512 });
  assert.equal(r.modelId, ladder[1]!, '★ 真空回复应当换模型，而不是原地重试');
});

test('★ 连续被截断时【只放大一次】，不无限重试（防死循环）', async () => {
  /*
   * MAST 分类法实测「步骤重复」是最高频失败模式（15.7%）。
   * "预算越大、思维链写得越长"会收敛不了 —— 所以只放大一次。
   */
  let callCount = 0;
  const router = new ModelRouter({
    call: async () => {
      callCount += 1;
      return { text: '', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'length' };
    },
    maxFallbacks: 2,
  });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 512 }),
    /都失败/,
    '★ 应当以失败收场，而不是无限重试',
  );
  /* 4 个候选（maxFallbacks=2 → 至多 3 个）+ 至多 1 次放大重试 */
  assert.ok(callCount <= 5, `★ 调用次数必须有界，实际 ${callCount}`);
});