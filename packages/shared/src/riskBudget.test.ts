/**
 * **"风险参数可改"这件事必须是真的**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**存在了很久的死锁**，而且它的形状特别隐蔽：
 * ```
 *   提示词对模型说：「造成"空集"的两个变量 —— 规则、风险参数 —— 都在你自己的权限里」
 *   而那个 2% 其实是 prompt.ts 里的 const riskPerTradePercent = 2;（硬编码）
 *   → 模型用 set_params 只能改 riskControl 的字段 → 改不到它
 *   → 它「只能一直用 2% 熬着」（decisionTools.ts 里早就写下了这句话）
 *   → 40+ 轮零决策
 * ```
 *
 * **"我们告诉模型它能做某事、而它其实做不到"** —— 这比"不给它这个能力"更糟：
 * 它会让模型反复尝试、反复失败，并把失败归因到自己身上。
 *
 * ## 死锁的代价（实测算术）
 *
 * ```
 *   权益 20.75 · 单笔风险 2% = 0.415 USDT
 *   币安最小名义 50 USDT → 止损上限只能 0.83%
 *   而 15m ATR 的常态是 2–4%
 *   → 差 2.4–5 倍 → 没有任何标的能通过
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RiskControlConfigSchema } from './strategy.js';

const SRC = readFileSync(new URL('./strategy.ts', import.meta.url), 'utf8');
/*
 * ⚠️ 跨包读 `server` 的源码：`packages/shared/src/` → 上三级到仓库根。
 * （第一版写成 `../server/...`，那会解析成 `packages/shared/server/...` —— 不存在。）
 */
const PROMPT_SRC = readFileSync(
  new URL('../../server/src/strategy/prompt.ts', import.meta.url),
  'utf8',
);

test('★★★ `riskPerTradePercent` 必须是真字段（不是提示词里的硬编码）', () => {
  const parsed = RiskControlConfigSchema.parse({});
  assert.equal(
    parsed.riskPerTradePercent,
    2,
    '★ 默认仍是 2 —— 既有机器人的行为不变',
  );
  /* 上界必须有：那已经不是"风险预算"而是"押注"了。 */
  const tooBig = RiskControlConfigSchema.safeParse({ riskPerTradePercent: 50 });
  assert.equal(tooBig.success, false, '★ 必须有上界（50% 不是风险预算）');
  const zero = RiskControlConfigSchema.safeParse({ riskPerTradePercent: 0 });
  assert.equal(zero.success, false, '★ 0% 等于永不开仓，没有意义');
});

test('★★★ 提示词不能再硬编码那个 2%', () => {
  /*
   * ⚠️ 这是本死锁的**直接形状**：`const riskPerTradePercent = 2;`
   * 若它回来了，那句"在你权限里"就又变成了一句做不到的承诺。
   *
   * ⚠️ **要排除注释行**：我的修复注释里**引用**了旧代码那句
   *（`* 而那个 2% 当时是这里的 \`const riskPerTradePercent = 2;\``）——
   * 第一版断言只做全文正则，于是命中了那句引用、假失败。
   * 「在注释里引用旧代码」是有价值的（它解释了为什么改），
   * 所以该改的是断言，不是注释。
   */
  const codeLines = PROMPT_SRC.split('\n').filter((line) => {
    const t = line.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });
  const hardcoded = codeLines.some((line) => /const riskPerTradePercent = 2;/.test(line));
  assert.ok(!hardcoded, '★ 提示词里不该再有硬编码的 2（注释里引用不算）—— 它必须从配置读');
  assert.ok(
    PROMPT_SRC.includes('riskControl.riskPerTradePercent'),
    '★ 必须从 `riskControl.riskPerTradePercent` 读',
  );
});

test('★★★ 对照表必须随配置变化（不能写死"2%"的后果）', () => {
  /*
   * 那段提示词会算出一张"你的 2% 导致 ATR 上限只有 0.92%"的对照表。
   * 若表里的数字写死而 `riskPerTradePercent` 变可配，模型改完参数后
   * 表格就会**与它刚改的值不一致** —— 那会让它以为自己没改成功。
   */
  assert.ok(
    /const riskPerTradePercent = ctx\.config\.riskControl/.test(PROMPT_SRC),
    '★ 对照表必须用配置里的值来算',
  );
  /* 而变量必须真的被用在算术里（不只是声明）。 */
  const uses = PROMPT_SRC.match(/riskPerTradePercent/g)?.length ?? 0;
  assert.ok(uses >= 3, `★ 它应当被用在多处算术里（实际出现 ${uses} 次）`);
});

test('★★★ 字段的语义与默认值一致（防止"改了默认值却忘了同步注释"）', () => {
  /* 默认值 2 必须与提示词里那段"默认口径"的说明一致 —— 否则模型会算错。 */
  assert.match(SRC, /riskPerTradePercent[\s\S]{0,400}?default\(2\)/, '★ 默认值应当是 2');
});
