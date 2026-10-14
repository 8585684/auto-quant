/**
 * **决策区搬到主栏后，不能再依赖"父容器有确定高度"**
 *（2026-10-14 用户报：「让你改个布局，该成这种BUG了？」）
 *
 * ## 事故：布局错乱（卡片压扁、内容重叠）
 *
 * 我把决策区从右栏搬到主栏，但**没有拆掉那套为右栏设计的高度机制**。
 * 那套机制的每一环都依赖同一个前提：**父容器有确定高度**。
 *
 * ## 完整的高度链（右栏时代的正确设计）
 *
 * ```
 *   PageShell 的 aside        h-full  ← 站在"可视区 − 顶栏"的确定高度链上
 *     └ Panel (section)       h-full  ← 拿到那个确定高度
 *         └ body (div)        flex-1  ← 吃掉"剩余"（= 确定高度 − 表头）
 *             ├ 工作流区       flex-1  ← 再吃掉"剩余"
 *             └ 决策记录区     固定上限   ← 只留一条
 * ```
 *
 * ## 为什么搬到主栏后全部塌陷
 *
 * 主栏是 `flex flex-col space-y-2` —— **高度由内容撑出来，没有确定值**。
 * 于是：
 * ```
 *   h-full   → 100% × auto → auto（无意义）
 *   flex-1   → flex: 1 1 0% → basis 是 0
 *              而"没有剩余可分配" → 最终高度 = 0 → 内容被压扁
 *              → 而子元素仍按自己的高度渲染 → 互相重叠
 * ```
 * 用户截图里那个错乱就是这个。
 *
 * ## 修法（四处，缺一不可）
 *
 * ```
 *   Panel 的 className      : h-full → 去掉
 *   Panel 的 bodyClassName  : flex-1 → 去掉（这是错乱的【直接机制】）
 *   工作流区                 : flex-1 → 去掉
 *   决策记录区               : max-h-[70vh] + overflow-y-auto（自己滚）
 * ```
 *
 * ⚠️ **教训**：`h-full` / `flex-1` 这些类名**换了容器就不再是同一个意思**。
 * 它们表达的是"相对父容器的比例"，而父容器一变，比例就失去基准。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SRC = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');

test('★★★ 面板不能再 `h-full`（主栏没有确定高度，它会塌陷）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    !/className="flex h-full min-h-0 flex-col"/.test(code),
    '★ 面板不能 h-full —— 主栏高度是 auto，h-full 无意义',
  );
  assert.ok(
    /className="flex min-h-0 flex-col"/.test(code),
    '★ 面板应该是 flex min-h-0 flex-col（按内容高）',
  );
});

test('★★★ 面板内容区不能再 `flex-1`（basis 0 会压扁内容 —— 错乱的直接机制）', () => {
  const code = codeOnly(SRC);
  /*
   * ⚠️ `flex-1` = `flex: 1 1 0%`，**basis 是 0**。
   * 父容器有确定高度时它是"吃掉剩余"（对的）；
   * 父容器高度 auto 时，"没有剩余" → 最终高度 0 → 内容压扁。
   */
  assert.ok(
    !/bodyClassName="flex min-h-0 flex-1 flex-col p-0"/.test(code),
    '★ bodyClassName 不能有 flex-1 —— 那是布局错乱的直接机制',
  );
  assert.ok(
    /bodyClassName="flex min-h-0 flex-col p-0"/.test(code),
    '★ bodyClassName 应该是 flex min-h-0 flex-col p-0',
  );
});

test('★★★ 工作流区不能再 `flex-1`（它靠"抢剩余高度"占主导，主栏里没有剩余）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    !/'flex min-h-0 flex-1 flex-col gap-2 border-b border-base-800 p-2\.5'/.test(code),
    '★ 工作流区不能 flex-1 —— "抢 90% 高度"那个需求在右栏才成立',
  );
});

test('★★★ 决策记录区必须有够大的上限 + 自己滚（它是唯一该滚的那块）', () => {
  const code = codeOnly(SRC);
  assert.ok(/max-h-\[70vh\]/.test(code), '★ 上限 70vh（够大，且不依赖容器高度）');
  assert.ok(/overflow-y-auto/.test(code), '★ 过长时自己滚');
});

test('★★ 整个组件不能再出现"依赖父容器确定高度"的类名', () => {
  const code = codeOnly(SRC);
  /*
   * ⚠️ 判据只针对**实际 className 里的**用法（注释已被 `codeOnly` 剥掉）。
   * `h-full` 允许出现在**全屏模式**里 —— 那时容器是固定的整页高度。
   */
  const fullH = [...code.matchAll(/className="[^"]*\bh-full\b[^"]*"/g)].map((m) => m[0]);
  assert.equal(
    fullH.length,
    0,
    `★ 不该再有 h-full 的 className（发现：${fullH.join(' | ')}）`,
  );
});
