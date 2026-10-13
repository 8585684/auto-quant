/**
 * **CSS 源码的"只看代码"工具**（给契约测试用）。
 *
 * ## 为什么需要它（这是本项目已经踩过四次的坑）
 *
 * `packages/server/src/testUtils/sourceText.ts` 里的 `codeOnly()` 解决的是同一类
 * 问题，只是那边针对 TS、这里是 CSS。事情的形状完全一样：
 *
 * ```
 *   测试断言"源码里不能出现 X"  →  而 X 出现在【注释里】（解释那段历史）
 *                              →  假失败
 * ```
 *
 * 本项目在 TS 侧已实测踩过四次：
 * ```
 *   riskBudget        —— 注释里引用了旧常量 `const riskPerTradePercent = 2;`
 *   marginLimit       —— 注释里引用了旧措辞「这一条门槛就已经把可行集压到接近空了」
 *   hunterConcurrency —— 注释里引用了旧写法 `AQ_HUNTER_CONCURRENCY ?? '' || 2`
 *   researchPersistence —— 注释里引用了旧代码 `researchCache.get(`
 * ```
 *
 * ## 本次（2026-10-13）CSS 侧又踩了一次
 *
 * 我给 `.q-pad` 写了一条防回归断言"不能有 `overflow: auto`"，
 * 而那个块里的**注释正在解释第一轮的错误**：
 * ```css
 *   ⚠️ 这一条是"要收缩的 flex 子项必须 min-height: 0"那条规则的另一半：
 *   `q-pad` 自己是 `q-work` 的 flex 子项，没有它就会被自己的内容顶高。
 *  （溢出口在下面那条 `overflow-y: auto`。两条各管一件事，都需要。）   ← 匹配到了这句
 * ```
 * 于是"代码是对的"但断言失败 —— **而失败信息指向一个不存在的问题**。
 *
 * 另一条更隐蔽：我用 `/\.sr-only\s*\{([^}]*)\}/` 找规则，
 * 命中的是**注释里的示例**：
 * ```css
 *   .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; … }
 * ```
 * → 取到的是示例（没有 `top`），而不是下面那条真规则（有 `top`）。
 *
 * ## 用法
 *
 * ```ts
 * const src = codeOnlyCss(readFileSync('theme.css', 'utf8'));
 * // 现在 src 里没有 /* … *\/ 注释，正则不会命中注释文本
 * ```
 */
export function codeOnlyCss(src: string): string {
  /*
   * 只处理块注释（`/* … *\/`）—— CSS 没有行注释，
   * 而 `//` 在 CSS 里不是注释（写它会变成无效声明）。
   *
   * ⚠️ 用 `[\s\S]` 而不是 `[^]` 或 `.` + `s` 标志：前者在所有环境下都合法。
   * ⚠️ 非贪婪 `*?` 很关键 —— 贪婪会把从第一个 `/*` 到最后一个 `*\/` 的
   * **整个中间部分**都吃掉（包括真实代码）。
   */
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    /* 保留换行，让报错时的行号大致还对得上。 */
    return m.replace(/[^\n]/g, ' ');
  });
}

/**
 * 取某个**选择器**的声明块内容（只在前者没被注释掉的部分里找）。
 *
 * ## 为什么不用 `/selector\s*\{([^}]*)\}/` 直接匹配
 *
 * 两个原因，都实测踩过：
 *
 * **① 注释示例会被命中。** 示例和真规则长得一样，顺序取决于谁写在前面 ——
 * 实测就是注释在文件上方，于是永远取到示例。
 *
 * **② 逗号组合选择器匹配不到。** 真实写法是：
 * ```css
 *   html.aq-quill .q-pad > :where(.page-fill),
 *   html.aq-quill .q-pad > :where(.h-full) {
 *     flex: 1 1 auto;
 *   }
 * ```
 * 从第一个选择器到 `{` 之间**隔着另一个选择器**，所以 `selector\s*\{` 匹配不上。
 * 实测这一条让"撑满类页面"的断言假失败。
 *
 * ## 判据：`[^{}]*` 而不是 `\s*`
 *
 * 选择器与 `{` 之间**不允许出现另一个 `{` 或 `}`**（那说明已经进了别的规则），
 * 但允许出现逗号、换行、以及其它选择器 —— 这正是逗号组合的形状。
 *
 * @param code 已经过 `codeOnlyCss()` 的源码
 * @param selector 选择器字面量（会被转义后做正则匹配）
 */
export function cssBlocks(code: string, selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}[^{}]*\\{([^}]*)\\}`, 'g');
  return [...code.matchAll(re)].map((m) => m[1] ?? '');
}
