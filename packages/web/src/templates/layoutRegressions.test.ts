/**
 * **两套"页面错位"真 BUG 的回归测试**（2026-10-13）。
 *
 * 用户报的是：「第三套皮肤（静谧/quill）页面错位，而前两套不受影响」。
 * 实测（真实 Chrome，1600×900，三套皮肤 × 8 路由）：
 * ```
 *   classic   html.scrollHeight = 900  ✅ 不可滚
 *   console   html.scrollHeight = 900  ✅ 不可滚
 *   quill     html.scrollHeight = **987**  ❌ 能滚 87px（用户看到的"错位"）
 * ```
 * 决定性判据不是 `scrollHeight`（它可能虚报），而是
 * **`window.scrollTo(0, 99999)` 之后 `scrollY > 0`** —— 页面真的能滚。
 *
 * ## 根因一：`.sr-only` 没有 `top`/`left`（真凶）
 *
 * Tailwind 的 `.sr-only` 是 `position: absolute` **但没有 `top` / `left`**：
 * ```css
 *   .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; … }
 * ```
 * 一个"绝对定位但没有偏移量"的元素**停留在它在文档流里的静态位置**
 * （CSS 2.1 §10.3.7）。`OverviewPage` 的 `<h2 class="sr-only">` 祖先链上
 * **没有任何定位祖先**，所以包含块是**初始包含块** ——
 * 而它在 quill 的布局下静态位置是 `top: 950` → 把 `html` 撑到 **987**。
 *
 * 实测对应关系（`.sr-only` 元素的最大 `bottom` ↔ `html.scrollHeight`）：
 * ```
 *   classic   .sr-only 最靠下 859  → html 900
 *   console   .sr-only 最靠下 876  → html 900
 *   quill     .sr-only 最靠下 987  → html **987**   ← 完全对应
 * ```
 * ⚠️ 而给 `.q-root` / `body` 加 `overflow: hidden` **完全无效** ——
 * 绝对定位元素的包含块是初始包含块时，它**逃出所有 overflow 祖先**。
 *
 * ## 根因二：`.q-pad` 的高度链
 *
 * ```
 *   main.q-work  h=774  overflow:auto     ← 应该由它滚（带 MAIN_SCROLL_ID）
 *     .q-pad     h=1560（被内容撑高）      ← ❌ 高度链断在这里
 * ```
 * 而**第一轮我修错了**：给 `.q-pad` 加 `overflow-y: auto`（"让它自己吸收溢出"），
 * 结果**滚动层被从 `q-work` 挪到了 `q-pad`**：
 * ```
 *   quill / : q-work 可滚量 0（774/774）· q-pad 可滚量 155（929/774）  ← ❌ 抢了
 * ```
 * 这会让**帮助页的目录跟随高亮静默失效**（它监听的是 `#main-scroll`）。
 *
 * **正解（方案 C，三方案实测选出）**：
 * ```
 *   .q-pad              { overflow: visible }    ← 不抢滚动层
 *   .q-pad > *          { flex-shrink: 0 }       ← 内容超高时顶开 q-work 去滚
 *   .page-fill / .h-full { flex: 1 1 auto }      ← 撑满类页面仍拿到确定高度
 * ```
 *
 * ## 修复后实测（72 项全通过）
 * ```
 *   3 视口 × 3 皮肤 × 8 路由 = 72 项
 *   文档全不可滚 ✅ · 文本量与 classic 一致（无内容被裁）✅
 *   quill / : q-work 可滚量 260（滚动层正确）· q-pad overflow=visible（不抢）✅
 * ```
 *
 * ## ⚠️ 这些断言扫的是**纯文本**，所以必须先剥注释
 *
 * 我第一版直接正则匹配源码，三条断言**全部假失败**：
 * ```
 *   ① `.sr-only` 的正则命中了【注释里的示例】`{ position: absolute; … }`（没有 top）
 *   ② 同理取错了位置
 *   ③ `.q-pad` 的第二块注释里写着"溢出口在下面那条 `overflow-y: auto`"
 *      —— 那是在解释【第一轮的错误】，却被当成"代码里有 overflow: auto"
 * ```
 * 这与 TS 侧已踩过四次的坑**完全相同**（见 `sourceText.ts` 的说明），
 * 所以这里用 `codeOnlyCss()` 先把注释换成空白。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss, cssBlocks } from '../testUtils/cssText';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ⚠️ 一律用剥掉注释后的源码做断言 —— 见文件头最后一段。 */
const INDEX_CSS = codeOnlyCss(read('../index.css'));
const QUILL_CSS = codeOnlyCss(read('./quill/theme.css'));

/* -------------------------------------------------------------------------- */
/*  根因一：.sr-only                                                            */
/* -------------------------------------------------------------------------- */

test('★★★ `.sr-only` 必须锚定到包含块的左上角（否则会把 html 撑高）', () => {
  /*
   * ⚠️ 判据用"有 top 与 left 两条"，不是"含 sr-only 这个词" ——
   * `.sr-only` 的其它属性（width/height/clip）都存在，缺的正是这两条偏移量。
   */
  const blocks = cssBlocks(INDEX_CSS, '.sr-only');
  assert.ok(blocks.length > 0, '★ index.css 里必须有 `.sr-only` 的覆盖规则');
  const body = blocks.join('\n');
  assert.ok(/top:\s*0/.test(body), '★ 必须有 `top: 0` —— 否则元素滞留在文档流原位');
  assert.ok(/left:\s*0/.test(body), '★ 必须有 `left: 0`');
});

