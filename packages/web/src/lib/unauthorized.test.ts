/**
 * **401 不能被两种语义共用**（外部 issue #148）。
 *
 * ## 缺陷经过
 *
 * 后端把两件**完全不同**的事都用 401 表达：
 *
 * ```
 * auth.ts:169/174/178   需要登录 / 令牌过期 / 凭据变更   → 401   ← "你的会话结束了"
 * server.ts:872         改密码时"当前密码不正确"         → 401   ← "你这次请求的口令填错了"
 * ```
 *
 * 而前端 `api.ts:229` 只看状态码：
 *
 * ```ts
 * if (response.status === 401 && !anonymous) onUnauthorized?.();
 * ```
 *
 * `onUnauthorized` 会 `clearToken()` 并跳到登录页（`store.ts:72-75` + `App.tsx`）。
 * 于是**在设置页把当前密码输错一次，就被直接登出**。
 *
 * ## 为什么不能靠状态码区分
 *
 * 401 在 HTTP 语义上**两者都沾边**（都是"未通过认证"），所以这不是"码用错了"，
 * 而是**前端不能只靠状态码区分**。
 *
 * ## 修法：服务端给机器可读码，前端只对"无码"的 401 登出
 *
 * 两个候选方案（issue 里都提了）：
 *
 *   · 方案①：前端给 `request()` 加 `skipUnauthorized` 选项，调用点带上；
 *   · 方案②：服务端在响应体里带 `code: 'invalid_current_password'`，前端认码。
 *
 * 选了**方案②**，理由是判据放在服务端更稳：
 * 方案①需要每个"可能填错口令"的调用点都记得带上那个标志 ——
 * **将来新增的调用点会漏**（本仓库吃过多次这类亏）；
 * 方案②则让新增调用点自动正确（服务端会一直带着那个码）。
 *
 * ## 为什么这个测试测纯函数
 *
 * `request()` 依赖 `fetch` 与 `localStorage`，而本仓库 web 侧没有 jsdom/RTL
 * （`test` 脚本只跑 `src` 下的 `.test.ts`，没有组件挂载能力）。
 * 所以把"该不该登出"这个判据抽成**导出的小函数** `shouldSignOut()` ——
 * 它正是缺陷所在的那一行，抽出来之后可单测。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isInvalidCurrentPassword, shouldSignOut } from './api';

test('★★★ 改密码时"当前密码不正确"的 401 不能触发登出', () => {
  /*
   * 后端会返回 `{ error: '当前密码不正确。', code: 'invalid_current_password' }`。
   * 前端见到这个码就必须**留在原地**（把错误显示在表单上），而不是清 token 跳登录页。
   */
  const payload = { error: '当前密码不正确。', code: 'invalid_current_password' };

  assert.equal(
    isInvalidCurrentPassword(payload),
    true,
    '★ 必须能识别出这个码',
  );
  assert.equal(
    shouldSignOut(401, payload),
    false,
    '★★★ 口令填错的 401 不能登出 —— 否则在设置页输错一次密码就被踢到登录页（issue #148）',
  );
});

test('★★★ 会话失效的 401 仍必须登出（无码 = 会话问题）', () => {
  /*
   * 反向守卫：修这条时最容易犯的错是"401 一律不登出" ——
   * 那会让令牌过期后页面卡在一个永远失败的循环里。
   */
  for (const payload of [
    { error: '请先登录。' },
    { error: '登录已过期，请重新登录。' },
    undefined, // 空响应体也要按"会话失效"处理（保守）
    null,
    'plain text error',
  ]) {
    assert.equal(
      shouldSignOut(401, payload),
      true,
      `★★★ 401 且没有 invalid_current_password 码时必须登出（payload=${JSON.stringify(payload)}）—— ` +
        '否则令牌过期后页面会卡在永远失败的循环里',
    );
  }
});

test('★ 非 401 的状态码一律不登出', () => {
  for (const status of [400, 403, 404, 429, 500, 502]) {
    assert.equal(
      shouldSignOut(status, { error: 'x' }),
      false,
      `★ ${status} 不该触发登出`,
    );
  }
});

test('★ 匿名请求（未登录时的 401）本来就不该走登出逻辑', () => {
  /*
   * `request()` 里那个 `!anonymous` 判断是**既有行为**：
   * 登录接口自己回 401 时不能触发登出（否则登录失败会变成"登出"）。
   * 这里把它固化成 `shouldSignOut` 的参数，防止将来重构时丢掉。
   */
  assert.equal(shouldSignOut(401, { error: '用户名或密码错误。' }, true), false, '★ 匿名时不登出');
  assert.equal(shouldSignOut(401, { error: '请先登录。' }, false), true, '★ 已登录时登出');
});

test('★★ isInvalidCurrentPassword 只认精确的码，不做模糊匹配', () => {
  /*
   * 模糊匹配（例如"错误信息里含'密码'就认为是口令错"）会很危险：
   * 会话失效的提示里也可能出现"密码"字样，那会让**真正需要登出**的情形被漏掉。
   */
  assert.equal(isInvalidCurrentPassword({ code: 'invalid_current_password' }), true);
  assert.equal(isInvalidCurrentPassword({ code: 'INVALID_CURRENT_PASSWORD' }), false, '大小写敏感');
  assert.equal(isInvalidCurrentPassword({ code: 'invalid_current_password ' }), false, '不 trim');
  assert.equal(isInvalidCurrentPassword({ error: '当前密码不正确。' }), false, '只看 code，不看文案');
  assert.equal(isInvalidCurrentPassword({ code: 401 }), false, 'code 必须是字符串');
  assert.equal(isInvalidCurrentPassword(undefined), false);
  assert.equal(isInvalidCurrentPassword(null), false);
  assert.equal(isInvalidCurrentPassword('invalid_current_password'), false, '不是对象不算');
});
