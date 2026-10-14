/**
 * **模拟交易所的止损跳空必须按开盘价成交**（外部 issue #150 / #153）。
 *
 * ## 这个测试防的是什么
 *
 * `simulatedExchange.ts:193-199` 的注释承诺：
 *
 *     // A gap through the stop fills at the open, not at the stop price —
 *     // the slippage is real and worth modelling.
 *     const fillPrice = isLong
 *       ? Math.min(stop.price, step.open > stop.price ? step.open : stop.price)
 *       : Math.max(stop.price, step.open < stop.price ? step.open : stop.price);
 *
 * 而那两个三元表达式**恒等于 `stop.price`**：
 *
 *   · 多头：`open > stop` 时 `min(stop, open) = stop`；否则 `min(stop, stop) = stop`
 *   · 空头：对称地同样恒为 `stop.price`
 *
 * 也就是**注释承诺了跳空滑点，实现一步都没走** —— 止损跳空亏损被系统性低估，
 * 回测因此偏向"策略很好看"。这不是精度问题，是**模拟器的结论方向错了**。
 *
 * ## 为什么这条测试必须走真实路径而不是复制那段算术
 *
 * 复制那段三元表达式到测试里，被测的是**复制品**：将来实现改了、测试还是绿的
 *（本仓库对"两处各写一份"有成文的警惕）。所以这里走完整的
 * `placeOrder(市价开仓) → placeOrder(挂止损) → advance(跳空 K 线)`，
 * 断言的是**成交价**这个外部可观察结果。
 *
 * ## ⚠️ 为什么默认的 `npm run sim` 抓不到它
 *
 * 确定性夹具 `syntheticCandles.ts:150-152` 刻意让 `open = 上一根的 close`（**无跳空**），
 * 所以默认 sim 根本走不到这条分支；只有 `--real-market` / `sim:live`（真实 K 线）才会踩到。
 * 这正是它长期潜伏的原因 —— 而"默认夹具无跳空"是**有意的**
 *（为了让 sim 的输出可复现），所以缺陷不能被 sim 兜住，必须单独测。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SymbolRegistry } from '../binance/symbols.js';
import type { BinanceExchangeInfo } from '../binance/types.js';
import { SimulatedExchange } from './simulatedExchange.js';

/** 一个最小 exchangeInfo —— tick 取 0.01，够挂止损。 */
function exchangeInfo(): BinanceExchangeInfo {
  return {
    exchangeFilters: [],
    rateLimits: [],
    serverTime: 0,
    symbols: [
      {
        symbol: 'BTCUSDT',
        pair: 'BTCUSDT',
        contractType: 'PERPETUAL',
        deliveryDate: 0,
        status: 'TRADING',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        pricePrecision: 2,
        quantityPrecision: 3,
        baseAssetPrecision: 8,
        quotePrecision: 8,
        underlyingType: 'COIN',
        orderTypes: [],
        timeInForce: [],
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
          { filterType: 'MIN_NOTIONAL', notional: '50' },
        ],
      },
    ],
  } as unknown as BinanceExchangeInfo;
}

function makeExchange(): SimulatedExchange {
  return new SimulatedExchange({
    registry: SymbolRegistry.fromExchangeInfo(exchangeInfo()),
    startingBalance: 100_000,
    takerFeeRate: 0,
    triggerMode: 'intrabar',
  });
}

/** 推进一根 K 线（开高低收都给定，方便构造跳空）。 */
function candle(ex: SimulatedExchange, open: number, high: number, low: number, close: number, at: number): void {
  ex.advance({ at, symbol: 'BTCUSDT', open, high, low, close });
}

test('★★★ 多头止损遇跳空：成交价必须是开盘价，不是触发价', () => {
  const ex = makeExchange();

  /* ① 市价开多，入场 100。 */
  candle(ex, 100, 100, 100, 100, 1_000);
  return ex
    .placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 })
    .then(async () => {
      /* ② 挂止损在 95（低于现价，合法）。 */
      await ex.placeOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        quantity: 1,
        triggerPrice: 95,
        closePosition: true,
      });

      /*
       * ③ 推一根**向下跳空**的 K 线：open=90 直接跳过止损 95。
       *
       * 现实里这时止损单以**开盘价 90** 成交（滑点 5 点）。
       * 而修复前的实现会以 `stop.price = 95` 成交 —— 少算 5 点亏损。
       */
      candle(ex, 90, 92, 88, 91, 2_000);

      const exit = ex.log_.filter((f) => f.purpose === 'stop_loss');
      assert.equal(exit.length, 1, '止损应当被触发一次');
      assert.equal(
        exit[0]!.price,
        90,
        `★ 跳空穿止损必须按开盘价 90 成交（现实如此），` +
          `而修复前恒以触发价 95 成交 —— 那会系统性低估止损滑点`,
      );
    });
});

test('★★★ 空头止损遇向上跳空：成交价也必须是开盘价', () => {
  const ex = makeExchange();

  candle(ex, 100, 100, 100, 100, 1_000);
  return ex
    .placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 1 })
    .then(async () => {
      /* 空头止损在 105（高于现价，合法）。 */
      await ex.placeOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'STOP_MARKET',
        quantity: 1,
        triggerPrice: 105,
        closePosition: true,
      });

      /* 向上跳空：open=110 直接跳过 105 —— 应以 110 成交。 */
      candle(ex, 110, 112, 108, 109, 2_000);

      const exit = ex.log_.filter((f) => f.purpose === 'stop_loss');
      assert.equal(exit.length, 1, '空头止损应当被触发一次');
      assert.equal(
        exit[0]!.price,
        110,
        '★ 空头向上跳空同样要按开盘价成交（方向是镜像的，逻辑不能只修一半）',
      );
    });
});

test('★ 没有跳空时仍按触发价成交 —— 修跳空不能改掉正常的日内触发', () => {
  /*
   * 反向守卫：修复必须只影响"跳空"那一种情形。
   * 若无跳空地跌破止损（开盘在上面、盘中最低触及），成交价仍是触发价。
   */
  const ex = makeExchange();

  candle(ex, 100, 100, 100, 100, 1_000);
  return ex
    .placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 })
    .then(async () => {
      await ex.placeOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        quantity: 1,
        triggerPrice: 95,
        closePosition: true,
      });

      /* 开 99（在止损之上）、盘中最低 94 触及止损 —— 无跳空。 */
      candle(ex, 99, 99, 94, 96, 2_000);

      const exit = ex.log_.filter((f) => f.purpose === 'stop_loss');
      assert.equal(exit.length, 1);
      assert.equal(
        exit[0]!.price,
        95,
        '★ 无跳空时成交价就是触发价 —— 不要为了修跳空把这个也改了',
      );
    });
});
