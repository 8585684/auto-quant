/**
 * **`minOpenInterestUsd` 必须真的参与筛选**（外部 issue #182）。
 *
 * ## 缺陷形状
 *
 * `minOpenInterestUsd`（界面「最小持仓量（USDT）」、schema 默认 5_000_000）：
 *
 * ```
 * service.ts:447   screenUniverse 的 options 里声明收下
 * service.ts:459   筛选循环只读 minQuoteVolume24h          ← 从不读 minOpenInterestUsd
 * service.ts:630   screenOpenInterestGrowth 转发给它        ← 转发了也没人读
 * autoTrader.ts:2969  写进给操作员的门槛提示                ← 拿它解释一个它没参与的结果
 * ```
 *
 * 全仓 `grep minOpenInterestUsd` 在 `service.ts` 里**只有 3 处**
 *（447 声明、620 声明、630 转发）—— **没有一处读取它做过滤**。
 *
 * ## 为什么这个洞落在最需要它的地方
 *
 * `screenOpenInterestGrowth` 的增长率是：
 *
 * ```ts
 * growth = (last - first) / first * 100
 * ```
 *
 * **分母（窗口起点持仓量）极小时，这个比值天然是噪声** —— 一点点资金进出就是 +300%。
 * 而"最小持仓量"这道护栏**本就是为了把这个路径的假信号挡住**而存在的。
 *
 * 讽刺的是那个函数**自己已经在读 `sumOpenInterest`**（`:641-642`），
 * 数据就在手里，只是没拿来比。
 *
 * ## 为什么抽成纯函数
 *
 * `MarketDataService` 要真实的网络与交易所客户端才能构造，而本文件要验证的是
 * "持仓量门槛有没有被应用"这一条判据。抽出来之后它可被单测 ——
 * 与 `screenSymbols`（`screening.ts`）是同一个做法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { filterByMinOpenInterest, growthPercent } from './screening.js';

test('★★★ 持仓量低于门槛的标的必须被剔除 —— 它此前从未生效', () => {
  const rows = [
    { symbol: 'BIGUSDT', openInterestUsd: 50_000_000 },
    { symbol: 'MIDUSDT', openInterestUsd: 8_000_000 },
    { symbol: 'TINYUSDT', openInterestUsd: 120_000 }, // ← 分母极小，growth% 是噪声
  ];

  const kept = filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol);
  assert.deepEqual(
    kept,
    ['BIGUSDT', 'MIDUSDT'],
    '★★★ 低于 `minOpenInterestUsd` 的必须被剔除 —— 此前这个参数被接收、被转发、' +
      '还被写进给操作员的提示，却从不参与筛选（issue #182）',
  );
});

test('★ 门槛为 0 时不做任何剔除 —— 那是"关掉这条规则"的既有约定', () => {
  const rows = [
    { symbol: 'A', openInterestUsd: 1 },
    { symbol: 'B', openInterestUsd: 0 },
  ];
  assert.deepEqual(
    filterByMinOpenInterest(rows, 0).map((r) => r.symbol),
    ['A', 'B'],
    '★ 门槛 0 = 不筛（与 `pendingEntryTimeoutMinutes = 0` 等同族字段的约定一致）',
  );
});

test('★ 恰好等于门槛的保留 —— 边界是"小于才剔除"', () => {
  const rows = [{ symbol: 'EDGE', openInterestUsd: 5_000_000 }];
  assert.deepEqual(filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol), ['EDGE']);
});

test('★ 非有限值（NaN/Infinity）必须被剔除 —— 它们不能被当成"通过了门槛"', () => {
  /*
   * ⚠️ 这一条是**保守方向**：`NaN < 门槛` 是 `false`，所以"直接比较"的写法会
   * **放过 NaN**。而一个读不到持仓量的标的恰恰是最不该进候选池的。
   */
  const rows = [
    { symbol: 'NAN', openInterestUsd: Number.NaN },
    { symbol: 'INF', openInterestUsd: Number.POSITIVE_INFINITY },
    { symbol: 'OK', openInterestUsd: 9_000_000 },
  ];
  assert.deepEqual(
    filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol),
    ['OK'],
    '★ NaN / Infinity 不能被当成"通过了门槛"',
  );
});

test('★★ growthPercent 在分母极小时是噪声 —— 这正是需要持仓量门槛的原因', () => {
  /*
   * 这条用例说明"为什么不能只靠 growth 排序"：
   * 两个标的的**绝对**增长量相同（都是 +1000 USDT），
   * 但分母极小那个算出 +1000%，分母大那个算出 +0.002%。
   *
   * 所以"最小持仓量"这道护栏的意义是：**先把分母太小的剔掉**，
   * 否则排名会被噪声主导。
   */
  const tiny = growthPercent(100, 1_100); // 分母 100
  const big = growthPercent(50_000_000, 50_001_000); // 分母 5000 万

  assert.ok(tiny > 900, `★ 分母极小时算出巨大百分比（实际 ${tiny}）—— 那是噪声`);
  assert.ok(big < 0.01, `★ 分母大时同一份绝对增长几乎不可见（实际 ${big}）`);

  /* 而同一条护栏下，tiny 会被剔除、big 会保留。 */
  const kept = filterByMinOpenInterest(
    [
      { symbol: 'TINY', openInterestUsd: 1_100 },
      { symbol: 'BIG', openInterestUsd: 50_001_000 },
    ],
    5_000_000,
  ).map((r) => r.symbol);
  assert.deepEqual(kept, ['BIG'], '★★ 持仓量门槛把"分母太小"的那个挡在外面');
});

test('★ growthPercent 的既有语义不变 —— 分母为 0 或负时返回 0 而不是 Infinity', () => {
  /*
   * 反向守卫：`(last-first)/first` 在 `first = 0` 时是 `Infinity`，
   * 而 `Infinity` 排序后会永远排第一 —— 一个读不到历史的标的不该登顶。
   */
  assert.equal(growthPercent(0, 100), 0, '分母 0 → 0，不是 Infinity');
  assert.equal(growthPercent(-5, 100), 0, '分母为负 → 0');
  assert.equal(growthPercent(100, 100), 0, '没有增长 → 0');
  assert.equal(growthPercent(100, 200), 100, '翻倍 → +100%');
  assert.equal(growthPercent(100, 50), -50, '减半 → -50%');
  /* 非有限输入同样归 0，而不是把 NaN 传下去。 */
  assert.equal(growthPercent(Number.NaN, 100), 0);
  assert.equal(growthPercent(100, Number.NaN), 0);
});
