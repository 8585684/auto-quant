/**
 * `idParamOf()` 的回归测试。
 *
 * 这个测试的存在理由是一次**被默默藏住的误诊**：22 条路由各自写
 * `Number((request.params as { id: string }).id)`，而 `db/index.ts` 的
 * `normalise()` 会把 `NaN` 静默绑成 NULL —— `WHERE id = NULL` 查不到行，
 * 于是 `GET /api/exchange-accounts/abc` 回的是 **404「找不到该凭据」**。
 *
 * 拼错一个 URL 得到"这条记录不存在"的回答，操作员就会去找一条从来没存在过的
 * 记录；真正的病因（路径写错、或前端传了个非数字）反而没人看得见。
 *
 * 之所以值得单独测：这个坑不在任何一条路由的代码里，而在"解析"与"存储"之间
 * 的距离上 —— 每加一条带 `:id` 的路由都会重新踩进去，除非它用的是这个函数。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { idParamOf } from './server.js';

describe('idParamOf', () => {
  it('正常数字字符串照原样通过', () => {
    assert.equal(idParamOf({ id: '7' }), 7);
    assert.equal(idParamOf({ id: '0' }), 0);
  });

  it('非数字 id 抛 400，而不是把 NaN 交给存储层', () => {
    // 这是本测试存在的理由：没有这个分支，NaN 会被绑成 NULL → 404「找不到」。
    assert.throws(
      () => idParamOf({ id: 'abc' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 400, '应当是个 400，让 guard 回「ID 无效」而不是 404');
        assert.match(error.message, /ID/, '错误信息要说清是 ID 的问题');
        return true;
      },
    );
  });

  it('空 id 与缺 id 同样抛 400', () => {
    assert.throws(() => idParamOf({ id: '' }));
    assert.throws(() => idParamOf({}));
  });

  it('Infinity / NaN 字面量也被拒绝', () => {
    assert.throws(() => idParamOf({ id: 'Infinity' }));
    assert.throws(() => idParamOf({ id: 'NaN' }));
  });

  it('抛出的错误带 statusCode，两条错误路径都能变成 400', () => {
    /*
     * `statusCode` 是这个函数与 Fastify 之间的契约：
     *   · `guard()` 包着的路由 —— 它 catch 后读 `statusCode ?? 400`；
     *   · 没包 `guard` 的路由 —— 由 `setErrorHandler` 读同一个字段。
     * 两条路径回的响应体都是 `{ error: <message> }`，所以形状一致。
     * 少了这个字段，没包 guard 的那 24 条路由会走 `statusCode >= 400 ? … : 500`
     * 的分支，把"URL 写错"报成 **500 服务端错误**。
     */
    try {
      idParamOf({ id: 'abc' });
      assert.fail('应当抛错');
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      assert.equal(statusCode, 400);
      assert.ok(statusCode !== undefined && statusCode >= 400, '缺 statusCode 会落入 500 分支');
    }
  });
});
