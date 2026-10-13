/**
 * 联网搜索客户端的测试。
 *
 * 重点钉住**失败降级**：搜索是外部依赖（网络/magpie/上游搜索 API），
 * 任何一环挂掉都**不该让整轮决策失败** —— 行情数据是好的，团队照样能决策。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractToolText, webSearch, type WebSearchConfig } from './webSearch.js';

/* -------------------------------------------------------------------------- */
/*  响应解析（形状照抄实测的 MCP 返回）                                          */
/* -------------------------------------------------------------------------- */

test('★ 解析标准 MCP 返回（实测形状）', () => {
  /*
   * 2026-10-12 对 `http://127.0.0.1:3425/mcp/magpie/web-search` 的真实返回：
   *
   *   {"id":3,"jsonrpc":"2.0","result":{"content":[{"text":"1. Bitcoin (BTC) Price…
   *    https://www.coinbase.com/price/bitcoin …"}]}}
   */
  const payload = {
    id: 3,
    jsonrpc: '2.0',
    result: { content: [{ text: '1. Bitcoin — https://www.coinbase.com/price/bitcoin\n最新价 $82,931' }] },
  };
  const text = extractToolText(payload);
  assert.ok(text);
  assert.ok(text.includes('coinbase'), '★ 结果里要带 URL（提示词要求模型引用来源）');
});

test('★ JSON-RPC 层错误要【说出来】，不能当成"搜到 0 条"', () => {
  /*
   * 这两种情况的区别很实际：
   *   · "搜到 0 条" → 市场上真的没消息；
   *   · "搜索报错"  → 是我们这一侧的问题，该去修。
   * 混成一样会让运维查错方向。
   */
  const text = extractToolText({ error: { message: 'no API key was sent' } });
  assert.ok(text?.includes('no API key'), '★ 错误信息要透出');
  assert.ok(text?.includes('搜索出错'), '★ 要标明这是搜索出错');
});

test('★ 多条 content 会被合并', () => {
  const text = extractToolText({ result: { content: [{ text: 'A' }, { text: 'B' }] } });
  assert.ok(text?.includes('A') && text?.includes('B'));
});

test('结构不认识时返回 null（不猜）', () => {
  assert.equal(extractToolText({ result: {} }), null);
  assert.equal(extractToolText(null), null);
  assert.equal(extractToolText('随便一段话'), null);
});

/* -------------------------------------------------------------------------- */
/*  端到端（用桩 server）                                                      */
/* -------------------------------------------------------------------------- */

/** 造一个临时 HTTP 服务当搜索端点。 */
async function withStubServer(
  handler: (body: unknown) => { status: number; body: unknown },
  fn: (endpoint: string) => Promise<void>,
): Promise<void> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = handler(raw.length > 0 ? JSON.parse(raw) : null);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/mcp/magpie/web-search`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const cfg = (endpoint: string): WebSearchConfig => ({ endpoint, apiKey: 'test-key' });

test('★★ 能真实调通搜索端点并拿到结果', async () => {
  await withStubServer(
    (body) => {
      /* 顺带断言请求形状 —— 少 `accept` 会被 MCP 拒绝（实测 406）。 */
      assert.ok(body, '请求体要有');
      return { status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [{ text: '搜到的内容 https://a.com' }] } } };
    },
    async (endpoint) => {
      const r = await webSearch(cfg(endpoint), 'bitcoin news');
      assert.equal(r.ok, true);
      assert.ok(r.text.includes('https://a.com'));
      assert.equal(r.query, 'bitcoin news', '审计要能知道查了什么');
      assert.ok(r.latencyMs >= 0);
    },
  );
});

test('★★ 端点 401 → 返回失败而非抛错（降级而非中断）', async () => {
  /*
   * 搜索是**外部依赖**。抛错会让"新闻拿不到"升级成"整轮决策失败"，
   * 而行情数据是好的 —— 团队完全可以基于行情决策。
   */
  await withStubServer(
    () => ({ status: 401, body: { error: 'no API key' } }),
    async (endpoint) => {
      const r = await webSearch(cfg(endpoint), 'x');
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('401'), '★ 要说清是 401');
      assert.ok(r.error?.includes('网关 key'), '★ 要说清可能的原因');
    },
  );
});

test('★ 端点返回空内容 → 判定为失败（不是"搜到 0 条"）', async () => {
  await withStubServer(
    () => ({ status: 200, body: { result: { content: [{ text: '   ' }] } } }),
    async (endpoint) => {
      const r = await webSearch(cfg(endpoint), 'x');
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('空内容'));
    },
  );
});

test('★ 连不上 → 返回失败而非抛错', async () => {
  /* 端口 1 上不会有服务。 */
  const r = await webSearch(cfg('http://127.0.0.1:1/mcp'), 'x');
  assert.equal(r.ok, false);
  assert.ok(r.error !== undefined && r.error.length > 0);
});
