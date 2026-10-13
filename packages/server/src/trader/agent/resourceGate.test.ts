/**
 * **决策与调研的资源仲裁**（2026-10-13）。
 *
 * ## 为什么值得一条测试
 *
 * 实测症状：`technical` 报"超过 120 秒未返回"，**而空载时同一个任务只要 10–13 秒**。
 * 差别只有一个：**线上同时还有后台调研在抢 CPU**（服务器只有 **2 核**）。
 *
 * 这类问题的特点是：**它不报错、不崩溃，只是"某个角色偶尔超时"** ——
 * 而人会把它归因成"模型慢"，从而去调超时（治不好）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { criticalDepthNow, enterCritical, leaveCritical, runOutsideCritical } from './resourceGate.js';

test('★★★ 计数成对：enter/leave 后回到 0', () => {
  assert.equal(criticalDepthNow(), 0);
  enterCritical();
  assert.equal(criticalDepthNow(), 1);
  enterCritical();
  assert.equal(criticalDepthNow(), 2);
  leaveCritical();
  leaveCritical();
  assert.equal(criticalDepthNow(), 0);
});

test('★★★ 多减不会变负（否则"永远 > 0"就等于关掉了调研）', () => {
  /*
   * ⚠️ 若计数变负，之后一次 `enterCritical()` 就把它拉回 0 ——
   * 于是"决策正在进行"这个事实**看起来不存在**，调研照常抢 CPU。
   */
  leaveCritical();
  leaveCritical();
  assert.equal(criticalDepthNow(), 0);
});

test('★★★ 关键区内启动调研 → 它会等（让路）', async () => {
  enterCritical();
  let ran = false;
  const started = Date.now();
  const p = runOutsideCritical(async () => {
    ran = true;
    return 'done';
  }, { waitMs: 40, maxWaitMs: 2_000 });
  /* 关键区还没结束 → 它不该跑。 */
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran, false, '★ 关键区内调研必须让路');
  leaveCritical();
  assert.equal(await p, 'done');
  assert.ok(Date.now() - started >= 100, '★ 它应当等了至少一个轮询间隔');
});

test('★★★ 关键区外 → 立即执行（不白等）', async () => {
  const t0 = Date.now();
  const r = await runOutsideCritical(async () => 'now', { waitMs: 100, maxWaitMs: 5_000 });
  assert.equal(r, 'now');
  assert.ok(Date.now() - t0 < 50, '★ 没有关键工作时不等待');
});

test('★★★ 等待超时后【仍然执行】—— 不能让调研被永远饿死', async () => {
  /*
   * ⚠️ 这是刻意的取舍：若因为"决策一直不停"而永远不调研，
   * 团队就永远拿不到新闻 —— **那比"争一点 CPU"更糟**。
   * 宁可让它偶尔撞一下，也不要让一个功能**静默停止**。
   */
  enterCritical();
  const t0 = Date.now();
  const r = await runOutsideCritical(async () => 'ran-anyway', { waitMs: 30, maxWaitMs: 200 });
  const ms = Date.now() - t0;
  leaveCritical();
  assert.equal(r, 'ran-anyway');
  assert.ok(ms >= 180, `★ 应当先等满 maxWaitMs（实际 ${ms}ms）`);
});

test('★★★ 关键区内抛错也要能释放（否则调研永久停摆）', async () => {
  await assert.rejects(async () => {
    enterCritical();
    try {
      throw new Error('boom');
    } finally {
      leaveCritical();
    }
  });
  assert.equal(criticalDepthNow(), 0, '★ finally 必须配对');
});
