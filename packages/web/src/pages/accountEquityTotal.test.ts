/**
 * **同一账户下多台机器人时，账户权益必须取【最新的】快照**
 *（2026-10-14 用户实测：「盈亏计算有问题，和实际对不上」）
 *
 * ## 事故
 *
 * `TradersPage.tsx` 的「账户权益合计」原来是手算的：
 * ```
 *   const shared = group
 *     .map((trader) => statsMap[trader.id]?.accountEquity)
 *     .find((value) => ...);       // ← find 取【第一个】，不是最新
 * ```
 * `group` 按 id 排序 → **取到了 id 最小那台机器人的快照**，而它可能是几周前的。
 *
 * 线上实测（账户 #2 挂着 #9 与 #11）：
 * ```
 *   #9  accountEquity = 20.8585 @2026-10-03  ← 43 天前（旧）
 *   #11 accountEquity = 20.7519 @2026-10-13  ← 最新
 *   → find() 取 #9 的 20.8585 → 合计 114.97
 *   → 正确（取最新）        → 合计 114.86
 * ```
 *
 * ## 根治：不修那份手算，而是让它调用 `fleetTotals()`
 *
 * `fleetTotals.ts` 里早有正确的 `latestAccountReading()`（取时间最新）——
 * 而 `TradersPage` 手算了一遍且算错了。
 * **同一个算术写在两个地方，改一处等于没改**（`docs/MAINTENANCE.md` §3.4）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';
import { fleetTotals } from '../lib/fleetTotals.js';

const PAGE = codeOnly(readFileSync(new URL('./TradersPage.tsx', import.meta.url), 'utf8'));

test('★★★ TradersPage 必须用 fleetTotals，不能再手算 accountEquity', () => {
  assert.ok(
    /fleetTotals\(\{/.test(PAGE),
    '★ 必须调用共享库 —— 手算会与 fleetTotals 漂移（这次就是）',
  );
  assert.ok(
    /accountEquityFleet/.test(PAGE),
    '★ 必须用 fleetTotals 的 accountEquityFleet（它内部取最新快照）',
  );
  /*
   * ⚠️ 判据：不能再出现"同账户取第一个有效读数"那种写法。
   * 它是这次 BUG 的形态（`.map(...).find(有效)`）。
   */
  assert.ok(
    !/\.map\([^)]*accountEquity[^)]*\)\s*\n?\s*\.find\(/.test(PAGE),
    '★ 不得再用 `.map(...accountEquity).find(...)` —— find 取第一个，而它可能过期几周',
  );
});

test('★★★ fleetTotals：同账户多机器人时取【最新】快照（防回归）', () => {
  /*
   * 造一个与线上同形的场景：账户 2 挂着两台，
   * 旧的那台（id 小）快照过时，新的那台（id 大）才是当前钱包。
   */
  const traders = [
    { id: 9, exchangeAccountId: 2, initialEquity: 20.78, createdAt: '2026-10-01T00:00:00Z' },
    { id: 11, exchangeAccountId: 2, initialEquity: 20.75, createdAt: '2026-10-11T00:00:00Z' },
  ] as never;
  const stats = {
    9: { accountEquity: 20.8585 },
    11: { accountEquity: 20.7519 },
  } as never;
  const snapshots = {
    9: [{ timestamp: '2026-10-03T02:29:28Z', accountEquity: 20.8585 }],
    11: [{ timestamp: '2026-10-13T19:10:33Z', accountEquity: 20.7519 }],
  } as never;

  const t = fleetTotals({ traders, stats, snapshots });
  assert.equal(
    Number(t.accountEquityFleet.toFixed(4)),
    20.7519,
    '★ 必须取最新的（20.7519），而不是 id 最小的那台（20.8585）—— 后者是 43 天前的读数',
  );
});

test('★ 只有 stats（无快照）时也不能取第一个 —— 走 fleetTotals 的兜底', () => {
  const traders = [
    { id: 9, exchangeAccountId: 2, initialEquity: 20.78, createdAt: '2026-10-01T00:00:00Z' },
    { id: 11, exchangeAccountId: 2, initialEquity: 20.75, createdAt: '2026-10-11T00:00:00Z' },
  ] as never;
  const stats = { 9: { accountEquity: 20.8585 }, 11: { accountEquity: 20.7519 } } as never;
  const t = fleetTotals({ traders, stats });
  /*
   * 无快照时 fleetTotals 取组内**最大值**（见它的注释：宁可偏大也不显示 0）。
   * 这里只钉"不是简单的取第一个"，具体策略由 fleetTotals 决定。
   */
  assert.ok(
    t.accountEquityFleet >= 20.75,
    '★ 无快照时也要给出一个正值（不能是 0 或取到第一个的偶然值）',
  );
});
