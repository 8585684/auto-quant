/**
 * **保证金 ≠ 名义价值** —— 模型必须拿到这个换算（2026-10-13 实测抓到的真 BUG）。
 *
 * ## 事故
 *
 * 线上 `#11`（账户 **20.75 USDT**）的决策理由原文：
 * ```
 *   BTCUSDT skip：「最小名义 50 **超出 20U 账户可执行范围**」
 *   ETHUSDT skip：「最小名义 20 过大」
 * ```
 * **两句都是错的**：`20.75 × 20x = 415 USDT 名义`，远超 BTC 的 50 ——
 * 它**完全开得起**。
 *
 * ## 为什么会错（这是说明的缺陷，不是模型的错）
 *
 * 修改前那段说明只给了三个事实：
 * ```
 *   当前权益 20.75 USDT · 可用 20.75 USDT
 *   "每笔划多少保证金，是你自己的判断"
 *   "唯一的物理边界是可用保证金"
 * ```
 * **它从没说"保证金要乘杠杆才是名义价值"。** 而"最小名义"是**名义口径**的
 * 约束（交易所按名义价值算下限）—— 模型手上只有保证金口径的数字，
 * 于是只能凭直觉把两者当同一个量，而那个直觉是错的。
 *
 * ## 为什么代价很高
 *
 * ```
 *   真实可开：415 USDT 名义（20.75 × 20x）
 *   它以为：  20 USDT 名义      → 差 20 倍
 * ```
 * 结果是它对**几乎每个候选**都能找到一个"开不了"的理由 ——
 * 而那是它自己算错的，不是市场没有机会。
 *
 * ## 修法
 *
 * 把换算写出来，并给出**逐档位的两个参照**（最低/最高杠杆 → 名义上限），
 * 因为每个标的的杠杆档位不同，让模型手算容易出错。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const SRC = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8');

test('★★★ 逐仓说明里必须给出「名义价值 = 保证金 × 杠杆」', () => {
  const code = codeOnly(SRC);
  assert.ok(
    /名义价值 = 保证金 × 杠杆/.test(code),
    '★ 必须明写这条换算（否则模型会把保证金当名义上限，实测就是这样错的）',
  );
  assert.ok(
    /保证金 ≠ 名义价值/.test(code),
    '★ 必须点出"两者不是一回事"（这是那个错误的直接来源）',
  );
});

test('★★★ 必须给出【用当前可用余额算出的名义上限】（不能让模型自己乘）', () => {
  /*
   * ⚠️ 每个标的的杠杆档位不同（材料里那行 `GTCUSDT 10x、BTCUSDT 150x…`），
   * 让模型自己挑档位去乘容易出错。给出最低/最高两个参照，
   * 结论一眼可见。
   */
  const code = codeOnly(SRC);
  assert.ok(
    /avail \* minLev/.test(code) && /avail \* maxLev/.test(code),
    '★ 必须同时给出"最低档位"与"最高档位"下的名义上限',
  );
  assert.ok(
    /真实可执行范围/.test(code),
    '★ 必须点明"这两个数就是你的真实可执行范围"',
  );
});

test('★★★ 杠杆档位必须来自 `ctx.leverageCaps`（真实授信，不是配置上限）', () => {
  /*
   * ⚠️ 用配置里的 `btcEthMaxLeverage` 会**高估** —— 真实可用杠杆是
   * `min(配置上限, 档位上限, 账户级限制)`（见 `leverageCaps` 的注释）。
   * 而这个换算的用途是"让模型知道它开得起多大"，高估会误导。
   */
  const code = codeOnly(SRC);
  assert.ok(
    /ctx\.leverageCaps/.test(code),
    '★ 必须读 `ctx.leverageCaps`（交易所对该账户的真实授信）',
  );
});

test('★★★ 缺杠杆数据时不能崩（`leverageCaps` 是可选字段）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    /levValues\.length > 0 \?/.test(code),
    '★ 必须有"没有档位数据"的回落分支',
  );
  assert.ok(
    /minLev !== null && maxLev !== null/.test(code),
    '★ 两个参照都必须在数据存在时才渲染',
  );
});

test('★ 原有的三条说明不能被弄丢（逐仓/不设单笔上限/盈亏比）', () => {
  const code = codeOnly(SRC);
  for (const k of ['逐仓运行的', '系统不再用"权益的百分比"给你设单笔上限', '唯一的物理边界是**可用保证金**']) {
    assert.ok(code.includes(k), `★ 原有说明丢了：「${k}」`);
  }
});
