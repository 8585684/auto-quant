/**
 * **后台调研循环的生命周期**（2026-10-13）。
 *
 * ## 为什么必须有这条测试
 *
 * 实测发现一个**真实的资源泄漏**：
 * ```
 *   #11 status = stopped          ← 机器人已停止
 *   claude 进程数: 2              ← 但还有进程在跑！
 * ```
 * 核实后：`researchRefreshers` 这个 Map **只在创建处出现，从未被清理** ——
 * 于是机器人停止后，后台调研**每 10 分钟照常起 4 个 claude 进程**。
 *
 * **它不会报错、界面上看不见**，只是安静地吃 CPU/内存
 *（实测单个 claude 进程约 250MB）。
 *
 * ⚠️ 这正是本项目反复强调的那类失败：**看不出异常的失效**。
 * 所以它值得一条专门的测试 —— 而不是靠"下次想起来检查一下"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

test('★★★ `stopResearchRefresher` 必须存在且真的清定时器与缓存', () => {
  assert.ok(
    SRC.includes('export function stopResearchRefresher'),
    '★ 缺了它 → 机器人停止后后台调研会一直跑（真实泄漏）',
  );
  const fn = SRC.slice(SRC.indexOf('export function stopResearchRefresher'));
  assert.ok(fn.includes('clearInterval('), '★ 必须真的清掉定时器');
  assert.ok(fn.includes('researchRefreshers.delete('), '★ 必须从 Map 里删掉（否则再也起不来）');
  /*
   * ⚠️ 缓存也要清：机器人停掉后再启动时，一份 10 分钟前的旧情报没有意义 ——
   * 而留着它会让**新启动的第一轮基于旧情报决策**。
   */
  assert.ok(fn.includes('researchCache.delete('), '★ 必须同时清缓存');
});

test('★★★ `stopTrader` 必须调用它（定义了但没人调 = 泄漏照旧）', () => {
  /*
   * ⚠️ 这是本项目踩过多次的形状：**实现了逻辑 ≠ 逻辑在生效**。
   *（`freshness` 曾在跑但输入字段不存在；四个 magpie 路由组建了 30 轮却从未接线。）
   */
  const stopIdx = SRC.indexOf('async stopTrader(');
  assert.ok(stopIdx > 0, '找不到 stopTrader');
  /* 取 stopTrader 到下一个 `async ` 方法之间的一段。 */
  const body = SRC.slice(stopIdx, SRC.indexOf('\n  async ', stopIdx + 10));
  assert.ok(
    body.includes('stopResearchRefresher(traderId)'),
    '★ stopTrader 里必须调用 stopResearchRefresher —— 否则泄漏照旧',
  );
});

test('★ 幂等：重复 start 不该堆出多个定时器', () => {
  /*
   * ⚠️ `research()` 每轮都调 `ensureResearchRefresher` ——
   * 若每次都起一个定时器，几分钟内就会堆出几十个 claude 进程。
   */
  const fn = SRC.slice(SRC.indexOf('function ensureResearchRefresher'));
  assert.ok(
    fn.includes('if (researchRefreshers.has(traderId)) return;'),
    '★ 必须有"已存在就返回"的闸门',
  );
});

test('★★★ 停止时必须【中止在飞的猎手进程】—— 只清定时器不够', () => {
  /*
   * ## 实测
   *
   * 修了定时器泄漏之后，线上仍看到：
   * ```
   *   #11 status = stopped
   *   claude 进程 2 个，etime 00:27     ← 仍在跑
   * ```
   * 它们是"启动时立刻跑一次"那批 —— **已经起飞的进程停不下来**，
   * 会跑完（约 200–600 秒）才自然退出，期间每个约 150–250MB。
   *
   * ## 这条测试钉住什么
   *
   * `stopResearchRefresher` 必须**同时** abort 那个 controller，
   * 而 `harness` 必须真的把 signal 接上（否则 abort 只是个没人听的信号）。
   */
  const fn = SRC.slice(SRC.indexOf('export function stopResearchRefresher'));
  assert.ok(fn.includes('controller.abort()'), '★ 必须 abort 在飞的调研');
  assert.ok(fn.includes('researchAborts.delete('), '★ 必须清掉 controller 引用');

  /* harness 必须支持 signal，并且真的用它 kill 进程。 */
  const harness = readFileSync(new URL('./agent/harness.ts', import.meta.url), 'utf8');
  assert.ok(harness.includes('signal?: AbortSignal'), '★ harness 必须接受中止信号');
  assert.ok(
    harness.includes("addEventListener('abort'"),
    '★ 必须真的监听 abort（只声明参数而不监听 = 信号没人听）',
  );
  assert.ok(harness.includes("child.kill('SIGKILL')"), '★ 收到 abort 时必须杀进程');
});
