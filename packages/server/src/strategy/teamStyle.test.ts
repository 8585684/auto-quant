/**
 * **`ai_team` 不能被注入系统预设的交易性格**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"两层都在说同一件事、而其中一层是错的"**的 BUG：
 * ```
 *   autoTrader.ts:  aiManaged: mode === 'ai_managed'      ← 漏了 ai_team
 *   → ai_team 的 system_prompt 里出现：
 *       「模式：稳健 …… 保住本金压倒一切。宁可交易更少、质量更高。」
 *       「当信号互相冲突时，正确的动作是 `wait`。」
 * ```
 * 实测 `#11` 的 system_prompt：
 * ```
 *   含"由你自己判断"? **false**
 *   含"稳健"?        **true**
 * ```
 * **而裁决官正是引用了它**（原文）：
 * > 「账户与模式不允许赌：权益仅20.75U、**conservative**、逐仓、无持仓……
 * >  **40轮空仓不是必须打破的错误。**」
 *
 * ## 为什么它是 BUG（而不是"配置如此"）
 *
 * 用户需求 ③：「系统**不再设置内置风控**……**风格也应该由一个智能体来负责**」。
 * 而 `defaultAiTeamConfig()` 里那些数值**全都放开了**
 *（`minConfidence: 0` / `minRiskRewardRatio: 0` / `maxMarginUsage: 100`）——
 * 说明本意就是"不预设"，**只有那段文本漏了**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const AUTO_TRADER = readFileSync(
  new URL('../trader/autoTrader.ts', import.meta.url),
  'utf8',
);
const PROMPT = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8');

test('★★★ `ai_team` 必须与 `ai_managed` 一样被当成"托管"（不被注入风格档）', () => {
  /*
   * ⚠️ 这是那个 BUG 的**直接形状**：`aiManaged` 只认 `ai_managed`。
   * 若它回来了，团队模式又会开始吃"稳健/保住本金压倒一切"。
   */
  assert.ok(
    /aiManaged:[\s\S]{0,200}?ai_managed[\s\S]{0,120}?ai_team/.test(AUTO_TRADER),
    '★ `aiManaged` 必须同时覆盖 ai_managed 与 ai_team',
  );
});

test('★★★ 提示词里"托管"分支必须明确说"系统没有预设风格档"', () => {
  /*
   * 只改 `aiManaged` 还不够 —— 模型可能自己脑补一个"系统希望我保守"的隐含设定
   *（那正是它上一轮说"模式不允许赌"的来源）。所以要把"没有预设"**说出来**。
   */
  assert.ok(
    PROMPT.includes('系统没有给你预设任何风格档'),
    '★ 必须明确告知"没有预设风格档"，否则模型会自己假设一个',
  );
  assert.ok(
    PROMPT.includes('不要假设"系统希望我保守"'),
    '★ 并要点名那个具体的错误假设',
  );
});

test('★ `strategy` 模式的行为不变 —— 固定策略仍然吃 MODE_GUIDANCE', () => {
  /*
   * ⚠️ 用户需求里"旧模式必须保留"是硬约束。
   * 固定策略（`strategy`）的人**真的选了那一档**，所以那段文本必须照旧注入。
   */
  assert.ok(
    /: `# \$\{MODE_GUIDANCE\[config\.tradingMode\]\}`/.test(PROMPT),
    '★ 非托管分支必须仍然是 MODE_GUIDANCE（固定策略靠它）',
  );
});

test('★★★ "系统状态"里不能对托管模式报 `交易模式：conservative`', () => {
  /*
   * ## 为什么这是同一个 BUG 的第二处
   *
   * 修了 `aiManaged` 之后，`system_prompt` 里已经没有 MODE_GUIDANCE 了 ——
   * 而 `user_prompt` 的"# 系统状态"里**还有一行**：
   * ```
   *   交易模式：conservative
   * ```
   * **它把一个"系统并不执行"的档位当成事实报给模型** ——
   * 而裁决官正是拿它当约束用（原文）：
   * > 「账户与模式不允许赌：权益仅20.75U、**conservative**……
   * >  **40轮空仓不是必须打破的错误。**」
   *
   * **报一个假约束比不报更糟**：它与"风格由你自己判断"互相矛盾，
   * 而模型面对矛盾时倾向于选**更保守**的那个。
   */
  assert.ok(
    /ctx\.aiManaged\s*\n?\s*\?\s*'交易模式：\*\*由你自己决定\*\*/.test(PROMPT) ||
      PROMPT.includes('交易模式：**由你自己决定**'),
    '★ 托管模式下必须报"由你自己决定"，而不是那个残留的档位',
  );
  /* 而非托管分支必须照旧报真实档位（固定策略需要它）。 */
  assert.ok(
    PROMPT.includes('`交易模式：${ctx.config.tradingMode}`'),
    '★ 非托管模式仍要报真实档位',
  );
});
