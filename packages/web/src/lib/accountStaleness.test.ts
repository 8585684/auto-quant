/**
 * **过期的账户读数不能冒充实时值**（2026-10-14）
 *
 * ## 事故背景
 *
 * `#9` 与 `#11` 共用账户 #2，而 **`#9` 已停止 10 天**、快照是 **43 天前**的。
 * 修复"取第一个 → 取最新"之后，只要同账户下还有一台在跑就读到新鲜值。
 *
 * ⚠️ **但两台都停了之后呢？** 那时"最新"也是 43 天前的 ——
 * 而页面会把它当成"账户现在的钱"显示。
 * 那正是 `LAYOUT.md` §7 禁止的"文字说的不是事实"：
 * **一个过期 43 天的数字看起来和实时值一模一样。**
 *
 * ## 判据
 *
 * ```
 *   读数距现在 > 60 分钟 → accountEquityStale = true
 *   （60 分钟 = 最慢那档周期 30 分钟的两倍 —— 连着两轮没写新快照）
 * ```
 *
 * ⚠️ **只有快照来源才判过期**：stats / derived 两条来源没有可比时刻，
 * 标它们"过期"是假告警（本项目反复踩过这一类）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fleetTotals } from './fleetTotals.js';

const TRADERS = [
  { id: 9, exchangeAccountId: 2, initialEquity: 20.78, createdAt: '2026-10-01T00:00:00Z' },
] as never;

/** 造一条距今 `minutesAgo` 分钟的快照。 */
function snapshotsAt(minutesAgo: number, accountEquity = 20.75): never {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { 9: [{ timestamp: ts, accountEquity }] } as never;
}

test('★★★ 新鲜快照（5 分钟前）→ 不标过期', () => {
  const t = fleetTotals({ traders: TRADERS, stats: {} as never, snapshots: snapshotsAt(5) });
  assert.equal(t.accounts[0]!.accountEquityStale, false, '★ 5 分钟前的读数是新鲜的');
  assert.ok(t.accounts[0]!.accountEquityAtMs !== null, '★ 必须记下读数时刻');
});

test('★★★ 过期快照（43 天前，即 #9 的真实情况）→ 必须标过期', () => {
  const t = fleetTotals({
    traders: TRADERS,
    stats: {} as never,
    snapshots: snapshotsAt(43 * 24 * 60),
  });
  assert.equal(
    t.accounts[0]!.accountEquityStale,
    true,
    '★ 43 天前的读数必须标过期 —— 否则它会冒充"账户现在的钱"',
  );
});

test('★★★ 边界：59 分钟不过期、61 分钟过期（判据是 60 分钟）', () => {
  const fresh = fleetTotals({ traders: TRADERS, stats: {} as never, snapshots: snapshotsAt(59) });
  assert.equal(fresh.accounts[0]!.accountEquityStale, false, '★ 59 分钟仍在容忍内（周期 30 分钟的两倍内）');

  const stale = fleetTotals({ traders: TRADERS, stats: {} as never, snapshots: snapshotsAt(61) });
  assert.equal(stale.accounts[0]!.accountEquityStale, true, '★ 61 分钟必须标过期');
});

test('★★★ 不是快照来源时【不判过期】（stats / derived 没有可比时刻）', () => {
  /*
   * ⚠️ 假告警也是 bug：`stats` 与 `derived` 两条来源没有"读数时刻"，
   * 把它们标成"过期"会让页面在正常运行时闪警告。
   */
  const t = fleetTotals({
    traders: TRADERS,
    stats: { 9: { accountEquity: 20.75 } } as never,
  });
  assert.equal(t.accounts[0]!.accountEquityStale, false, '★ stats 来源不判过期（无时刻可比）');
  assert.equal(t.accounts[0]!.accountEquityAtMs, null, '★ 无快照时时刻是 null');
});

test('★ 多账户：只有一个过期时，另一个不受影响', () => {
  const traders = [
    { id: 9, exchangeAccountId: 2, initialEquity: 20.78, createdAt: '2026-10-01T00:00:00Z' },
    { id: 10, exchangeAccountId: 3, initialEquity: 100.05, createdAt: '2026-10-03T00:00:00Z' },
  ] as never;
  const now = Date.now();
  const snapshots = {
    9: [{ timestamp: new Date(now - 43 * 24 * 3600_000).toISOString(), accountEquity: 20.75 }],
    10: [{ timestamp: new Date(now - 3 * 60_000).toISOString(), accountEquity: 94.16 }],
  } as never;
  const t = fleetTotals({ traders, stats: {} as never, snapshots });
  const byId = new Map(t.accounts.map((a) => [a.exchangeAccountId, a]));
  assert.equal(byId.get(2)!.accountEquityStale, true, '★ 账户 #2 过期');
  assert.equal(byId.get(3)!.accountEquityStale, false, '★ 账户 #3 新鲜 —— 不能因为别人过期就一起标');
});
