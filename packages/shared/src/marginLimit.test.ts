/**
 * **"以自身保证金为限制"模式**（2026-10-13 用户要求）。
 *
 * ## 用户的原话
 *
 * > 「**不要限制单笔上限**（由于系统【逐仓】运行，所以一笔交易最多亏损保证金，
 * >  所以用户会自己控制，不需要系统限制最大止损金额），
 * >  改成**以自身保证金为限制**」
 * >
 * > 「**可以取消最小开仓的要求**（要保证交易所有效性）、盈亏比和胜率的要求可以保留。」
 * >
 * > 「还有一点很不好，就是在**最后做最终判断的时候，提示模型，如果做不了……**」
 *
 * ## 为什么这个改动有理有据（实测）
 *
 * 旧口径：`maxNotionalByRatio = 权益 × ratio`，实测 `#11` 的
 * `altcoinMaxPositionValueRatio = 1` → **上限只有 20.75 USDT**。
 * 而交易所对多数标的的最小名义是 5–50 → **根本没有可做的空间** → 40+ 轮零决策。
 *
 * 逐仓下这个上限是多余的：一笔的最大亏损 = 它自己的保证金。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RiskControlConfigSchema } from './strategy.js';

const ENGINE_SRC = readFileSync(
  new URL('../../server/src/risk/engine.ts', import.meta.url),
  'utf8',
);
const PROMPT_SRC = readFileSync(
  new URL('../../server/src/strategy/prompt.ts', import.meta.url),
  'utf8',
);

/**
 * **只取代码行**（去掉注释）。
 *
 * ## 为什么需要它（同一个教训在本项目出现了两次）
 *
 * 我两次写"某段文本不该存在"的断言时都假失败，原因相同：
 * **我在修复的注释里引用了那段旧文本**（用来解释"为什么改"）。
 * ```
 *   第一次：`const riskPerTradePercent = 2;`（见 riskBudget.test.ts）
 *   这一次：`这一条门槛就已经把可行集压到接近空了`
 * ```
 * **"在注释里引用旧代码"是有价值的** —— 它让后来的人知道为什么改。
 * 所以该修的是**断言**，不是注释。
 *
 * ⚠️ 而"每处都手写一遍过滤"必然会漏 —— 所以做成一个 helper。
 */
function codeLinesOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

const PROMPT_CODE = codeLinesOnly(PROMPT_SRC);

test('★★★ `marginBasedLimit` 默认关闭 —— 既有机器人（实盘 #10）行为不变', () => {
  const parsed = RiskControlConfigSchema.parse({});
  assert.equal(
    parsed.marginBasedLimit,
    false,
    '★ 默认必须是 false：这个改动会影响交易行为，打开必须是一次显式选择',
  );
});

test('★★★ 打开时：名义上限改成"可用保证金 × 杠杆"，而不是"权益 × 比例"', () => {
  /*
   * 实测 `#11`：`altcoinMaxPositionValueRatio = 1` → 上限 20.75 USDT，
   * 而多数标的的交易所下限是 5–50 → 做不了。
   * 新口径：20.75 × 12 = **249 USDT** —— 宽 12 倍。
   */
  assert.ok(
    ENGINE_SRC.includes('maxNotionalByMargin'),
    '★ 必须有"按保证金算上限"的那一项',
  );
  assert.ok(
    /useMarginLimit\s*\?\s*maxNotionalByMargin\s*:\s*account\.equity\s*\*\s*maxRatio/.test(ENGINE_SRC),
    '★ 必须是"打开才用新口径"，否则旧行为被改掉',
  );
  /* 而它必须乘上该标的的杠杆上限，而不是一个写死的数。 */
  assert.ok(
    /maxNotionalByMargin\s*=[\s\S]{0,120}?leverageCap/.test(ENGINE_SRC),
    '★ 上限必须乘该标的的杠杆上限',
  );
});

test('★★★ 打开时：`minPositionSize` 被取消，但**交易所下限必须保留**', () => {
  /*
   * ⚠️ 这两者必须分开（用户说的是前者，而后者是物理约束）：
   * ```
   *   minPositionSize  —— 一个人为的偏好（"我不想做太小的仓"）
   *   exchangeMin      —— 交易所的物理下限（低于它**根本发不出去**）
   * ```
   * 若把后者也去掉了，系统会发出**必然被交易所拒绝**的单 ——
   * 那是纯粹的浪费，而且会让日志充满假失败。
   */
  assert.ok(
    /effectiveMin\s*=\s*useMarginLimit\s*\?\s*exchangeMin\s*:/.test(ENGINE_SRC),
    '★ 打开时应当只用交易所下限（保留物理约束、去掉人为偏好）',
  );
});

test('★★★ 提示词：打开时不再用"权益×百分比"反推止损带', () => {
  assert.ok(
    /if \(ctx\.config\.riskControl\.marginBasedLimit\)/.test(PROMPT_SRC),
    '★ 提示词必须有这个分支',
  );
  /* 新分支必须说清"逐仓下最大亏损就是保证金"这件事。 */
  assert.ok(
    PROMPT_SRC.includes('单笔的最大亏损就是它自己的保证金'),
    '★ 必须把逐仓的那个事实讲清楚（那是这个改动的全部依据）',
  );
});

test('★★★ 提示词：不能出现"引导模型放弃"的措辞（用户明确指出的问题）', () => {
  /*
   * 用户原话：
   * > 「还有一点很不好，就是在**最后做最终判断的时候，提示模型，如果做不了……**」
   *
   * 原来那段写的是：
   * ```
   *   ⚠️ 它想说明的是：**这一条门槛就已经把可行集压到接近空了**。
   *   …要不要让可行集重新非空、以及怎么让，**是你的判断**。
   * ```
   * **它把模型的注意力引到"调门槛"上，而不是"这笔值不值得做"** ——
   * 而实测（40+ 轮零决策）证明那个引力的方向是**放弃**。
   */
  assert.ok(
    !PROMPT_CODE.includes('这一条门槛就已经把可行集压到接近空了'),
    '★ 那句"可行集被压空"必须删掉 —— 它引导模型去论证"做不了"（注释里引用不算）',
  );
  assert.ok(
    PROMPT_CODE.includes('这只是一条背景门槛，不是结论'),
    '★ 应当改成"它只是众多条件之一，继续往下评估依据"',
  );
});

test('★ 保留项：盈亏比仍然有效（用户明确说"可以保留"）', () => {
  /* 用户：`盈亏比和胜率的要求可以保留` —— 所以这条不该被这次改动碰掉。 */
  assert.ok(
    ENGINE_SRC.includes('minRiskRewardRatio'),
    '★ 盈亏比约束必须保留',
  );
  assert.ok(
    /盈亏比[\s\S]{0,40}仍然有效/.test(PROMPT_SRC),
    '★ 提示词应说明"盈亏比这条仍然有效"（免得模型以为全放开了）',
  );
});
