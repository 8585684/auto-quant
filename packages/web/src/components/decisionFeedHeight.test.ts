/**
 * **决策区的高度约束必须对三种模式一致，且不能把它压成一条**
 *
 * ## 这个文件经历过两次真实回归（都记在这里，因为它们是同一类错误）
 *
 * ### 回归一（2026-10-13）：`max-h-[10%]` 对**所有模式**生效
 *
 * 用户截图：`#10`（`ai_managed`）的右栏「最近决策」只有一行，下面是整屏空白。
 * ```
 *   ai_team    : 工作流 flex-1（吃满）+ 决策区 10%   ✅ 符合预期
 *   ai_managed : 工作流【不存在】+ 决策区 10%        ❌ 90% 空白
 * ```
 * 修法：`mode === 'ai_team' ? 'flex-none max-h-[10%]' : 'flex-1'`。
 * 浏览器实测：子节点 h=66（10%）→ h=656（满高）。
 *
 * ### 回归二（2026-10-14）：决策区**搬到了主栏**，而 `max-h-[10%]` 留了下来
 *
 * 用户的原话：
 * > 「这么一小块根本没用，不如直接把这块直接移动到左边，智能体审计原有的位置」
 *
 * `max-h-[10%]` 是**按右栏的窄高度**定的比例。搬到主栏（全宽）之后，
 * 同一个数字换了容器就不再是同一个意思 —— 它把这一块压成一条，
 * 而那正是用户抱怨的形态。
 *
 * ## 现在的策略（三种模式一致）
 *
 * ```
 *   max-h-[70vh]  —— 用 vh 而不是 %：主栏可用高度取决于上面的图表/指标卡，
 *                    而那些是 clamp() 算出来的，% 会随它们变
 *   内容不足时按内容高（max- 不是 h-）
 *   内容过长时自己滚（overflow-y-auto）
 * ```
 *
 * ⚠️ 本文件现在钉的是**新契约**：
 * ```
 *   ① 三种模式用同一个高度策略（不再按 mode 分叉 —— 分叉的前提已消失）
 *   ② 上限必须够大（70vh，不是 10%）—— 10% 就是用户说的"一小块"
 *   ③ 不能用 %（它依赖容器高度，而主栏高度不可预测）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SRC = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');

test('★★★ 决策区的高度上限必须够大（不能再是 10%）', () => {
  const code = codeOnly(SRC);
  /*
   * ⚠️ 10% 是"按右栏窄高度"定的比例，搬到主栏后它把这一块压成一条 ——
   * 而用户的原话就是「这么一小块根本没用」。
   */
  assert.ok(
    !/max-h-\[10%\]/.test(code),
    '★ 不能再出现 max-h-[10%] —— 那是右栏时代的取舍，在主栏里会把决策区压成一条',
  );
  assert.ok(
    /max-h-\[70vh\]/.test(code),
    '★ 上限应该是 70vh（够大，且不依赖容器高度）',
  );
});

test('★★★ 上限不能用百分比（它依赖容器高度，而主栏高度不可预测）', () => {
  const code = codeOnly(SRC);
  /*
   * 主栏的可用高度取决于上面的指标卡/图表，而那些是 `clamp()` 算出来的 ——
   * `%` 会随它们变化，`vh` 只跟窗口走。
   */
  assert.ok(
    !/max-h-\[\d+%\]/.test(code),
    '★ 高度上限不能用 % —— 主栏高度由上面的图表决定，不可预测',
  );
});

test('★★★ 三种模式必须用同一个高度策略（不再按 mode 分叉）', () => {
  const code = codeOnly(SRC);
  /*
   * ⚠️ 分叉（`mode === 'ai_team' ? … : …`）的前提是"团队模式的工作流要占主导"，
   * 而那件事只在**右栏**成立。搬到主栏后工作流与决策区是上下排列的，
   * 谁也不必"占主导"。
   */
  assert.ok(
    !/mode === 'ai_team' \? 'flex-none max-h/.test(code),
    '★ 不该再按 mode 分叉高度 —— 那个分叉是为右栏写的',
  );
});

test('★★ 内容不足时按内容高、过长时自己滚（不能把高度写死）', () => {
  const code = codeOnly(SRC);
  assert.ok(/overflow-y-auto/.test(code), '★ 过长时要能自己滚');
  /* `max-h-` 而不是 `h-`：内容少时不该被拉到上限。 */
  assert.ok(!/className=\{cn\(\s*'min-h-0 space-y-2\.5 overflow-y-auto p-2\.5',\s*'h-\[/.test(code), '★ 用 max-h- 而不是 h-');
});
