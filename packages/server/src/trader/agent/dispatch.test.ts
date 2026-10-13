/**
 * `dispatch` 的测试 —— 重点钉住**"总管不能越过硬边界"**这条性质。
 *
 * 因为调研里的硬证据是"LLM 会漂移"（EACL 2026：生成类任务跑题率 76–89%），
 * 而在这里漂移的后果很具体：
 * ```
 *   · 派超过预算 → 裁决被饿死（实测踩过：4 + 2×2 = 8 次用光，Judge 一次没跑）
 *   · 没有新闻却派 newscaster → 它只能编，而操作员看到的是"有产出"
 *   · 一个都不派 → 辩论与裁决失去依据
 * ```
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSupervisorPrompt,
  parseDispatch,
  planDispatch,
  type AnalystCandidate,
} from './dispatch.js';

const ROLES: AnalystCandidate[] = [
  { role: 'market_analyst' },
  { role: 'technical' },
  { role: 'newscaster', needsNews: true },
  { role: 'sentiment', needsNews: true },
];

test('★★★ 总管可以少派（这是"最高智能AI统筹"的实质）', () => {
  const r = planDispatch({
    candidates: ROLES,
    budget: 4,
    hasNews: true,
    requested: ['market_analyst', 'technical'],
  });
  assert.deepEqual(r.roles, ['market_analyst', 'technical']);
  assert.equal(r.decidedBy, 'supervisor');
  assert.equal(r.skipped.length, 2, '★ 砍掉的要记下来（那是它的决策，用户要看）');
  assert.ok(r.skipped.every((s) => s.reason === '总管认为本轮不需要'));
});

test('★★★ 硬边界：不能派超过预算', () => {
  /*
   * ⚠️ 实测踩过：`maxCalls=8` 配 `maxDebateRounds=2` 时 4 + 2×2 = 8 次用光，
   * **Judge 一次都没跑**，整轮没有结论。
   */
  const r = planDispatch({
    candidates: ROLES,
    budget: 2,
    hasNews: true,
    requested: ['market_analyst', 'technical', 'newscaster', 'sentiment'],
  });
  assert.equal(r.roles.length, 2, '★ 预算只够 2 个就只派 2 个');
  assert.equal(r.skipped.filter((s) => s.reason === '调用预算不足').length, 2);
});

test('★★★ 没有新闻时不派依赖新闻的角色（防编造，不是省调用）', () => {
  /*
   * ⚠️ `newscaster` 的任务是"把新闻整理成事件卡"。没有新闻时它只能编 ——
   * 而它会**正常完成**，操作员看到的是一个"有产出"的角色。
   * **那是看不见的失败。**
   */
  const r = planDispatch({
    candidates: ROLES,
    budget: 4,
    hasNews: false,
    requested: ['market_analyst', 'technical', 'newscaster', 'sentiment'],
  });
  assert.deepEqual(r.roles, ['market_analyst', 'technical']);
  const newsSkip = r.skipped.filter((s) => s.reason.includes('没有新闻材料'));
  assert.equal(newsSkip.length, 2, '★ 两个依赖新闻的角色都该被挡下');
});

test('★★★ 一个都不派 → 退回全派（否则裁决失去依据）', () => {
  /*
   * ⚠️ 这不是"总管决定不干活"，而是**决策链断了** ——
   * 没有分析师产出时，辩论与裁决都无从谈起。
   */
  const r = planDispatch({ candidates: ROLES, budget: 4, hasNews: true, requested: [] });
  assert.equal(r.roles.length, 4, '★ 应当退回全派');
  assert.equal(r.decidedBy, 'fallback_all');
  assert.ok(
    r.skipped.some((s) => s.reason.includes('退回全派')),
    '★ 必须如实记下"它的决定被边界挡下"，而不是假装它决定了全派',
  );
});

test('★★★ 拿不到总管的决定 → 全派（保守降级，行为与改动前一致）', () => {
  /*
   * 调用失败/解析失败时**多派一个只是多花一次调用**，
   * 而少派一个会让裁决官失去一份依据。
   */
  const r = planDispatch({ candidates: ROLES, budget: 4, hasNews: true, requested: null });
  assert.deepEqual(r.roles, ['market_analyst', 'technical', 'newscaster', 'sentiment']);
  assert.equal(r.decidedBy, 'fallback_all');
  assert.equal(r.skipped.length, 0);
});

test('★ 派出的角色顺序固定为原顺序（它决定"派谁"，不是排序）', () => {
  /*
   * ⚠️ 若按总管给的顺序重排，我会**分不清"是派活变了还是措辞变了"**。
   */
  const r = planDispatch({
    candidates: ROLES,
    budget: 4,
    hasNews: true,
    requested: ['sentiment', 'market_analyst'],
  });
  assert.deepEqual(r.roles, ['market_analyst', 'sentiment'], '★ 必须按原顺序');
});

test('★★★ 解析：编造的角色名必须被丢弃', () => {
  /*
   * ⚠️ 它编的角色名**没有提示词、没有档位** ——
   * 最终表现为"某个角色永远不产出"，而无人知道原因。
   */
  const picked = parseDispatch('DISPATCH: market_analyst, 不存在的角色, technical', [
    'market_analyst',
    'technical',
    'newscaster',
    'sentiment',
  ]);
  assert.deepEqual(picked, ['market_analyst', 'technical'], '★ 编的必须被丢掉');
});

test('★ 解析：拿不到 DISPATCH 行 / 空 → null（调用方退回全派）', () => {
  assert.equal(parseDispatch('我觉得应该都派上', ['a']), null);
  assert.equal(parseDispatch('DISPATCH:', ['a']), null);
  assert.equal(parseDispatch('', ['a']), null);
});

test('★ 解析：中文逗号、顿号、空格都要认', () => {
  assert.deepEqual(parseDispatch('DISPATCH: a，b、c d', ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd']);
});

test('★ 解析：去重（重复派同一角色会让同一份材料被问两遍）', () => {
  assert.deepEqual(parseDispatch('DISPATCH: a, a, b', ['a', 'b']), ['a', 'b']);
});

test('★ 提示词必须告诉它"缺材料的角度不要派"与输出格式', () => {
  /*
   * ⚠️ 与 `ROLE_TIERS` 那条防漂移测试同一性质：
   * **要求可以被改，但不能被悄悄删掉。**
   */
  const p = buildSupervisorPrompt({
    candidates: ROLES,
    hasNews: false,
    positionCount: 0,
    symbolCount: 12,
  });
  assert.ok(p.system.includes('DISPATCH:'), '★ 必须给出输出格式');
  assert.ok(p.system.includes('缺材料'), '★ 必须说"缺材料的不要派"');
  assert.ok(p.system.includes('宁多勿少'), '★ 必须说"少一份分析=少一份依据"');
  assert.ok(p.user.includes('**没有**'), '★ 必须如实告诉它有没有新闻');
  assert.ok(p.system.includes('newscaster'), '★ 必须列出可选角色');
  assert.ok(p.system.includes('必须有新闻材料'), '★ 必须标出哪些角色依赖新闻');
});
