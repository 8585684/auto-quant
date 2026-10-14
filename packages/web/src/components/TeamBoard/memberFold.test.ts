/**
 * **角色产出必须可折叠**（2026-10-14 第三次用户反馈）
 *
 * ## 用户原话
 *
 * > 「展开后只有 300 字，看不清它在想什么」
 *
 * ## 修法分两步（缺一不可）
 *
 * ```
 *   后端 deskOutput：截断上限 300 → 2,000（数据里真的有全文）
 *   前端 MemberLine：默认显示前 300 字 + 「展开全文」按钮
 * ```
 * ⚠️ **只做前端没用**：前端拿不到更长的版本（`teamTrace` 解析的就是后端写的）。
 * ⚠️ **只做后端也没用**：2,000 字直接铺开会把版面挤爆。
 *
 * ## 判据：后端必须【留痕】
 *
 * 前端靠"留痕"判断有没有更多内容：
 * ```
 *   …（已截断，完整 1234 字）
 * ```
 * 没有留痕就不渲染按钮 —— 一个点开没有变化的按钮比没有按钮更让人困惑。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const DESK = readFileSync(
  new URL('../../../../server/src/trader/agent/deskOutput.ts', import.meta.url),
  'utf8',
);
const ROW = readFileSync(new URL('./TeamDecisionRow.tsx', import.meta.url), 'utf8');

test('★★★ 后端截断必须留痕（前端靠它判断"有没有更多"）', () => {
  assert.ok(
    /已截断，完整 \$\{s\.length\} 字/.test(DESK),
    '★ 截断时必须写明"已截断 + 完整多少字" —— 否则前端分不清"这就是全部"与"还有更多"',
  );
  assert.ok(
    /const clip = \(s: string, limit: number\)/.test(DESK),
    '★ 必须有 clip 这个统一入口（剥标签 + 压单行 + 留痕）',
  );
});

test('★★★ 分析师产出上限必须是 2,000 字（不能退回 300）', () => {
  /*
   * 300 字只够看到开头（且常常只有一个标签的开头）。
   * 实测角色产出多在 1,000–3,000 字 —— 2,000 能装下一次完整推理。
   */
  assert.ok(
    /clip\(a\.raw, 2_000\)/.test(DESK),
    '★ 分析师上限必须是 2,000（300 看不清它在想什么）',
  );
  assert.ok(
    !/oneLine\(a\.raw, 300\)/.test(DESK),
    '★ 不能再退回 300 字',
  );
});

test('★★★ 前端必须有「展开全文」按钮 + 折叠逻辑', () => {
  assert.ok(/展开全文/.test(ROW), '★ 必须有「展开全文」按钮');
  assert.ok(/useState\(false\)/.test(ROW), '★ 必须有折叠状态');
  assert.ok(
    /已截断，完整 /.test(ROW),
    '★ 必须识别后端的留痕（`已截断，完整 `）—— 它是"有没有更多"的唯一判据',
  );
});

test('★★★ 没有留痕时不渲染按钮（点开没变化的按钮比没有更糟）', () => {
  assert.ok(
    /\{truncated && \(/.test(ROW),
    '★ 按钮必须由 `truncated` 条件控制 —— 无事可展时不该出现',
  );
});
