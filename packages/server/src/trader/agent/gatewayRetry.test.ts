/**
 * **网关侧失败必须被识别并重试**（2026-10-13）。
 *
 * ## 实测事故
 *
 * ```
 *   ok=false **4 秒**
 *   text: "Failed to authenticate. API Error: 403 OpenCode Zen Free:
 *          OpenCode's free tier can only be used from within OpenCode."
 * ```
 * 而线上 4 个猎手**同时**以这个理由失败：
 * ```
 *   [调研] 4 个来源中 **4 个未产出**
 * ```
 *
 * ## 根因
 *
 * `team-news` 组的 **6 个候选全部是 `opencode-zen-free/*` / `our-free-model/*`**，
 * 而它们**都返回同一个 403** —— 而 **magpie 的组路由【不降级】**。
 * 实测直接调 `group/team-news` 得到的就是那个 403，而不是"试下一个候选"。
 *
 * ## 为什么这个失败值得重试
 *
 * ```
 *   网关侧失败（403/429/额度）→ 往往是暂时的（限流恢复、magpie 换了候选）
 *   任务本身失败（模型查不到）→ 重试一遍还是查不到
 * ```
 * 把两者混在一起，会让"换一组模型就能解决"的问题**静默变成"没有新闻"**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isGatewayUnavailable, runAgentTask, type AgentTaskInput } from './harness.js';

const BASE: AgentTaskInput = {
  task: '查一下今天的新闻',
  workdir: '/tmp/x',
  authToken: 'stub',
};

test('★★★ 认得出网关侧的认证失败（实测那个 403 原文）', () => {
  assert.equal(
    isGatewayUnavailable(
      "Failed to authenticate. API Error: 403 OpenCode Zen Free: OpenCode's free tier can only be used from within OpenCode.",
    ),
    true,
    '★ 实测那条 403 必须被认出来',
  );
});

test('★★★ 认得出限流与额度', () => {
  for (const s of ['429 Too Many Requests', 'rate limit exceeded', 'insufficient quota', 'permission_error']) {
    assert.equal(isGatewayUnavailable(s), true, `★ "${s}" 应当被判为网关侧失败`);
  }
});

test('★★★ 不能把"模型自己说的话"误判成网关失败', () => {
  /*
   * ⚠️ 这是**关键的边界**：模型完全可能在正文里写"我遇到了 403 错误"
   *（例如它在描述某条新闻），而那不该触发重试 ——
   * 重试有成本（每个 claude 进程 150–250MB，服务器只有 2 核）。
   */
  assert.equal(
    isGatewayUnavailable('我今天查到：某交易所返回了 Error: 503，导致行情中断。'),
    false,
    '★ 模型正文里提到错误码不该触发重试',
  );
  assert.equal(
    isGatewayUnavailable('本轮没有查到相关消息。'),
    false,
    '★ 正常回答不该触发重试',
  );
});

test('★★★ 网关失败时会重试一次（而不是直接放弃）', async () => {
  let calls = 0;
  const r = await runAgentTask(BASE, async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, text: 'Failed to authenticate. API Error: 403', latencyMs: 100 };
    }
    return { ok: true, text: '[{"summary":"x"}]', latencyMs: 200 };
  });
  assert.equal(calls, 2, '★ 必须重试一次');
  assert.equal(r.ok, true, '★ 第二次成功时应当返回成功');
  assert.equal(r.latencyMs, 300, '★ 耗时应当是两次之和（审计要准）');
});

test('★★★ 任务本身失败时【不】重试', async () => {
  /*
   * ⚠️ 重试有成本。而"模型说查不到"重试一遍还是查不到。
   */
  let calls = 0;
  const r = await runAgentTask(BASE, async () => {
    calls += 1;
    return { ok: false, text: '', error: 'harness 退出码 1 · 模型超时', latencyMs: 600_000 };
  });
  assert.equal(calls, 1, '★ 非网关失败不该重试（那会白等 10 分钟）');
  assert.equal(r.ok, false);
});

test('★★★ 两次都失败时，两次的原因都要留下', async () => {
  /*
   * ⚠️ 只报第二次的原因会让排查时不知道"第一次与第二次是不是同一个原因" ——
   * 而那决定了该改什么（换模型 vs 查网络）。
   */
  let calls = 0;
  const r = await runAgentTask(BASE, async () => {
    calls += 1;
    return { ok: false, text: '', error: `第${calls}次的错误`, latencyMs: 50 };
  });
  assert.equal(calls, 1, '★ 这条桩不是网关失败，所以不重试');
  /* 用网关失败重跑一次，验证两次原因都留下。 */
  let c2 = 0;
  const r2 = await runAgentTask(BASE, async () => {
    c2 += 1;
    return { ok: false, text: '', error: c2 === 1 ? '429 限流' : '403 拒绝', latencyMs: 50 };
  });
  assert.equal(c2, 2, '★ 网关失败要重试');
  assert.ok(r2.error?.includes('429'), '★ 第一次的原因要留下');
  assert.ok(r2.error?.includes('403'), '★ 第二次的原因也要留下');
  void r;
});

test('★ 空任务不重试（那是调用方的 bug，不是网关问题）', async () => {
  let calls = 0;
  const r = await runAgentTask({ ...BASE, task: '   ' }, async () => {
    calls += 1;
    return { ok: false, text: '', error: 'Failed to authenticate 403', latencyMs: 1 };
  });
  assert.equal(calls, 0, '★ 空任务应当直接返回，不该起进程');
  assert.equal(r.ok, false);
});
