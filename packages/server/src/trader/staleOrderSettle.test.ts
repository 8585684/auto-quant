/**
 * **结清陈旧委托不能只挂在决策周期里**
 *（2026-10-14 线上实测抓到的 BUG：本地 36 条"已挂单"，交易所 0 条）
 *
 * ## 事故
 *
 * 线上 `#11`（团队模式）：
 * ```
 *   本地 orders status='NEW'       : 36 条
 *   交易所 /fapi/v1/openOrders     :  0 条
 *   交易所 /fapi/v1/openAlgoOrders :  0 条（9 个标的逐个查）
 * ```
 * 用户看到「当前委托 28 · 已挂单（待对账）」，而**交易所一张都没有**。
 *
 * ## 关键事实：逻辑是对的，只是从未被执行
 *
 * 我逐条复刻了 `settleStaleOrders()` 的判据：
 * ```
 *   ① candidates（够老 + 非终态）      : 36 条
 *   ② activeProtectionIds（open 持仓）:  0 个
 *   ③ 交易所挂着                       :  0 条 → 可结清 36
 * ```
 * 也就是说它**本来能全部结清** —— 只是它挂在决策周期的对账那一步里，
 * 而团队模式的决策又慢又长，那个路径经常走不到（实测 `#11` 的对账只跑过 2 次）。
 *
 * ## 修法：给它一个**独立于决策周期**的入口
 *
 * 由 `manager` 的**自检循环**（每 30 分钟，那条路径即使决策卡住也一定会跑）调用。
 *
 * ⚠️ 为什么这样是安全的：`settleStaleOrders()` 只改账（把交易所已不挂着的
 * 本地行写成终态），**不撤单、不下单**，唯一依据是交易所自己说那张单还在不在。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

test('★★★ AutoTrader 必须暴露一个公开的结清入口（供外部节奏调用）', () => {
  assert.ok(
    /async settleStaleOrderRecords\(\): Promise<number>/.test(AUTO),
    '★ 必须有公开方法 —— 否则 manager 无法在决策周期之外调用它',
  );
  assert.ok(
    /return this\.settleStaleOrders\(\)/.test(AUTO),
    '★ 它应该直接转发到私有的 settleStaleOrders（不要复制逻辑）',
  );
});

test('★★★ 自检循环必须调用它（那是"一定会跑"的那条路径）', () => {
  /*
   * ⚠️ 判据：`runSelfCheckSweep` 里必须出现 `settleStaleOrderRecords()`。
   * 它是独立于决策周期的 30 分钟节奏 —— 而这正是修复的关键。
   */
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER);
  assert.ok(sweep !== null, '★ 应当能找到 runSelfCheckSweep');
  assert.ok(
    /settleStaleOrderRecords\(\)/.test(sweep![0]),
    '★ 自检循环里必须调用结清 —— 决策周期不一定跑得到，这个循环一定会跑',
  );
});

test('★★★ 结清必须排在自检【之前】（否则自检读到的是陈旧的行）', () => {
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER)![0];
  const settleAt = sweep.indexOf('settleStaleOrderRecords()');
  const checkAt = sweep.indexOf('runSelfCheck(id');
  assert.ok(settleAt > 0 && checkAt > 0, '★ 两处都该在自检循环里');
  assert.ok(
    settleAt < checkAt,
    '★ 结清必须排在自检之前 —— 自检会读委托状态并据此报告异常',
  );
});

test('★★ 结清失败不能影响自检（它是记账修复，不是自检的输入）', () => {
  const sweep = /private async runSelfCheckSweep[\s\S]*?\n  \}/.exec(MANAGER)![0];
  /* 结清那一小段必须有 try/catch。 */
  const settleBlock = /try \{[\s\S]{0,700}?settleStaleOrderRecords\(\)[\s\S]{0,700}?catch/.exec(sweep);
  assert.ok(settleBlock !== null, '★ 结清必须包在 try/catch 里，失败不能拖垮自检');
});

test('★★ 决策周期里那条结清路径仍然保留（两个节奏都要有）', () => {
  /*
   * ⚠️ 不要因为加了自检循环就把周期里那条删掉 ——
   * 周期那条更及时（平仓后立刻结清，见 `settleStaleOrders(symbol)`），
   * 自检那条是兜底。**两个都要**。
   */
  assert.ok(
    /await this\.settleStaleOrders\(\)\.catch/.test(AUTO),
    '★ 周期里的结清路径必须保留',
  );
  assert.ok(
    /await this\.settleStaleOrders\(symbol\)\.catch/.test(AUTO),
    '★ 平仓后立刻结清那条路径也必须保留',
  );
});
