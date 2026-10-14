/**
 * **`tickSize` < 1e-6 时 `stepDecimals` 必须仍能读出精度**（外部 issue #136）。
 *
 * ## 缺陷经过
 *
 * `symbols.ts:97` 在构建 `SymbolInfo` 时把 tick 转成了 `Number`：
 *
 * ```ts
 * tickSize: Number(tickSize),      // "0.0000001" → 1e-7
 * ```
 *
 * 而调用点又把它转回字符串再解析精度（`symbols.ts:220`）：
 *
 * ```ts
 * roundPrice(price, info.tickSize, stepDecimals(String(info.tickSize)), …)
 * ```
 *
 * `String(1e-7)` 是 **`"1e-7"`** —— 科学计数法，**没有小数点**，于是：
 *
 * ```
 * stepDecimals("0.0000001")  →  7   ✅（直接传原串时正确）
 * stepDecimals(String(1e-7)) →  0   ❌（经 Number 往返后变成 "1e-7"）
 * ```
 *
 * 精度变成 0 之后，`roundPrice` / `roundTriggerPrice` 对**任何**价格都返回 0。
 *
 * ## 为什么这是"会花掉真钱"的（issue #136 已证实）
 *
 * 实测（`1000PEPEUSDT` 的真实参数 `tickSize=1e-7`）：
 *
 * ```
 * roundTriggerPrice(0.0061234…) = 0
 * STOP_MARKET 保护单 → THROWS「触发价 0 会立即触发…已拒绝下单」   ← 止损挂不上
 * LIMIT 入场单       → placed: price = 0                          ← 挂单价归零
 * ```
 *
 * 止损挂不上 → `requireStopLoss` 为真 → `autoTrader` **立即市价平掉该仓位**
 *（`docs/AGENTS.md` §2.6：没有保护的杠杆仓位是最糟的状态，宁可立刻退出）。
 * 于是每次尝试都白付一次开 + 平的 taker 手续费与滑点。
 *
 * ## 为什么既有测试抓不到
 *
 * `orders.test.ts:480-486` 的用例最细到 `'0.00001'`（1e-5）——
 * **没有任何 < 1e-6 的覆盖**，而那正是 `String()` 开始输出科学计数法的地方。
 * 所以本文件既钉边界值，也钉**真实合约的完整参数**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { roundPrice, stepDecimals, SymbolRegistry } from './symbols.js';
import type { BinanceExchangeInfo } from './types.js';

test('★★★ stepDecimals 必须认得科学计数法 —— String(1e-7) 是 "1e-7" 而不是小数', () => {
  /*
   * 这两组必须**给出同一个答案** —— 它们描述的是同一个 tick。
   * 左边是 exchangeInfo 里的原串，右边是经 `Number()` 往返之后的形态。
   */
  const pairs: Array<[string, number]> = [
    ['0.0000001', 7], // 1e-7
    ['0.00000001', 8], // 1e-8
    ['0.000001', 6], // 1e-6 —— 恰好还输出小数形式，既有用例覆盖到这
  ];

  for (const [literal, expected] of pairs) {
    assert.equal(stepDecimals(literal), expected, `直接传原串 "${literal}"`);

    const roundTripped = String(Number(literal));
    assert.equal(
      stepDecimals(roundTripped),
      expected,
      `★★★ 经 Number 往返后的 "${roundTripped}"（来自 "${literal}"）也必须读出 ${expected} 位 —— ` +
        `否则 roundPrice/roundTriggerPrice 会把价格取整成 0，止损挂不上（issue #136）`,
    );
  }
});

test('★★★ 既有行为一字不变 —— 修科学计数法不能改掉普通小数的解析', () => {
  /* `orders.test.ts:480-486` 那组，逐条抄来当反向守卫。 */
  assert.equal(stepDecimals('0.001'), 3);
  assert.equal(stepDecimals('0.10'), 1);
  assert.equal(stepDecimals('1'), 0);
  assert.equal(stepDecimals('10'), 0);
  assert.equal(stepDecimals('1.000'), 0);
  assert.equal(stepDecimals('0.00001'), 5);
  /* 整数与带尾零的形态。 */
  assert.equal(stepDecimals('100'), 0);
  assert.equal(stepDecimals('0.100'), 1, '尾零不算精度');
});

