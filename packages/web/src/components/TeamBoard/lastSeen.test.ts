/**
 * **UI 语言必须摆脱"轮次"**（2026-10-14 · 去轮次化阶段 3）
 *
 * ## 用户抓到的问题（原话）
 *
 * > 「我看到里面有提示：本轮未参与，团队模式不应该是完全抛弃了轮次这个概念吗？
 * >  而是 7X24 小时不间断按需工作」
 * > 「要完全脱离轮次这个概念（起码整体是脱离的，只有内部几个干定时工作的
 * >  AI 智能体才需要用到轮次，其他都是不间断在干活的）」
 *
 * 团队是**按需出勤**的：侦查员上一轮跑了、这轮休息是常态。
 * 一律写"本轮未参与"会让操作员以为"它没在工作"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { lastSeenOf, rosterEntries, type TeamStep } from './roster.js';

const BOARD = readFileSync(new URL('./TeamBoard.tsx', import.meta.url), 'utf8');

const ROLE = {
  id: 'scout',
  label: '侦查',
  duty: 'x',
  department: '研究',
  tier: 'T1_fast',
  status: 'staffed',
} as const;

test('★★★ 「本轮未参与」这个词必须从渲染里消失（换成语义正确的三态）', () => {
  /*
   * ⚠️ 判据查** JSX 文本节点**（`>本轮未参与<`），不是全文：
   * 注释里保留这个词是刻意的（记录为什么改）—— 而它作为渲染字符串必须消失。
   * 全文断言就是"把注释里的字当代码"（本项目已踩过 5+ 次）。
   */
  assert.ok(
    !/>本轮未参与</.test(BOARD),
    '★ 渲染里不得再出现"本轮未参与" —— 团队按需出勤，它不是异常',
  );
  assert.ok(BOARD.includes('最近活跃'), '★ 必须出现"最近活跃"（按需出勤的如实描述）');
  assert.ok(BOARD.includes('待命'), '★ 必须出现"待命"（在岗但从没被叫过 —— 如风控官全 skip 时）');
});

test('★★★ lastSeenOf：历史轮里出现过的角色 → 记下最近那轮的时刻', () => {
  /*
   * ⚠️ 传入顺序与 `DecisionFeed.records` 一致：**从新到旧**（records[0] 最新）。
   * 函数内部 reverse 后从旧扫到新 —— 后面的（新的）覆盖前面的。
   * 第一版测试数据写反了顺序，假失败了一次。
   */
  const seen = lastSeenOf([
    { cotTrace: '- judge（group/x）：产出\n- technical（group/y）：产出', timestamp: '2026-10-13T10:30:00Z' },
    { cotTrace: '- technical（group/team-grunt）：产出', timestamp: '2026-10-13T10:00:00Z' },
  ]);
  assert.equal(seen.get('technical'), '2026-10-13T10:30:00Z', 'technical 两轮都出现 → 取最近那轮');
  assert.equal(seen.get('judge'), '2026-10-13T10:30:00Z');
});

test('★ lastSeenOf：cotTrace 为空/解析不出角色 → 空结果（不崩、不编）', () => {
  assert.equal(lastSeenOf([{ cotTrace: null, timestamp: 'x' }]).size, 0);
  assert.equal(lastSeenOf([{ cotTrace: '没有角色标记的散文', timestamp: 'x' }]).size, 0);
  assert.equal(lastSeenOf([]).size, 0);
});

test('★★★ rosterEntries：本轮没跑但有历史的岗位 → lastSeenAt 有值', () => {
  const entries = rosterEntries(
    [] as TeamStep[], /* 本轮它没跑 */
    [ROLE],
    new Map([['scout', '2026-10-13T10:30:00Z']]),
  );
  assert.equal(entries[0]!.state, 'idle', '本轮没跑 → idle（这个区分不变）');
  assert.equal(entries[0]!.lastSeenAt, '2026-10-13T10:30:00Z', '但历史活跃时刻必须在');
});

test('★ rosterEntries：不传历史 → lastSeenAt 为 null（退回"待命"，不崩）', () => {
  const entries = rosterEntries([] as TeamStep[], [ROLE]);
  assert.equal(entries[0]!.lastSeenAt, null);
});
