/**
 * ★ **响应体读取失败的错误分类 —— #135**
 *
 * 钉住的缺陷（外部实测过，两条路径不一致）：
 *
 * ```
 *   非流式, HTTP 429 + body 读到一半失败 → 裸 TypeError
 *                                           isLlmError=false, isRetryable=false
 *                                           status 与 Retry-After 一起丢
 *   流式,   HTTP 429 + body 失败          → LlmError, status=429, retryAfter=30s ✅
 * ```
 *
 * `isRetryable()` 只认 `LlmError`（`errors.ts`），所以一条 `TypeError` 被判成
 * "这类错误不会因重试而成功" —— 一次本可重试的网络抖动被永久放弃，而且操作员
 * 看到的是裸报错而不是中文诊断。修法：把 `response.text()` 纳入错误分类
 * （非 2xx 保住 status 与 Retry-After；2xx 读断裂归 connectionError；
 *  调用方取消仍归 abortError 不重试）。流式 2xx 分支同构补齐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { executeJsonRequest, executeStreamRequest } from './http.js';
import { isRetryable } from './errors.js';
import { LlmError } from './errors.js';
import type { OutboundRequest } from './types.js';

/** 一个 body 在传输中途失败的响应：headers 已到（429 + Retry-After），流被 error。 */
function midTransferFailure(status: number, headers: Record<string, string>): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error('connection reset mid-body'));
    },
  });
  return new Response(stream, { status, headers });
}

const req: OutboundRequest = {
  url: 'https://gateway.example.invalid/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: { model: 'm', messages: [] },
};

async function withFetch<T>(response: Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('★★ 非流式：429 + body 读到一半失败 —— 必须保住 status=429、可重试、30s Retry-After', async () => {
  await withFetch(
    midTransferFailure(429, { 'retry-after': '30', 'content-type': 'application/json' }),
    async () => {
      await assert.rejects(
        () => executeJsonRequest('custom', req),
        (err: unknown) => {
          assert.ok(err instanceof LlmError, '★ 必须是 LlmError（裸 TypeError 会被判成永久失败）');
          const e = err as LlmError;
          assert.equal(e.status, 429, '状态码不能因 body 读失败而丢');
          assert.equal(isRetryable(e), true, '429 是可重试的');
          assert.equal(e.retryAfterMs, 30_000, 'Retry-After 不能丢 —— 那 30 秒退避是限流保护的一部分');
          return true;
        },
      );
    },
  );
});

test('★★ 非流式：200 + body 读到一半失败 —— 归可重试的 connection 类错误', async () => {
  await withFetch(midTransferFailure(200, { 'content-type': 'application/json' }), async () => {
    await assert.rejects(
      () => executeJsonRequest('custom', req),
      (err: unknown) => {
        assert.ok(err instanceof LlmError, '不能再裸抛 TypeError');
        assert.equal(isRetryable(err), true, '传输中断是可重试的抖动，不是永久失败');
        return true;
      },
    );
  });
});

test('★ 流式：200 + SSE 读到一半失败 —— 与 JSON 路径同一套分类（可重试）', async () => {
  await withFetch(midTransferFailure(200, { 'content-type': 'text/event-stream' }), async () => {
    await assert.rejects(
      () => executeStreamRequest('custom', req, {}),
      (err: unknown) => {
        assert.ok(err instanceof LlmError, '流式 2xx 分支也要有兜底，不能只认 stall');
        assert.equal(isRetryable(err), true);
        return true;
      },
    );
  });
});

test('★ 调用方取消仍然不重试 —— 修复不得把取消复活成重试', async () => {
  const controller = new AbortController();
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const stream = new ReadableStream({
      async start(c) {
        await new Promise((r) => setTimeout(r, 5));
        init?.signal?.addEventListener('abort', () => {
          c.error(new Error('aborted'));
        });
        controller.abort();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => executeJsonRequest('custom', req, { signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.equal(isRetryable(err), false, '人按下的取消不是"稍后再试"');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
