/**
 * 「平仓结果」文案的口径（外部 issue #144，真实资金）。
 *
 * ## 这个测试防的是什么
 *
 * `closeAllPositions` 的前端类型原来**漏了服务端的 `failed` 字段**，
 * 消费点（`TraderTables` 的 `setResult`）也顺手没拷它。于是「全部平仓」里
 * **部分标的平仓失败**时，界面照样渲染绿色成功横幅 ——
 * 操作员以为清仓完成就离开，而**敞口仍在裸奔**。
 *
 * 而「全部平仓」是本项目最不能出错的操作之一：主动清仓 = 避险动作。
 *
 * 所以这里钉住的核心不变量是：**只要有标的没平掉，语气就不能是成功**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeClose, type CloseResult } from './closeSummary';

function result(over: Partial<CloseResult> = {}): CloseResult {
  return { closed: [], stillRunning: false, ...over };
}

test('★ 有标的平仓失败时，语气必须是 danger 且主句数得出来（不能说"已全部平仓"）', () => {
  /*
   * 这是本 issue 的原始场景：3 个持仓，2 个平掉、1 个失败。
   * 修复前界面显示"已平仓：BTCUSDT、ETHUSDT。"（绿色），
   * 操作员看不出 SOLUSDT 还在。
   */
  const summary = summarizeClose(
    result({
      closed: ['BTCUSDT', 'ETHUSDT'],
      failed: [{ symbol: 'SOLUSDT', error: '名义价值低于交易所下限' }],
      stillRunning: false,
    }),
  );

  assert.equal(summary.tone, 'danger', '★ 有失败就不能是成功语气');
  assert.match(summary.headline, /2 个已平/, '主句要说出平掉了几个');
  assert.match(summary.headline, /1 个平仓失败/, '主句要说出失败几个');
  assert.equal(summary.failed.length, 1, '失败明细必须带出来给调用点逐条渲染');
  assert.equal(summary.failed[0]!.symbol, 'SOLUSDT');
  assert.equal(summary.failed[0]!.error, '名义价值低于交易所下限');
});

test('★ 主句绝不能出现"已全部平仓"这类断言 —— 即使只有一个失败', () => {
  /*
   * 措辞层面的守卫：语气对了但文案还说"全部"仍然是自相矛盾。
   * 这类"数字对、说法错"的界面问题在本项目出现过多次
   *（见 `scripts/ui-consistency.mjs` 的头部注释）。
   */
  const summary = summarizeClose(
    result({ closed: ['AUSDT'], failed: [{ symbol: 'BUSDT', error: 'x' }], stillRunning: false }),
  );
  assert.ok(
    !/全部/.test(summary.headline) || /失败/.test(summary.headline),
    `★ 主句说"全部"时必须同时说清失败。实际：${summary.headline}`,
  );
});

test('★ 一个都没平掉、但全失败 → 仍是 danger（不能退化成"没有持仓"）', () => {
  const summary = summarizeClose(
    result({
      closed: [],
      failed: [
        { symbol: 'AUSDT', error: '网络超时' },
        { symbol: 'BUSDT', error: '网络超时' },
      ],
      stillRunning: false,
    }),
  );
  assert.equal(summary.tone, 'danger', '全失败是最坏的情况，语气必须最重');
  assert.match(summary.headline, /0 个已平/);
  assert.match(summary.headline, /2 个平仓失败/);
});

test('没有失败、确实平掉了 → success', () => {
  const summary = summarizeClose(result({ closed: ['BTCUSDT'], stillRunning: false }));
  assert.equal(summary.tone, 'success');
  assert.match(summary.headline, /已平仓：BTCUSDT/);
  assert.equal(summary.failed.length, 0);
});

test('没有失败、也没平掉任何东西 → neutral（"没有持仓"不是成功也不是失败）', () => {
  const summary = summarizeClose(result({ closed: [], cancelledPending: 0, stillRunning: false }));
  assert.equal(summary.tone, 'neutral');
  assert.match(summary.headline, /没有需要平掉的持仓/);
});

test('撤掉的挂单张数要如实出现在主句里', () => {
  /*
   * 撤挂单是"把敞口收回来"的一部分 —— 操作员看不到它就会以为没生效
   *（2026-10-02 用户报告过"不作用于委托挂单"）。
   */
  const summary = summarizeClose(
    result({ closed: ['BTCUSDT'], cancelledPending: 3, stillRunning: false }),
  );
  assert.equal(summary.tone, 'success');
  assert.match(summary.headline, /已撤掉 3 张等待成交的挂单/);
});

test('只有挂单、没有持仓时也算做了事（不是 neutral）', () => {
  const summary = summarizeClose(result({ closed: [], cancelledPending: 2, stillRunning: false }));
  assert.equal(summary.tone, 'success', '撤了挂单就是收回了敞口，不该说"没有需要平掉的"');
  assert.match(summary.headline, /已撤掉 2 张/);
});

test('失败时撤单张数也要报出来（三个数字一起给，才看得全）', () => {
  const summary = summarizeClose(
    result({
      closed: ['AUSDT'],
      cancelledPending: 4,
      failed: [{ symbol: 'BUSDT', error: 'x' }],
      stillRunning: false,
    }),
  );
  assert.equal(summary.tone, 'danger');
  assert.match(summary.headline, /1 个已平/);
  assert.match(summary.headline, /1 个平仓失败/);
  assert.match(summary.headline, /已撤 4 张挂单/);
});

test('failed 缺省（单标的平仓那条路径）不报错，也不被当成失败', () => {
  /*
   * `closePosition`（单标的）返回 `{ ok, avgPrice, fee, stillRunning }` ——
   * 它没有批量失败的概念，类型是对的（issue 的备注也这么说）。
   * 所以 `failed` 必须是**可选**的，缺省时按"没有失败"处理。
   */
  const summary = summarizeClose({ closed: ['BTCUSDT'], stillRunning: true });
  assert.equal(summary.tone, 'success');
  assert.equal(summary.failed.length, 0);
});