test('★★★ 真实合约参数：1000PEPEUSDT 的 tickSize=1e-7 必须能取整出非零价格', () => {
  /*
   * 这是 issue #136 实测的那个合约。用完整链路（SymbolRegistry → roundTriggerPrice）
   * 而不是只调 stepDecimals —— 因为缺陷发生在"转 Number 再转回 String"的**往返**上，
   * 只测纯函数会漏掉那一环。
   */
  const info = {
    exchangeFilters: [],
    rateLimits: [],
    serverTime: 0,
    symbols: [
      {
        symbol: '1000PEPEUSDT',
        pair: '1000PEPEUSDT',
        contractType: 'PERPETUAL',
        deliveryDate: 0,
        status: 'TRADING',
        baseAsset: '1000PEPE',
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        pricePrecision: 7,
        quantityPrecision: 0,
        baseAssetPrecision: 8,
        quotePrecision: 8,
        underlyingType: 'COIN',
        orderTypes: [],
        timeInForce: [],
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.0000001' },
          { filterType: 'LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '100000000' },
          { filterType: 'MIN_NOTIONAL', notional: '5' },
        ],
      },
    ],
  } as unknown as BinanceExchangeInfo;

  const registry = SymbolRegistry.fromExchangeInfo(info);

  assert.equal(registry.priceDecimals('1000PEPEUSDT'), 7, '★ priceDecimals 必须是 7');

  /*
   * 一个真实量级的价格（PEPE 在 0.006 附近）。
   * 修复前这三个都会返回 0 —— 而 0 触发价会被交易所拒绝（-2021）或直接挂不上。
   */
  const trigger = registry.roundTriggerPrice('1000PEPEUSDT', 0.0061234, 'STOP_MARKET', 'SELL', 0.0065);
  assert.ok(trigger > 0, `★ roundTriggerPrice 必须 > 0，实际 ${trigger}`);
  assert.equal(trigger, 0.0061234, '按 tick 取整后应保持这个量级');

  const limit = registry.roundLimitPrice('1000PEPEUSDT', 0.0069876);
  assert.ok(limit > 0, `★ roundLimitPrice 必须 > 0，实际 ${limit}`);

  /* 取整结果必须是 tick 的整数倍（这是"精度真的对了"的判据）。 */
  const tick = 1e-7;
  const multiple = trigger / tick;
  assert.ok(
    Math.abs(multiple - Math.round(multiple)) < 1e-6,
    `★ 取整结果 ${trigger} 必须是 tick ${tick} 的整数倍`,
  );
});

test('★★ 所有实际 tickSize 取值都要能取整出非零价格 —— 防"下一个更细的 tick"重演', () => {
  /*
   * 币安上真实存在的 tick 精度（USDT 永续：最低到 1e-8）。
   * 这条用例的意义是：**将来出现更细的 tick 时，这里会先红** ——
   * 而不是等到某台机器人止损挂不上才发现。
   */
  const ticks = ['0.1', '0.01', '0.001', '0.0001', '0.00001', '0.000001', '0.0000001', '0.00000001'];

  for (const tickSize of ticks) {
    const info = {
      exchangeFilters: [],
      rateLimits: [],
      serverTime: 0,
      symbols: [
        {
          symbol: 'TESTUSDT',
          pair: 'TESTUSDT',
          contractType: 'PERPETUAL',
          deliveryDate: 0,
          status: 'TRADING',
          baseAsset: 'TEST',
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          pricePrecision: 8,
          quantityPrecision: 0,
          baseAssetPrecision: 8,
          quotePrecision: 8,
          underlyingType: 'COIN',
          orderTypes: [],
          timeInForce: [],
          filters: [
            { filterType: 'PRICE_FILTER', tickSize },
            { filterType: 'LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '100000000' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        },
      ],
    } as unknown as BinanceExchangeInfo;

    const registry = SymbolRegistry.fromExchangeInfo(info);
    const price = Number(tickSize) * 1000; // 一个远大于 tick 的价格

    const rounded = roundPrice(price, Number(tickSize), registry.priceDecimals('TESTUSDT'), 'down');
    assert.ok(
      rounded > 0,
      `★★ tickSize=${tickSize} 时取整结果必须是正数，实际 ${rounded} ` +
        `（0 意味着止损/限价挂不上去 —— issue #136 的真实后果）`,
    );
    assert.ok(
      registry.roundTriggerPrice('TESTUSDT', price, 'STOP_MARKET', 'SELL', price * 1.01) > 0,
      `★★ tickSize=${tickSize} 时触发价必须是正数`,
    );
  }
});
