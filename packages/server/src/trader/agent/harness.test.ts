import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentTask, type AgentTaskInput, type AgentTaskResult, type SpawnAgent } from './harness.js';

/*
 * ⚠️ 这些测试**不真的起 harness 进程**。
 *
 * 两个理由：
 * ① 本机沙箱下 `spawn` + `stdio: 'pipe'` 会 EPERM（见工具说明），
 *    而生产（服务器）没有这个限制 —— 所以"能不能起进程"由服务器实测覆盖，
 *    这里覆盖的是**任务编排与错误语义**；
 * ② 真实 harness 的调用成本与耗时不该进单元测试。
 */

const fake = (r: Partial<AgentTaskResult>, seen?: AgentTaskInput[]): SpawnAgent =>
  async (input) => {
    seen?.push(input);
    return { ok: true, text: '（假产出）', latencyMs: 1, ...r };
  };

test('★ 把任务原样交给 agent（含工具白名单与模型档）', async () => {
  const seen: AgentTaskInput[] = [];
  const out = await runAgentTask(
    {
      task: '查今天 BTC 的三条新闻',
      allowedTools: 'WebSearch,WebFetch',
      model: 'group/team-news',
      fastModel: 'group/team-grunt',
      workdir: '/tmp/x',
      authToken: 'k',
    },
    fake({ ok: true, text: '三条新闻…' }, seen),
  );
  assert.equal(out.ok, true);
  assert.equal(out.text, '三条新闻…');
  assert.equal(seen[0]!.task, '查今天 BTC 的三条新闻');
  assert.equal(seen[0]!.model, 'group/team-news', '★ 该用哪档模型要传下去');
  assert.equal(seen[0]!.allowedTools, 'WebSearch,WebFetch');
});

test('★★★ 任务为空 → 明确失败，不是"静默没干活"', async () => {
  /*
   * 这条防的是"派活的人忘了写任务"。
   *
   * 若不拦，现象会是：agent 起来了、跑了、产出空字符串 ——
   * 而调用方看到的是"这个研究员这轮没产出"，
   * **真正的原因（任务没写）被掩盖**。
   */
  const out = await runAgentTask(
    { task: '   ', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: true, text: '不该被调用' }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes('任务为空'), `错误要说清楚（实际：${out.error ?? ''}）`);
});

test('★★★ 没装 harness 时错误信息要指向"环境没装好"（不能像"这个角色没产出"）', async () => {
  /*
   * 实测过这个坑的形状：一个角色失败，日志只说"失败：…"，
   * 而真相是**服务器上根本没装 harness** —— 排查会走很远。
   *
   * 所以这条断言：错误里必须出现可执行的线索。
   */
  const out = await runAgentTask(
    { task: '查新闻', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: false, text: '', error: '起不了 harness（/opt/…/claude）：spawn ENOENT —— 需要先安装' }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes('harness'), '错误要提到 harness');
  assert.ok(out.error?.includes('安装'), '错误要给出下一步（安装）');
});

test('★ agent 超时 → 标记失败并带上耗时（编排据此决定要不要继续）', async () => {
  const out = await runAgentTask(
    { task: '查新闻', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: false, text: '', error: 'agent 超过 300 秒未返回', latencyMs: 300_000 }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.latencyMs, 300_000, '耗时必须回传 —— 它是判断"这个角色是不是坏模型"的依据');
});
