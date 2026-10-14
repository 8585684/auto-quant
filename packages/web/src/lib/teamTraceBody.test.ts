/**
 * **角色产出的正文不能被当成"角色"**（2026-10-14 用户截图抓到的 BUG）
 *
 * ## 现象（用户原话）
 *
 * > 「出现大量 `<reasoning>`、空的，还有杂乱无章，看的一头雾水」
 *
 * 截图里看板冒出十几行莫名其妙的"岗位"：
 * ```
 *   **实体** · **方向** · **强度** · 6 个候选的完整指标序列 · ARC开空75分 …
 * ```
 * 而它们其实是**某个角色产出里的 markdown 列表项**。
 *
 * ## 根因链（两处合起来）
 *
 * ```
 *   ① deskOutput.ts 把 raw.slice(0, 300) 原样插进一行 —— 而 raw 是【多行】的
 *   ② teamTrace.ts 逐行扫 '## 各角色产出' 之后的内容，
 *      见到 `- xxx：yyy` 就当角色行
 *   → 多行正文里的 `- **实体**：…` 于是变成了一行"角色"
 * ```
 *
 * ## 两层防线（本文件各钉一层）
 *
 * ```
 *   渲染层：产出压成单行（换行 → 空格）—— 从源头消除
 *   解析层：role 必须是"纯小写英文+下划线"的形态 —— 解析器自保
 * ```
 * ⚠️ **两层都要**：单行化依赖渲染处记得做；形态判据是解析器不信任输入。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseTeamTrace } from './teamTrace.js';

const DESK = readFileSync(
  new URL('../../../server/src/trader/agent/deskOutput.ts', import.meta.url),
  'utf8',
);

/* -------------------------------------------------------------------------- */
/*  解析层                                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 正文里的 markdown 列表项不能被当成角色（线上 c134 的真实内容）', () => {
  /*
   * 用线上 `<team>` 块的真实形态：newscaster 的产出里含 `- **实体**：…`，
   * market_analyst 的产出里含 `- 6 个候选的完整指标序列：…`。
   */
  const raw = [
    '<team>',
    '交易台：分析师 4/4 成功',
    '## 各角色产出',
    '- market_analyst（group/team-analyst）：<reasoning> 我先看材料。',
    '- 6 个候选的完整指标序列：BTCUSDT、TRUTHUSDT、BATUSDT',
    '- technical（group/team-grunt）：<reasoning> 均线多头。',
    '- newscaster（group/team-grunt）：# 新闻事件卡',
    '- **实体**：Interactive Brokers（IBKR）、ZeroHash',
    '- **方向**：bullish（对 ETH 需求面偏多）',
    '- **强度**：中 — 结构性增量渠道',
    '- sentiment（group/team-grunt）：样本不足。',
    '</team>',
  ].join('\n');

  const trace = parseTeamTrace(raw);
  assert.ok(trace !== null, '★ 必须能解析');
  const roles = trace.members.map((m) => m.role);

  /* 真角色必须在。 */
  for (const r of ['market_analyst', 'technical', 'newscaster', 'sentiment']) {
    assert.ok(roles.includes(r), `★ 真角色 ${r} 丢了`);
  }
  /* 正文列表项【不能】被当成角色。 */
  for (const bad of ['**实体**', '**方向**', '**强度**', '6 个候选的完整指标序列']) {
    assert.ok(!roles.includes(bad), `★ 「${bad}」是正文内容，不该被当成角色`);
  }
  assert.equal(trace.members.length, 4, `★ 应该恰好 4 个角色（实际 ${trace.members.length}：${roles.join(',')}）`);
});

test('★★★ 角色 id 的形态判据：纯小写英文 + 数字下划线', () => {
  const raw = [
    '<team>',
    '## 各角色产出',
    '- judge（m）：结论。',
    '- bull：做多。',
    '- ARC开空75分：这是正文',
    '- BTC 83372.70 +0.57%：这也是正文',
    '- **来源**：The Block',
    '- market_analyst2：带数字的 id 合法',
    '</team>',
  ].join('\n');
  const roles = parseTeamTrace(raw)!.members.map((m) => m.role);
  assert.deepEqual(roles, ['judge', 'bull', 'market_analyst2'], `★ 只该留合法 id 形态（实际 ${roles.join(',')}）`);
});

test('★ 单行产出仍能正常解析（不能把正常的也挡掉）', () => {
  const raw = ['<team>', '## 各角色产出', '- reporter（m）：本轮全 skip。', '</team>'].join('\n');
  const t = parseTeamTrace(raw)!;
  assert.equal(t.members.length, 1);
  assert.equal(t.members[0]!.role, 'reporter');
  assert.equal(t.members[0]!.modelId, 'm');
});

/* -------------------------------------------------------------------------- */
/*  渲染层                                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 渲染层必须把产出压成单行（换行会破坏解析）', () => {
  /*
   * ⚠️ 2026-10-14：渲染入口从 `oneLine(a.raw, N)` 改成了 `clip(a.raw, N)` ——
   * `clip` 内部仍走 `oneLine`（压单行），只是多加了"截断留痕"。
   * 所以判据看 `clip`（它是当前的渲染入口）。
   */
  assert.ok(
    /clip\(a\.raw/.test(DESK),
    '★ 分析师的产出必须走 clip（内部压成单行）—— 否则它的列表项会变成"角色"',
  );
  assert.ok(/clip\(outcome\.bull\.raw/.test(DESK), '★ bull 也要压成单行');
  assert.ok(/clip\(outcome\.bear\.raw/.test(DESK), '★ bear 也要压成单行');
  assert.ok(/clip\(verdict\.raw/.test(DESK), '★ judge 也要压成单行');
  assert.ok(
    /replace\(\/\\s\*\\n\+\\s\*\/g, ' '\)/.test(DESK),
    '★ oneLine 必须真的把换行替换掉（不是只截断 —— 截断仍保留换行，问题照旧）',
  );
});
