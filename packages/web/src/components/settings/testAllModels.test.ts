/**
 * **一键测试全部模型**（2026-10-14 用户要求）
 *
 * ## 背景
 *
 * 单个模型的「测试」按钮早就有，但**配置了十几个模型时**，逐个点等于十几次
 * 点击 + 十几次等待 —— 而用户真正想回答的问题是"**我这一批模型里哪些是通的**"。
 *
 * ## 设计取舍（本文件钉住这几条）
 *
 * ```
 *   ① 并发 4（不是无限，也不是串行）
 *      每个测试都是真实的上游请求（可能跨洋）。同时发十几个会让网关侧限流
 *      或本机连接打满；而串行在十几个模型时太慢。
 *   ② 进度可见（`测试中 3/8`）
 *      十几个请求可能十几秒；没有进度的等待会被当成"卡住了"，
 *      用户会重复点击 —— 而那会**再发一轮请求**。
 *   ③ 失败不中断整批
 *      一个模型不通不该让其余模型测不了 —— 那正是最需要看到的情况。
 *   ④ 失败也必须**记一条结果**
 *      那一格留空的话，用户看到的是"没测过"，而不是"测了、不通"。
 *   ⑤ 与单个测试共用 `recordTestResult`
 *      两条路径各写一遍错误解析会漂移（本项目反复踩过）。
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(
  new URL('./AiModelsSection.tsx', import.meta.url),
  'utf8',
);

test('★★★ 必须有「一键测试全部」按钮，且在测试期间禁用', () => {
  assert.ok(/一键测试全部/.test(SRC), '★ 必须有这个按钮');
  /*
   * ⚠️ 禁用是关键：重复点击会**再发一轮请求**（十几个模型时是明显浪费，
   * 也可能触发网关限流）。
   */
  assert.ok(
    /disabled=\{batch !== null \|\| models\.length === 0\}/.test(SRC),
    '★ 测试期间必须禁用（重复点击会再发一轮请求）',
  );
});

test('★★★ 并发必须是 4（既快又不打爆网关）', () => {
  assert.ok(
    /Math\.min\(4, targets\.length\)/.test(SRC),
    '★ 并发上限 4 —— 无限并发会打爆网关，串行在十几个模型时太慢',
  );
});

test('★★★ 必须有进度（十几个请求十几秒，没进度会被当成卡住）', () => {
  assert.ok(/batch\.done\}\/\$\{batch\.total/.test(SRC), '★ 必须显示 `测试中 N/M`');
  assert.ok(/setBatch\(\(current\) =>/.test(SRC), '★ 每完成一个要更新进度');
});

test('★★★ 失败不能中断整批，且必须记一条结果', () => {
  /*
   * ⚠️ 判据：`catch` 块里必须调 `recordTestResult`（否则那一格留空 =
   * 用户看到"没测过"而不是"测了、不通"）。
   *
   * ⚠️ 用 `[\s\S]*?` 而不是 `[^}]*` —— 实参是个对象字面量，里面有 `}`，
   * 用 `[^}]*` 会在第一个 `}` 处停住（我第一版就是这么写错的）。
   */
  assert.ok(
    /catch \(err\) \{[\s\S]*?recordTestResult\(id,[\s\S]*?failed \+= 1;/.test(SRC),
    '★ 批量测试的 catch 里必须记一条失败结果并计数',
  );
  assert.ok(/const worker = async/.test(SRC), '★ 用工人函数而不是 Promise.all 全量并发（才能限制并发数）');
});

test('★★★ 单个测试与批量测试必须共用 recordTestResult（防两条路径漂移）', () => {
  const uses = (SRC.match(/recordTestResult\(/g) ?? []).length;
  assert.ok(uses >= 4, `★ recordTestResult 应被单个与批量两处共用（实际出现 ${uses} 次）`);
  assert.ok(
    /const recordTestResult = useCallback/.test(SRC),
    '★ 必须抽成一个函数，而不是两处各写一遍',
  );
});

test('★★★ 结束时给一行汇总（用户要结论，不是自己数格子）', () => {
  assert.ok(/全部通过/.test(SRC) && /个通过 · /.test(SRC), '★ 必须有汇总文案');
  assert.ok(/batchSummary/.test(SRC), '★ 汇总要渲染出来');
});
