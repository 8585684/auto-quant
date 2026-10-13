/**
 * **"维护系统的程序员"必须真的在跑**（2026-10-13）。
 *
 * ## 用户需求 ⑤ 的原话
 *
 * > 「…**有维护系统的程序员**、有汇报工作的、有文员…」
 * > 「这次更新你得搞智能体团队**持续观察、测试**，然后反馈给你做相应的处理，
 * >  **不要有任何BUG，也不要老让我来测试和发现问题**」
 *
 * ## ⚠️ 这个文件存在的理由：我**两次**犯了"建了没接上"
 *
 * ```
 *   第一次：在 roles.ts 里定义了 engineer / reporter / clerk 三个角色，
 *           跑测试全绿、typecheck 全过 —— 但【生产代码里 0 处调用】。
 *           `system_health` 这个 contextFor 甚至【没有任何消费者】。
 *
 *   第二次：在 orchestrator.ts 里实现了 runHealthCheck()，
 *           同样是"定义 + 测试全绿 + 0 处调用"。
 * ```
 * **两次都是"看起来完成了"。** 而判据很简单：
 * ```
 *   grep "runHealthCheck" packages/server/src/trader/  →  应该【不止定义那一行】
 * ```
 *
 * 这个文件把这个判据变成断言 —— 因为**这正是用户最在意的那件事**
 *（"不要有BUG，也不要老让我来测试和发现问题"）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildHealthFacts } from './runtime.js';
import { codeOnly } from '../../testUtils/sourceText.js';

const RUNTIME = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
const ORCH = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

/* -------------------------------------------------------------------------- */
/*  接线                                                                       */
/* -------------------------------------------------------------------------- */

