/**
 * **模型的机器包装标签不能出现在给人看的产出里**（2026-10-14 第二次用户反馈）
 *
 * ## 现象（用户原话）
 *
 * > 「出现大量 `<reasoning>`、空的，还有杂乱无章，看的一头雾水」
 *
 * 压成单行解决了"杂乱无章"（见 `teamTraceBody.test.ts`），
 * 但**展开后第一行仍然是 `<reasoning>`** —— 因为模型的输出本来就是
 * `<reasoning>…</reasoning>` 包着的，而那个标签**是机器标记，不是给人看的内容**。
 * 它占了 300 字预算里最显眼的位置，看起来像"空内容"。
 *
 * ## 判据
 *
 * ```
 *   ✗ <reasoning> 让我先把这轮材料按我自己的规则走一遍…
 *   ✓ 让我先把这轮材料按我自己的规则走一遍…
 * ```
 *
 * ⚠️ 剥的是**项目自己的输出契约标签**（`AGENTS.md` §5.2：XML 标签是机器契约）——
 * `renderDeskOutcome` 自己也在产出 `<decision>` / `<risk>` / `<team>`，
 * 那些块各有自己的渲染，所以剥掉不会丢信息。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDeskOutcome } from './deskOutput.js';
import type { DeskOutcome, DeskRoleOutput } from './tradingDesk.js';

function role(patch: Partial<DeskRoleOutput> = {}): DeskRoleOutput {
  return { role: 'market_analyst', modelId: 'm', data: null, raw: '', latencyMs: 0, ok: true, ...patch } as DeskRoleOutput;
}

function outcome(patch: Partial<DeskOutcome> = {}): DeskOutcome {
  return {
    analyses: [],
    bull: null,
    bear: null,
    verdict: null,
    truncatedByBudget: false,
    summary: 'x',
    ...patch,
  } as DeskOutcome;
}

test('★★★ `<reasoning>` 标签必须被剥掉（它看起来像"空内容"）', () => {
  const text = renderDeskOutcome(
    outcome({
      analyses: [role({ raw: '<reasoning>让我先按规则算一遍位移。</reasoning>' })],
    }),
  );
  assert.ok(
    !text.includes('<reasoning>'),
    '★ 展开后不该再看到 <reasoning> 标签 —— 它是机器包装，不是内容',
  );
  assert.ok(
    text.includes('让我先按规则算一遍位移'),
    '★ 标签【内】的内容必须保留（剥的是包装，不是内容）',
  );
});

test('★★★ 只剥"包装类"标签（thinking / answer），不碰 decision / tool', () => {
  /*
   * ⚠️ 白名单**刻意很短**：
   * ```
   *   reasoning / thinking / answer  ← 模型的思考/结论包装，剥
   *   decision / risk / team         ← renderDeskOutcome 自己要用，不剥
   *   tool                           ← stripToolBlocks 的职责，不剥
   * ```
   * ## 实测踩到：兜底正则把 `<tool>` 拆散了
   *
   * 第一版加了 `.replace(/<\/?[a-z_]+>/gi, ' ')` 兜底 —— 它把
   * `<tool>{…}</tool>` 的标签剥掉、留下裸 JSON，而 `stripToolBlocks()`
   * 按整块匹配 → 找不到 → `teamModel.test.ts` 变红。
   * **而后果不只是测试**：`<tool>` 残留会让按需取数循环重跑整个交易台。
   */
  const text = renderDeskOutcome(
    outcome({
      analyses: [role({ raw: '<thinking>想一下</thinking> <answer>结论</answer> <tool>{"a":1}</tool>' })],
    }),
  );
  const start = text.indexOf('- market_analyst');
  const line = text.slice(start, text.indexOf('\n', start));
  assert.ok(!line.includes('<thinking>') && !line.includes('<answer>'), '★ 包装标签要剥');
  assert.ok(line.includes('想一下') && line.includes('结论'), '★ 内容保留');
  /*
   * ⚠️ 判据反过来写：`<tool>` **必须保留**（留给 `stripToolBlocks` 整块剥）。
   *
   * 我第一版断言的是 `!line.includes('<tool>')` —— **写反了**。
   * 渲染层的职责只是"别动它"；剥 `<tool>` 块是 `stripToolBlocks` 的事，
   * 而且它必须看到**完整**的块（标签被拆散就找不到了）。
   */
  assert.ok(
    line.includes('<tool>'),
    '★ ⚠️ 渲染层【不能】动 <tool> —— 它要完整留给 stripToolBlocks 整块剥',
  );
});

test('★★★ 压单行后不能有多余空格（换行→空格会产生连续空格）', () => {
  const text = renderDeskOutcome(
    outcome({ analyses: [role({ raw: '<reasoning>第一段\n\n\n第二段</reasoning>' })] }),
  );
  const line = text.split('\n').find((l) => l.includes('第一段')) ?? '';
  assert.ok(!/  {2,}/.test(line), `★ 不该有连续空格（实际：${JSON.stringify(line.slice(0, 80))}）`);
});

test('★ 汇报员的产出同样剥标签 + 压单行', () => {
  const text = renderDeskOutcome(outcome({ report: '<reasoning>{"account":"x"}</reasoning>' }));
  assert.ok(!text.includes('<reasoning>'), '★ 汇报段也不该有标签');
  assert.ok(text.includes('{"account":"x"}'), '★ 汇报内容要保留');
});

test('★ 多行产出必须仍是单行（换行会污染前端解析）', () => {
  const text = renderDeskOutcome(
    outcome({
      analyses: [role({ raw: '第一行\n- **实体**：会被误解析成角色\n第三行' })],
    }),
  );
  const start = text.indexOf('- market_analyst');
  const line = text.slice(start, text.indexOf('\n', start));
  assert.ok(!line.includes('\n'), '★ 角色行必须是单行');
  assert.ok(line.includes('第一行') && line.includes('第三行'), '★ 内容都要保留');
});
