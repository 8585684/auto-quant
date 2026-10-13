/**
 * **汇报员的人话必须进 `<team>` 审计块**（2026-10-14）
 *
 * ## 背景
 *
 * 汇报员（用户需求 ⑤ 的"汇报工作的"）在 `tradingDesk.ts` 已接线并稳定运行
 * （线上日志：`[report] reporter：完成（1906ms）`），产出进 `DeskOutcome.report`。
 * 但 `renderDeskOutcome` 没有渲染它 —— **操作员在界面上永远看不到那段人话**，
 * 等于那个岗位白做。本组测试钉住它的渲染与三态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDeskOutcome } from './deskOutput.js';
import type { DeskOutcome, DeskRoleOutput } from './tradingDesk.js';

function baseOutcome(patch: Partial<DeskOutcome> = {}): DeskOutcome {
  return {
    analyses: [],
    bull: null,
    bear: null,
    verdict: null,
    truncatedByBudget: false,
    summary: '交易台摘要',
    ...patch,
  } as DeskOutcome;
}

test('★★★ report 有产出 → 必须出现在 <team> 块最前部（先于各角色产出）', () => {
  const text = renderDeskOutcome(baseOutcome({ report: '市场普跌，BTC 横盘，本轮无可做形态，保持空仓。' }));
  assert.ok(text.includes('本轮汇报（给人看）'), '★ 必须有"本轮汇报"小节');
  assert.ok(text.includes('市场普跌，BTC 横盘'), '★ 汇报内容必须原样出现');
  /* 顺序：汇报在"各角色产出"之前 —— 它是给人看的结论，不是过程。 */
  assert.ok(
    text.indexOf('本轮汇报') < text.indexOf('## 各角色产出'),
    '★ 汇报必须排在"各角色产出"之前 —— 先看结论再看过程',
  );
});

test('★★★ report 是 null（跑了但失败）→ 必须明说，不能空白', () => {
  const text = renderDeskOutcome(baseOutcome({ report: null }));
  assert.ok(text.includes('汇报员跑了但失败'), '★ 失败必须明说 —— 空白会让操作员以为"没有值得汇报的"');
});

test('★★★ report 是 undefined（预算不足没跑）→ 必须明说，不能空白', () => {
  const text = renderDeskOutcome(baseOutcome({}));
  assert.ok(text.includes('汇报员没有被调用'), '★ 没跑必须明说 —— 与"失败"是两个不同的事实');
  assert.ok(text.includes('结论是完整的'), '★ 必须说明结论未受影响（它只是附加岗位）');
});

test('★ 超长汇报要截断（2,000 字）且不破坏 <team> 结构', () => {
  const long = 'x'.repeat(5_000);
  const text = renderDeskOutcome(baseOutcome({ report: long }));
  assert.ok(text.length < 10_000, '★ 超长必须截断（汇报员预算 1024，5k 只是防御）');
  assert.ok(text.includes('</team>'), '★ <team> 块必须仍然闭合');
});
