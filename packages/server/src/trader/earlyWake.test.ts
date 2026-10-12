/**
 * 事件驱动唤醒的闸门测试。
 *
 * ## 为什么这里必须测得细
 *
 * 用户要求「系统**不再是像现在这样定时去工作**，而是持续、并发的工作」——
 * 本模块是那个"不等定时"的实现。
 *
 * 但"事件驱动"最危险的失败模式是**把自己唤醒到死循环**：
 * 调研里 MAST 分类法实测 **步骤重复占 15.7%**，而
 * "成交 → 唤醒 → 决策 → 又成交 → 又唤醒"正是最典型的重复形状。
 *
 * 所以四道闸门每一条都要被单独钉住 —— 少一条的后果是灾难性的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldEarlyWake } from './autoTrader.js';

/** 默认：团队模式、在跑、没有正在执行的轮次、原定周期还很远。 */
const base = {
  mode: 'ai_team',
  running: true,
  cycleInFlight: false,
  nextCycleAt: 10_000_000,
  lastEarlyWakeAt: null,
  now: 1_000_000,
};

test('★ 团队模式 + 原定周期还远 → 唤醒', () => {
  const v = shouldEarlyWake(base);
  assert.equal(v.wake, true, '★ 这是"不等定时"的基本情形');
});

test('★★ 只有 `ai_team` 开启 —— `ai_managed` 一律不唤醒（保护实盘 #10）', () => {
  /*
   * 用户的硬约束：
   * > 「你现在的更新迭代**不要影响我现在实盘跑的机器人**：赚大钱」
   *
   * `#10 赚大钱` 是 `ai_managed`。对它在成交后插一次额外决策**会改变它的行为**
   * （多一次模型调用、可能多一次调仓判断）—— 那正是用户说不要的。
   */
  for (const mode of ['ai_managed', 'strategy', '']) {
    const v = shouldEarlyWake({ ...base, mode });
    assert.equal(v.wake, false, `★ 模式 ${mode || '(空)'} 不该被事件唤醒`);
  }
});

test('★★ 最小间隔内不重复唤醒（防死循环的核心闸门）', () => {
  /*
   * 场景：行情剧烈，连续成交。没有这道闸门就会
   * "刚决策完又被唤醒" → 无限循环 → 烧额度且重复下单。
   */
  const v = shouldEarlyWake({
    ...base,
    /* 才过了 30 秒（最小间隔是 3 分钟）。 */
    lastEarlyWakeAt: base.now - 30_000,
  });
  assert.equal(v.wake, false, '★ 距上次唤醒太近时必须挡住');
  assert.ok(v.reason.includes('死循环'), '理由要说清这是防死循环');
});

test('★ 最小间隔之外可以再次唤醒', () => {
  const v = shouldEarlyWake({
    ...base,
    lastEarlyWakeAt: base.now - 4 * 60_000,
  });
  assert.equal(v.wake, true, '过了最小间隔就该恢复正常唤醒');
});

test('★★ 有一轮正在执行时不打断（否则会把轮次切碎）', () => {
  const v = shouldEarlyWake({ ...base, cycleInFlight: true });
  assert.equal(v.wake, false, '★ 正在跑一轮时不重排');
});

test('★ 机器人没在跑 → 不唤醒', () => {
  const v = shouldEarlyWake({ ...base, running: false });
  assert.equal(v.wake, false);
});

test('★★ 只提前不推后：原定周期本来就快到了 → 不重排', () => {
  /*
   * 原定 20 秒后就要跑，而唤醒的目标延迟是 45 秒 ——
   * 重排反而会**推后**它。这条闸门保证"唤醒"不会变成"延迟"。
   */
  const v = shouldEarlyWake({ ...base, nextCycleAt: base.now + 20_000 });
  assert.equal(v.wake, false, '★ 不能把本来就快的周期推后');
});

test('★ 没有排期（`nextCycleAt` 为 null）→ 唤醒', () => {
  /*
   * `null` 表示"当前没有下一次排期"（可能刚跑完还没排）。
   * 这种情况下应当唤醒 —— 否则成交之后可能一直没人管。
   */
  const v = shouldEarlyWake({ ...base, nextCycleAt: null });
  assert.equal(v.wake, true);
});

test('★★ 被挡下时返回的原因不为空（可诊断）', () => {
  /*
   * 被挡下**不写日志**（那会在行情剧烈时刷屏），所以原因字符串是唯一的
   * 诊断线索 —— 它至少要在测试里立得住，将来接调试输出时才有东西可打。
   */
  const cases = [
    { ...base, running: false },
    { ...base, mode: 'ai_managed' },
    { ...base, cycleInFlight: true },
    { ...base, lastEarlyWakeAt: base.now - 1_000 },
    { ...base, nextCycleAt: base.now + 1_000 },
  ];
  for (const c of cases) {
    const v = shouldEarlyWake(c);
    assert.equal(v.wake, false);
    assert.ok(v.reason.length > 0, '★ 挡下时必须给出原因');
  }
});