test('★★★ 那段注释必须留在源码里（它防的是"下一个人把这行删掉"）', () => {
  /*
   * 这条断言看着"多余"，但它防的是一个**很实在的风险**：
   * 删掉 `top: 0; left: 0` 之后，页面只是"能多滚 87px"，
   * **看不出异常、也不报错**，而且**只有一套皮肤有这个症状** ——
   * 很容易被后来的人当成"那套皮肤自己的问题"而绕过去。
   * 所以要求那段解释必须留在文件里。
   *
   * ⚠️ 必须用【剥注释前】的原文来找 —— 那段解释**本身就是注释**。
   */
  const raw = read('../index.css');
  /* 找【真规则】的位置（它上面那段长注释就是解释）。 */
  const idx = raw.indexOf('\n  .sr-only {');
  assert.ok(idx >= 0, '★ 找不到 `.sr-only` 规则（缩进两格的那条）');
  const around = raw.slice(Math.max(0, idx - 4000), idx);
  assert.ok(
    around.includes('静态位置') || around.includes('static position'),
    '★ 必须解释根因（绝对定位但无偏移 → 滞留在文档流原位）',
  );
  assert.ok(
    around.includes('987') || around.includes('撑高'),
    '★ 必须留下实测数字（否则后人不知道这是真 BUG 而不是"多余的 CSS"）',
  );
  assert.ok(
    around.includes('sr-only') && around.includes('top'),
    '★ 注释里必须点名 `.sr-only` 与 `top`（让人一眼知道在说哪一行）',
  );
});

/* -------------------------------------------------------------------------- */
/*  根因二：.q-pad 的高度链                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ `.q-pad` 不能自己成为滚动层（否则帮助页目录跟随会静默失效）', () => {
  /*
   * ⚠️ 这是**我第一轮修错的地方**：加了 `overflow-y: auto` →
   * 滚动层从 `#main-scroll` 挪到了 `.q-pad`。
   * `#main-scroll` 是"整个应用唯一的滚动层"（帮助页目录监听它），
   * 被抢走之后那个功能**不报错、只是不工作**。
   */
  const blocks = cssBlocks(QUILL_CSS, 'html.aq-quill .q-pad');
  assert.ok(blocks.length > 0, '★ 找不到 `.q-pad` 规则');
  for (const b of blocks) {
    assert.ok(
      !/overflow(-y)?:\s*(auto|scroll)/.test(b),
      `★ \`.q-pad\` 不能有 overflow auto/scroll —— 那会抢走 #main-scroll 的滚动层（实际块：${b.trim().slice(0, 90)}）`,
    );
  }
  /* 必须显式写 visible（或完全不写），不能留 `hidden` 把内容裁掉。 */
  const hasVisible = blocks.some((b) => /overflow:\s*visible/.test(b));
  assert.ok(hasVisible, '★ 应有显式的 `overflow: visible`（并附理由注释）');
});

test('★★★ `.q-pad` 的直接子级必须 `flex-shrink: 0`（内容超高时顶开 q-work）', () => {
  const blocks = cssBlocks(QUILL_CSS, 'html.aq-quill .q-pad > *');
  assert.ok(blocks.length > 0, '★ 必须有 `.q-pad > *` 规则');
  assert.ok(
    /flex-shrink:\s*0/.test(blocks.join('\n')),
    '★ 必须有 `flex-shrink: 0` —— 否则子项被压缩、溢出传到文档',
  );
});

test('★★★ 撑满类页面仍要拿到确定高度（`flex: 1 1 auto` 必须存在）', () => {
  const pageFill = cssBlocks(QUILL_CSS, 'html.aq-quill .q-pad > :where(.page-fill)');
  const hFull = cssBlocks(QUILL_CSS, 'html.aq-quill .q-pad > :where(.h-full)');
  assert.ok(pageFill.length > 0, '★ 必须有 `.page-fill` 的撑满规则');
  assert.ok(hFull.length > 0, '★ 必须有 `.h-full` 的撑满规则');
  for (const b of [...pageFill, ...hFull]) {
    assert.ok(/flex:\s*1 1 auto/.test(b), '★ 撑满类必须 `flex: 1 1 auto`');
    assert.ok(/min-height:\s*0/.test(b), '★ 撑满类必须 `min-height: 0`（否则撑破容器）');
  }
});

test('★★★ `.q-pad` 必须保留 `height: 100%`（高度链的起点）', () => {
  /*
   * ⚠️ 反向保证：修 overflow 时最容易顺手把 `height: 100%` 删掉 ——
   * 那会回到"表格不再自己滚动、整页变长"（theme.css 上方记录过的另一个 BUG）。
   */
  const blocks = cssBlocks(QUILL_CSS, 'html.aq-quill .q-pad');
  assert.ok(
    blocks.some((b) => /height:\s*100%/.test(b)),
    '★ `.q-pad` 必须有 `height: 100%` —— 撑满类页面的高度链靠它',
  );
});
