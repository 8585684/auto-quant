/**
 * **决策区的高度不能对非团队模式生效**（2026-10-13 实测回归）。
 *
 * ## 事故：`#10 赚大钱`（ai_managed）的右栏变成一大片空白
 *
 * 用户截图：右栏「最近决策」里只有一行 `NEARUSDT`，下面是整屏空白。
 *
 * ## 根因：我为团队模式压决策区，却压到了所有模式
 *
 * 上一轮为了让「AI 工作流」占主导，我把决策记录区改成：
 * ```
 *   max-h-[10%] + flex-none
 * ```
 * 而**工作流区只在 `ai_team` 渲染** —— 于是：
 * ```
 *   ai_team    : 工作流 flex-1（吃满）+ 决策区 10%   ✅ 符合预期
 *   ai_managed : 工作流【不存在】+ 决策区 10%        ❌ 90% 空白
 * ```
 * 浏览器实测（`#4` 非团队模式）：
 * ```
 *   修前：子节点 h=66（视口的 10%）→ 空白
 *   修后：子节点 h=656（满高）· 3 条决策卡正常渲染
 * ```
 *
 * ## 教训
 *
 * **「只在某模式下存在的东西，不能让它在别的模式下产生副作用」** ——
 * 这个面板是**三种模式共用**的（`strategy` / `ai_managed` / `ai_team`），
 * 改它时必须逐模式想一遍。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SRC = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');

test('★★★ 决策区的高度必须按 `mode` 分开（不能无条件压到 10%）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    /mode === 'ai_team' \? 'flex-none max-h-\[10%\]' : 'flex-1'/.test(code),
    '★ 必须是"团队模式压、其它模式 flex-1"的三元 —— 无条件压会让非团队模式空出 90%',
  );
});

test('★★★ 不能再出现无条件的 `max-h-[10%]`（那是本次回归的形态）', () => {
  const code = codeOnly(SRC);
  /*
   * ⚠️ 允许出现在 `mode === 'ai_team' ?` 之后，但不允许出现在
   * 一个**不含 mode 判断**的 className 字符串里。
   * 判据：把 `max-h-[10%]` 前面的 200 字符拿出来，必须含 `ai_team`。
   */
  const at = code.indexOf('max-h-[10%]');
  assert.ok(at >= 0, '★ 团队模式那条限制应该还在（别把它一起删了）');
  const before = code.slice(Math.max(0, at - 200), at);
  assert.ok(
    before.includes("ai_team"),
    '★ `max-h-[10%]` 必须在 `mode === \'ai_team\'` 的分支里 —— 无条件用会让非团队模式空白',
  );
});

test('★★★ 非团队模式必须仍是 `flex-1`（吃掉全部高度）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    code.includes(": 'flex-1'"),
    "★ 非团队模式的分支必须是 `flex-1`（否则决策区不会长高）",
  );
});
