/**
 * **quill 的"纯图标按钮"判据不能靠 `:has(> svg)` 猜**（外部 issue #183）。
 *
 * ## 缺陷形状
 *
 * `quill/theme.css` 有两条规则（`:649`、`:660`）用同一个判据：
 *
 * ```css
 * html.aq-quill .btn:has(> svg):not(:has(> :not(svg))) { padding-left: 0; … }
 * html.aq-quill .btn-danger:has(> svg):not(:has(> :not(svg))) { background: transparent; … }
 * ```
 *
 * 而**注释里那个前提是错的**（`theme.css:647`）：
 *
 * > 文本节点不参与 `:has()`，所以三个分支都对。
 *
 * 事实**正好相反**：正因为文本节点不参与 `:has()`，
 * 一个「`<svg/>` + 文字」的按钮**同时满足**两个条件：
 *
 * ```
 *   :has(> svg)                 ✅ 有 svg 元素子节点
 *   :not(:has(> :not(svg)))     ✅ 没有"非 svg 的元素子节点"（文字不是元素）
 * ```
 *
 * 于是「图标 + 文字」的按钮被当成"纯图标"：
 *
 * | 按钮 | DOM | 实际背景 | 实际 padding |
 * | --- | --- | --- | --- |
 * | 启动 | `svg + 文字` | 实心绿（对） | **0px**（错） |
 * | 立即分析 | `svg + 文字` | 实心紫（对） | **0px**（错） |
 * | **停止** | `svg + 文字` | **透明**（错，最弱态） | **0px**（错） |
 *
 * 而「停止」在 classic 模板下是**实心红**。所以最该醒目的危险动作在 quill 下最不醒目 ——
 * 这与维护者自己写下的意图相反。
 *
 * ## 修法：用**显式声明**代替 CSS 猜测
 *
 * `Button` 组件已经有一个明确的语义参数 `size="icon"`（9 处使用，都带 `aria-label`）。
 * 它是"这是一个纯图标按钮"的**显式声明**，比"靠子节点形状反推"可靠得多。
 *
 * 所以让 `size="icon"` 生成一个稳定的标记类，CSS 用它做判据 ——
 * 与 `templates/registry.ts` 的 `supportedSkins`（issue #171）是同一个思路：
 * **需要判断的东西显式声明出来，而不是让消费方猜。**
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const QUILL_CSS = readFileSync(new URL('../templates/quill/theme.css', import.meta.url), 'utf8');
const UI_TSX = readFileSync(new URL('../components/ui.tsx', import.meta.url), 'utf8');

/** 剥掉 CSS 注释再匹配 —— 本仓库注释会逐字引用被讨论的代码。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('★★★ quill 不得再用 `:has(> svg)` 判"纯图标" —— 文本节点让它必然误伤', () => {
  const css = stripCssComments(QUILL_CSS);

  /*
   * 判据：不得出现 `:has(> svg)` 这类"靠子节点形状猜"的写法。
   */
  const offenders: string[] = [];
  for (const line of css.split('\n')) {
    if (/:has\(>\s*svg\s*\)/.test(line)) offenders.push(line.trim());
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 不得用 `:has(> svg)` 判断"纯图标按钮" —— 文本节点不参与 `:has()`，\n' +
      '    所以「图标 + 文字」的按钮会同时满足 `:has(> svg)` 与 `:not(:has(> :not(svg)))`，\n' +
      '    被当成纯图标：padding 归零、危险按钮变透明（issue #183）。\n' +
      '    改用 `Button size="icon"` 生成的显式标记类。\n' +
      `    命中：\n      ${offenders.join('\n      ')}`,
  );
});

test('★★★ quill 的纯图标规则必须改用显式标记类', () => {
  const css = stripCssComments(QUILL_CSS);
  assert.match(
    css,
    /\.btn-icon\b/,
    '★★★ quill 的"纯图标"规则必须挂在 `.btn-icon` 上 —— 那是 `Button size="icon"` ' +
      '显式声明的标记，而不是靠 `:has()` 猜出来的。',
  );
});

test('★★ `Button size="icon"` 必须真的生成 `btn-icon` 类 —— 否则 CSS 永远命中不到', () => {
  /*
   * 这是"两处各写一份"最容易断的地方：CSS 等 `btn-icon`，而组件没生成它，
   * 于是规则静默失效（那正是这类缺陷的形态）。
   */
  assert.match(
    UI_TSX,
    /icon:\s*'[^']*btn-icon/,
    "★★ `Button` 的 `size: 'icon'` 变体必须包含 `btn-icon` —— 否则 quill 的规则命中不到任何东西，" +
      '「纯图标按钮的最小点击目标」这个能力会静默消失',
  );
});

test('★ 纯图标规则不得清零左右 padding 之外的东西 —— 修 #183 不能顺手改掉别的', () => {
  /*
   * 反向守卫：`.btn-icon` 那条规则应当**只**处理"方形最小点击目标"这件事
   *（padding + 居中 + min-width）。危险按钮的静默态是另一条规则，两者别混。
   */
  const css = stripCssComments(QUILL_CSS);
  const start = css.indexOf('.btn-icon');
  assert.ok(start > 0, '找不到 `.btn-icon` 规则');
  const rule = css.slice(start, css.indexOf('}', start) + 1);

  assert.match(rule, /padding-left:\s*0/, '★ 清零左右 padding 是这条规则的本意');
  assert.match(rule, /min-width/, '★ 要有方形最小点击目标');
  assert.doesNotMatch(
    rule,
    /background-color/,
    '★ 背景色属于"危险按钮静默态"那条规则 —— 不要混进"最小点击目标"这条',
  );
});