test('★★★ `runHealthCheck` 必须被【真正调用】（不是只有定义）', () => {
  /*
   * ⚠️ 判据用"剥掉注释后统计出现次数 >= 2"（定义 1 次 + 调用 1 次）——
   * 只看"含这个字符串"会命中文档注释（我第一版就是这么假通过的）。
   */
  const code = codeOnly(RUNTIME);
  const hits = [...code.matchAll(/runHealthCheck\s*\(/g)].length;
  assert.ok(
    hits >= 2,
    `★ \`runHealthCheck\` 在 runtime.ts 里只出现 ${hits} 次 —— 那说明【只有定义、没有调用】`,
  );
  /* 且必须是从 orchestrator 导入的（不是自己又定义了一个）。 */
  assert.ok(
    /import\s*\{[\s\S]{0,200}runHealthCheck[\s\S]{0,200}\}\s*from\s*'\.\/orchestrator\.js'/.test(code),
    '★ 必须从 orchestrator 导入 `runHealthCheck`',
  );
});

test('★★★ 体检必须挂在实际的审视路径上（否则它永远不会跑）', () => {
  /*
   * `runHealthCheck` 只在 `runReview` 里被调用 —— 而 `runReview` 是审视入口。
   * 若哪天有人把那条调用删了，这里会红。
   */
  const code = codeOnly(RUNTIME);
  const idx = code.indexOf('private async runReview');
  assert.ok(idx >= 0, '★ 找不到 `runReview`');
  const body = code.slice(idx, idx + 3500);
  assert.ok(
    /void this\.runHealthCheck\(\)/.test(body),
    '★ `runReview` 里必须有 `void this.runHealthCheck()`（`void` = 不 await，不阻塞交易循环）',
  );
});

test('★★★ 体检必须【不 await】（它不能把交易周期撑长）', () => {
  /*
   * 与 `runtime.ts` 文件头 §2 那条纪律一致：
   * "绝不阻塞交易循环太久…调用方用 `void` 触发、不 `await`"。
   * ⚠️ 与复盘（`reviewTrade`）同样的处理方式。
   */
  const code = codeOnly(RUNTIME);
  assert.ok(
    /void this\.runHealthCheck\(\)/.test(code),
    '★ 必须是 `void this.runHealthCheck()`，不能是 `await this.runHealthCheck()`',
  );
});

test('★★★ 体检失败不能让交易周期失败（附加能力，不是前置条件）', () => {
  /*
   * 文件头 §1："**绝不抛穿。** 智能体是附加能力。它坏了…都不该让机器人停止交易。"
   */
  const code = codeOnly(ORCH);
  const idx = code.indexOf('export async function runHealthCheck');
  assert.ok(idx >= 0, '★ 找不到 `runHealthCheck`');
  const body = code.slice(idx, idx + 4200);
  assert.ok(/try\s*\{/.test(body), '★ 必须有 try');
  assert.ok(/catch\s*\(/.test(body), '★ 必须有 catch（吞掉异常）');
  /* 而 runtime 侧也要有一层 try（两层都要，因为 log 本身也可能抛）。 */
  const rtIdx = codeOnly(RUNTIME).indexOf('private async runHealthCheck');
  const rtBody = codeOnly(RUNTIME).slice(rtIdx, rtIdx + 3200);
  assert.ok(/try\s*\{/.test(rtBody) && /catch\s*\(/.test(rtBody), '★ runtime 侧也要吞异常');
});

/* -------------------------------------------------------------------------- */
/*  事实的构造（这才是这个角色的成败所在）                                        */
/* -------------------------------------------------------------------------- */

const runs = [
  { outcome: 'ok', detail: null, latencyMs: 12000, steps: 7 },
  { outcome: 'failed', detail: '单次调用的输出无法解析：badJson at 3', latencyMs: 4000, steps: 1 },
  { outcome: 'failed', detail: '单次调用的输出无法解析：badJson at 8', latencyMs: 4100, steps: 1 },
  { outcome: 'failed', detail: '单次调用的输出无法解析：badJson at 5', latencyMs: 3900, steps: 1 },
  { outcome: 'degraded', detail: '达到步数上限（8 步）仍未结束，本轮没有结论', latencyMs: 60000, steps: 8 },
];

test('★★★ 事实里必须有【失败率】（"静默失败"的第一判据）', () => {
  const facts = buildHealthFacts(runs, 11);
  assert.ok(facts.includes('failed: 3 次'), `★ 必须给出 failed 的次数（实际：\n${facts}`);
  assert.ok(facts.includes('60%'), '★ 必须给出百分比（3/5 = 60%）');
});

test('★★★ 同一个失败的不同实例必须被聚合成【一类】（这是区分"系统性"与"抖动"的关键）', () => {
  /*
   * ⚠️ 这是本函数最容易写错的地方：
   * 三条 failed 的 `detail` 里带着**不同的数字**（at 3 / at 8 / at 5）——
   * 按原文字符串分组会让它们看起来像 3 种不同的问题，
   * 而它们其实是**同一个问题**（badJson）。而"同一个原因 N 次 = 系统性问题"
   * 正是这个角色要抓的核心信号。
   */
  const facts = buildHealthFacts(runs, 11);
  assert.ok(
    /3 次 · 形状/.test(facts),
    `★ 三条同形状的失败必须聚合成"3 次"（实际：\n${facts}`,
  );
  /* 而"达到步数上限"是另一类（只 1 次）。 */
  assert.ok(facts.includes('1 次 · 形状'), '★ 不同形状的失败要分开计');
});

test('★★★ 事实必须包含耗时与步数（"比基线慢很多倍"的判据）', () => {
  const facts = buildHealthFacts(runs, 11);
  assert.ok(/中位 \d+ms/.test(facts), '★ 必须有中位耗时');
  assert.ok(/最大 \d+ms/.test(facts), '★ 必须有最大耗时');
  assert.ok(/最大步数 8/.test(facts), '★ 必须有最大步数');
});

test('★★★ 必须如实告诉它【没查什么】（否则"看起来正常"会掩盖真问题）', () => {
  const facts = buildHealthFacts(runs, 11);
  assert.ok(
    facts.includes('没有') && facts.includes('日志'),
    '★ 必须说清"你看不到服务器日志"—— 这条与 roles.ts 里 engineer 的 notChecked 呼应',
  );
});

test('★ 没有失败时也必须能构造事实（不能抛）', () => {
  const facts = buildHealthFacts([{ outcome: 'ok', detail: null, latencyMs: 5000, steps: 6 }], 11);
  assert.ok(facts.includes('这段时间没有失败'), '★ 全 ok 时要明说"没有失败"');
});

test('★ 空数组也要能构造（首次运行时 agent_runs 可能是空的）', () => {
  const facts = buildHealthFacts([], 11);
  assert.ok(typeof facts === 'string' && facts.length > 0, '★ 空输入不能抛，要返回可读文本');
});
