/**
 * Candlestick chart wrapper.
 *
 * The chart instance is created once per mount and the series data is swapped on
 * every update — recreating the chart on each poll would reset the user's pan and
 * zoom, which is exactly the wrong behaviour in a live terminal.
 *
 * `lightweight-charts` is imported here and **nowhere else** outside a lazy
 * route chunk: it is the second-largest dependency in the app, and the
 * overview/login pages must not pay for it. Anything that needs candles must go
 * through this component (or another lazy import), never a static import from
 * the entry graph.
 */
import { useEffect, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Kline } from '@aq/shared';
import { useChartInk } from './useChartInk';

export function CandlestickChart({
  candles,
  height = 460,
  loading = false,
}: {
  candles: Kline[];
  height?: number;
  /** Render the "no data yet" copy only once the first fetch has settled. */
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /*
   * 当前外观下的配色。**换模板或切深浅时它会变**，而下面两个 effect 都依赖
   * 它 —— 所以图表会跟着重画，不会停在上一套主题的绿上（见 `useChartInk`）。
   */
  const ink = useChartInk();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        /*
         * lightweight-charts 在自己的 canvas 层里画，颜色只能是字符串 ——
         * 与 `equityCurve.ts` 里的 `CHART_INK` 是同一个例外，这里也统一
         * 走 `ink`（它按当前模板与深浅实时取色）。
         *
         * 用 `inkMid` 而不是 `axis`：这些是压在网格上的**价格数字**，
         * 用刻度线那一档的灰在 11px 上读不清 —— 而交易台的屏幕亮度通常
         * 只开到一半。
         */
        textColor: ink.inkMid,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        // `base-750`: one step off the panel, so the grid organises without
        // competing with the candles for attention.
        vertLines: { color: ink.grid },
        horzLines: { color: ink.grid },
      },
      rightPriceScale: {
        borderColor: ink.grid,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: ink.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        // A minimum bar spacing keeps a 3-bar window from stretching each candle
        // into a slab that looks like a different timeframe.
        minBarSpacing: 2,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: ink.rule, labelBackgroundColor: ink.track, width: 1 },
        horzLine: { color: ink.rule, labelBackgroundColor: ink.track, width: 1 },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: {
        priceFormatter: (price: number) =>
          price.toLocaleString('en-US', {
            minimumFractionDigits: price >= 1000 ? 2 : price >= 1 ? 3 : 6,
            maximumFractionDigits: price >= 1000 ? 2 : price >= 1 ? 3 : 6,
          }),
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: ink.up,
      downColor: ink.down,
      borderUpColor: ink.up,
      borderDownColor: ink.down,
      wickUpColor: ink.up,
      wickDownColor: ink.down,
      priceLineColor: ink.accent,
      priceLineStyle: LineStyle.Dashed,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    /*
     * ⚠️ **依赖里没有 `ink`**，这是刻意的。
     *
     * 把 `ink` 放进来会让"换模板"变成"重建图表" —— 而重建会**丢掉用户
     * 当前的缩放与平移位置**（本文件顶部那段注释正是说这件事：重建是
     * 实时终端里最不该发生的行为）。
     *
     * 外观变化的处理放在下面那个 `applyOptions` 的 effect 里：换配色不需要
     * 换图表，只需要把新的颜色**应用**上去。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  /*
   * 外观（模板 / 深浅）变化时，把新配色**应用**到已有的图表与序列上。
   *
   * 用 `applyOptions` 而不是重建：用户在这里可能已经缩放到某个区间，
   * 重建会把他拨回去（见上面那段注释）。`applyOptions` 只换颜色，
   * 视口与数据一个都不动。
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    chart.applyOptions({
      layout: { textColor: ink.inkMid },
      grid: { vertLines: { color: ink.grid }, horzLines: { color: ink.grid } },
      rightPriceScale: { borderColor: ink.grid },
      timeScale: { borderColor: ink.grid },
      crosshair: {
        vertLine: { color: ink.rule, labelBackgroundColor: ink.track },
        horzLine: { color: ink.rule, labelBackgroundColor: ink.track },
      },
    });
    series.applyOptions({
      upColor: ink.up,
      downColor: ink.down,
      borderUpColor: ink.up,
      borderDownColor: ink.down,
      wickUpColor: ink.up,
      wickDownColor: ink.down,
      priceLineColor: ink.accent,
    });
  }, [ink]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Binance klines carry `openTime` in milliseconds; lightweight-charts wants seconds.
    const data: CandlestickData<Time>[] = candles
      .map((candle) => ({
        time: Math.floor(candle.openTime / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));

    // Drop duplicate timestamps, which the series rejects.
    const deduped = data.filter((bar, index) => index === 0 || bar.time !== data[index - 1]?.time);
    series.setData(deduped);
  }, [candles]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {/*
       * Four states, not two: "still fetching" and "this symbol has no history
       * yet" look identical on a blank canvas but call for opposite reactions
       * from the operator, so they get different words.
       */}
      {candles.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-base text-ink-lo">{loading ? '正在加载K线…' : '该周期暂无K线数据'}</p>
          {!loading && <p className="text-xs text-ink-faint">换一个周期或交易对试试。</p>}
        </div>
      )}
    </div>
  );
}
