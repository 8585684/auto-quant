/**
 * 「这个主题在当前模板下会不会生效」—— 外部 issue #171。
 *
 * ## 这个测试防的是什么
 *
 * 浅色主题靠 CSS 属性选择器实现，而**只有 `console` 与 `quill` 写了规则**：
 *
 * ```
 * html.aq-console[data-skin='light'] { … }   ← console/theme.css:210
 * html.aq-quill[data-skin='light']   { … }   ← quill/theme.css:215
 * ```
 *
 * `classic/` 目录下 `skin` **零命中** —— 它的定位是"原版外观"，固定深色。
 * 但外观页把「深色 / 浅色」两张卡原样展示给所有模板，于是 classic 用户点「浅色」：
 *
 *   · 写进了 localStorage（设置确实存下来了）
 *   · `<html>` 上写了 `data-skin="light"`（属性也对了）
 *   · 按钮显示为**已选中**（带勾）
 *   · **界面一个像素都不变**
 *
 * 也就是"UI 承诺了它做不到的事" —— 与本仓库反复修过的
 * 「设置存下来但不生效且不报错」是同一族（#168 清空按钮 no-op、#164 恒新建）。
 *
 * ## 为什么这些断言有意义
 *
 * 它们把"哪些主题真的会生效"从**散落在 CSS 文件里的隐式事实**
 * 变成**可断言的显式声明**：将来给 classic 补上浅色规则时，
 * 若忘了同步声明，测试会红；反过来，若声明了支持却没写 CSS，也会被这条用例提醒
 *（见下面那条"声明与 CSS 必须一致"的检查思路）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isSkinSupported, unsupportedSkins, SKINS } from './appearance';
import { BUILT_IN } from '../registry';

test('★★★ classic 必须声明只支持深色 —— 否则「浅色」是个点了没反应的开关', () => {
  const classic = BUILT_IN.find((t) => t.id === 'classic');
  assert.ok(classic, '找不到 classic 模板');

  /*
   * classic 没有浅色 CSS 规则（`templates/classic/` 下 grep `skin` 零命中），
   * 所以它必须**显式**声明只支持 dark —— 让外观页能据此禁用那一项。
   */
  assert.deepEqual(
    classic.supportedSkins,
    ['dark'],
    '★★★ classic 必须声明 supportedSkins: [\'dark\'] —— 它没有浅色 CSS，声明了才能禁用那个选项',
  );
});

test('★★★ console 与 quill 必须声明两套主题都支持', () => {
  for (const id of ['console', 'quill'] as const) {
    const t = BUILT_IN.find((x) => x.id === id);
    assert.ok(t, `找不到 ${id} 模板`);
    assert.deepEqual(
      t.supportedSkins,
      ['dark', 'light'],
      `★★★ ${id} 的 theme.css 里有 [data-skin='light'] 规则，必须声明两套都支持`,
    );
  }
});

test('★ 声明与 CSS 实际规则一致 —— 两边漂移会让这个缺陷重现', () => {
  /*
   * 这条用例的价值在于：它把"CSS 里有没有浅色规则"与"注册表里怎么声明"
   * 绑在一起。只改一边就会红 —— 而这类"两处各写一份"正是本仓库吃过多次的亏。
   *
   * 检查方式：读每个模板目录下的 theme.css，看有没有 `[data-skin='light']`。
   */
  const here = path.dirname(fileURLToPath(import.meta.url));

  for (const t of BUILT_IN) {
    const cssPath = path.join(here, '..', t.id, 'theme.css');
    const hasCss = existsSync(cssPath) && readFileSync(cssPath, 'utf8').includes("[data-skin='light']");
    const claimsLight = (t.supportedSkins ?? []).includes('light');

    if (claimsLight) {
      assert.ok(
        hasCss,
        `★ ${t.id} 声明支持浅色，但它的 theme.css 里没有 [data-skin='light'] 规则 —— ` +
          `那会让浅色选项变成点了没反应的开关（正是本 issue 的缺陷）`,
      );
    } else {
      assert.ok(
        !hasCss,
        `★ ${t.id} 的 theme.css 有浅色规则，但注册表没声明支持 —— 请把 'light' 加进 supportedSkins`,
      );
    }
  }
});

test('isSkinSupported：没声明就不做限制（第三方模板不必知道这个字段）', () => {
  assert.equal(isSkinSupported(undefined, 'light'), true);
  assert.equal(isSkinSupported([], 'light'), true);
  assert.equal(isSkinSupported(['dark', 'light'], 'light'), true);
  assert.equal(isSkinSupported(['dark'], 'light'), false);
  assert.equal(isSkinSupported(['dark'], 'dark'), true);
});

test('unsupportedSkins：给出"当前模板下不生效"的那些选项', () => {
  /* classic：只有深色 → 浅色是不生效的那个。 */
  assert.deepEqual(unsupportedSkins(['dark']), ['light']);
  /* console/quill：两套都支持 → 没有不生效的。 */
  assert.deepEqual(unsupportedSkins(['dark', 'light']), []);
  /* 未声明 → 视为全都支持（与 isSkinSupported 一致）。 */
  assert.deepEqual(unsupportedSkins(undefined), []);
});

test('SKINS 里恰好有深色与浅色两项 —— 与 Skin 类型同步', () => {
  assert.deepEqual(
    SKINS.map((s) => s.id),
    ['dark', 'light'],
  );
});
