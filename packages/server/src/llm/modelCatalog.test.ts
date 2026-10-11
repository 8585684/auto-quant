/**
 * 候选链排序的测试。
 *
 * ## 为什么这里要测得具体（实测踩到的性能问题）
 *
 * 原来的排序是"**先按免费分组，再按速度排**"。于是实测：
 *
 * ```
 *   T1_fast 候选链：
 *     1. nemotron-3.5-lightning-free   free=true  reasoning=Y  3246ms
 *     2. muse-spark-...-free           free=true  reasoning=Y  4140ms
 *     3. big-pickle                    free=true  reasoning=Y  4314ms
 *     4. deepseek-v4.1-flash           free=false reasoning=-  1505ms  ← 最快却排第 4
 * ```
 *
 * **前三个都是思维链模型**，真实提示词（20 个标的）下单个角色要 **47–59 秒**；
 * 而最快的两个（约 1.5 秒）因为"要花钱"被排到后面。整轮决策因此要数分钟。
 *
 * 对 7×24 持续工作来说，**快本身就是产出** —— 省下的时间能做更多轮决策。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_PROFILES, ladderForTier } from './modelCatalog.js';

test('★★ T1（体力活）候选链的第 1 位必须是【最快的那个】', () => {
  /*
   * 这是实测修正的核心：体力活的瓶颈是**速度**，不是钱。
   * 实测思维链模型要 47–59 秒，非思维链的约 1.5 秒 —— 差 30 倍。
   */
  const ladder = ladderForTier('T1_fast');
  const first = ladder[0]!;
  const fastest = [...MODEL_PROFILES.filter((m) => m.tier === 'T1_fast' && m.verified)].sort(
    (a, b) => (a.measuredMs ?? 1e9) - (b.measuredMs ?? 1e9),
  )[0]!;

  assert.equal(first.id, fastest.id, `★ T1 首选应当是最快的（实际 ${first.id} ${first.measuredMs}ms）`);
  assert.ok(
    (first.measuredMs ?? 1e9) < 3_000,
    `★ T1 首选的实测耗时应当 <3 秒，实际 ${first.measuredMs}ms —— 否则整轮会很慢`,
  );
});

test('★★ T1 的首选不能是思维链模型（它们在体力活上又慢又被自己的推理带偏）', () => {
  const first = ladderForTier('T1_fast')[0]!;
  assert.equal(first.reasoning, false, `★ T1 首选不该是思维链模型（实际 ${first.id}）`);
});

test('★★ T3（判断）候选链不能被"免费"压制 —— 质量直接决定盈亏', () => {
  /*
   * 辩论与裁决的质量直接影响交易结果。把它们让位给免费模型是**省小钱亏大钱**。
   * （额度耗尽时由健康记录与降级链兜底，那是运行期的事。）
   */
  const ladder = ladderForTier('T3_deep');
  assert.equal(ladder[0]!.free, false, '★ T3 首选应当是最强的付费模型，而不是免费的');
});

test('★ 每个档位仍然保留免费兜底（额度见底时不能停摆）', () => {
  /*
   * 这条与上面"速度优先"不矛盾：
   * **首选要快/要强，但链上必须还有免费的** —— 否则额度一尽就停摆。
   */
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ladder = ladderForTier(tier);
    assert.ok(
      ladder.some((m) => m.free),
      `★ 档位 ${tier} 的候选链里必须有免费模型`,
    );
  }
});

test('★ 兜底档优先选免费的（要能长期靠得住）', () => {
  /*
   * T1 的降级路径是 `T1 → T2`，而 T2 那一段是"兜底段"。
   * 兜底段应当免费优先 —— 付费额度留给主力。
   */
  const ladder = ladderForTier('T1_fast');
  const t2Part = ladder.filter((m) => m.tier === 'T2_mid');
  if (t2Part.length > 0) {
    assert.equal(t2Part[0]!.free, true, '★ 兜底段应当免费优先');
  }
});

test('候选链里没有重复模型', () => {
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ids = ladderForTier(tier).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `★ 档位 ${tier} 的候选链有重复`);
  }
});
