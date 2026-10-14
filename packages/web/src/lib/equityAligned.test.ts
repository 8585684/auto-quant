/**
 * **列表页 / 详情页 / 首页必须给出同一个权益数**
 *（2026-10-14 用户报：「和里面数据不一致为什么还没修复？……列表和详情要正确对齐数字」）
 *
 * ## 用户看到的事实
 *
 * ```
 *   机器人列表页「归属权益」  $104.89
 *   机器人详情页「账户余额」  $92.34
 *   首页总览「归属权益」      $104.89
 *   差 12.56
 * ```
 *
 * ## 根因：`trades.net_pnl` 被对账重建写坏
 *
 * 线上 `#10` 实测：39 笔 `source='reconciled'` 的记录里 **16 笔 `pnl=0`**
 *（本该有盈亏），合计虚高 **9.13**。而「归属权益」的定义是
 * `起始权益 + net_pnl + 浮盈` —— 于是它虚高。
 *
 * ## ⚠️ 我第一版的修法是错的（这条要记住）
 *
 * 我只是在指标卡加了一行「账目与交易所差 +12.55」的**说明**，而没有改数字。
 * 用户当场指出：「别画蛇添足……别整无意义的垃圾数据」。
 *
 * 本项目反复记着同一条原则：
 * > **「把数字改对，比在说明里解释它为什么错要好。」**
 *
 * ## 修法：三处用**同一套判据**（详情页早就是这么做的）
 *
 * ```
 *   ledger.gap ≥ 0.01 → 用交易所的成交流水（exchangeNet）校准
 *   否则              → 用账本（它与交易所一致，没必要绕）
 * ```
 * ⚠️ 判据复制到三处而不是抽成共享模块（那超出本次改动范围）——
 * 但**不一致的代价更大**，所以本文件钉住"三处必须一致"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const LIST = readFileSync(new URL('../pages/TradersPage.tsx', import.meta.url), 'utf8');
const OVERVIEW = readFileSync(new URL('../pages/OverviewPage.tsx', import.meta.url), 'utf8');
const DETAIL = readFileSync(new URL('../pages/TraderPage.tsx', import.meta.url), 'utf8');

test('★★★ 机器人列表页必须用交易所校准值（不能直接显示 stats.equity）', () => {
  assert.ok(
    /const equityOf = \(trader: TraderRow, stats: TraderSummary\)/.test(LIST),
    '★ 列表页必须有 equityOf（按账本是否可信选口径）',
  );
  assert.ok(
    /trader\.ledger!\.exchangeNet \+ stats\.unrealizedPnl/.test(LIST),
    '★ 必须用 exchangeNet 校准（账本里的 net_pnl 是坏的）',
  );
  assert.ok(
    /Math\.abs\(trader\.ledger\.gap\) >= 0\.01/.test(LIST),
    '★ 判据阈值必须是 0.01 —— 与详情页一字不差',
  );
});

test('★★★ 首页总览必须用同一套校准（用户说"图4 也是一样"）', () => {
  assert.ok(
    /const suspect = trader\.ledger != null && Math\.abs\(trader\.ledger\.gap\) >= 0\.01/.test(OVERVIEW),
    '★ 首页的 equityOf 也必须按 gap 选口径',
  );
  assert.ok(
    /trader\.ledger!\.exchangeNet \+ stats\.unrealizedPnl/.test(OVERVIEW),
    '★ 首页也必须用 exchangeNet 校准',
  );
});

test('★★★ 详情页的判据没有被改坏（它是三处里最先正确的那一处）', () => {
  assert.ok(
    /const realized = ledgerSuspect \? ledger!\.exchangeNet : \(stats\?\.realizedPnl \?\? 0\)/.test(DETAIL),
    '★ 详情页仍必须用 exchangeNet（这是三处口径的基准）',
  );
  assert.ok(
    /const ledgerSuspect = ledger !== null && Math\.abs\(ledger\.gap\) >= 0\.01/.test(DETAIL),
    '★ 阈值必须是 0.01',
  );
});

test('★★★ 列表页不能再并列显示两个互相矛盾的数', () => {
  /*
   * ⚠️ 用户的原话：「别画蛇添足」—— 原来那一格是
   * ```
   *   $104.89        ← 归属权益
   *   账户 $92.34    ← 账户（第二个数）
   * ```
   * 两个数并列而没有解释，用户第一反应是"到底哪个是我的钱"。
   * 修法：只显示**一个**数（校准后的），共享钱包的事实交给
   * 「账户权益合计」那张卡（它按账户去重，那才是它该在的地方）。
   */
  assert.ok(
    !/账户 \{fmtUsd\(stats\.accountEquity/.test(LIST),
    '★ 不该再并列显示「账户」那第二个数（那是用户说的"画蛇添足"）',
  );
});

test('★★ 三个页面的阈值必须都是 0.01（不能再出现别的容差）', () => {
  const all = LIST + OVERVIEW + DETAIL;
  /*
   * ⚠️ 只检查与本判据相关的表达式 —— 别把别的容差（例如指标卡的过期阈值）
   * 一起抓进来。
   */
  const gaps = [...all.matchAll(/Math\.abs\((?:trader\.)?ledger!?\.gap\) >= ([0-9.]+)/g)].map((m) => m[1]);
  assert.ok(gaps.length >= 3, `★ 三处都该有 gap 判据（实际找到 ${gaps.length} 处）`);
  for (const g of gaps) {
    assert.equal(g, '0.01', `★ 容差必须是 0.01（发现 ${g}）—— 不一致会让三处给出不同的数`);
  }
});
