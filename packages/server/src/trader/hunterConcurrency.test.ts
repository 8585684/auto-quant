/**
 * **猎手并发数必须与 CPU 核数相称**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"单独跑很快、并发跑就死"**的性能 BUG —— 而且它的表现
 * （"agent 超过 600 秒未返回"）看起来像"任务太难"或"模型太慢"，
 * 完全不像"我把它饿死了"。
 *
 * ## 实测证据
 *
 * ```
 *   单独实测同一个猎手任务： ok=true 耗时 **92.7 秒**（搜到了真实新闻）
 *   线上并发跑四个：        **3 个未产出**（每个都"超过 600 秒未返回"）
 * ```
 * **同一个任务，单独 93 秒，并发 >600 秒** —— 差 6.5 倍。
 *
 * ## 根因
 *
 * ```
 *   服务器：2 核 / 1971MB（可用仅 822MB）
 *   实测：  3 个 claude 进程同时在跑（171MB + 93MB + …）
 * ```
 * 每个猎手是**一整个 claude code 进程**（自带 node 运行时）——
 * 2 核被切成 5–6 份，每个都慢 6 倍以上 → 全部超时。
 *
 * ## 而代价是不对称的
 *
 * ```
 *   慢 6 分钟（串行）→ 调研在【后台】跑，决策不等它 → **没有代价**
 *   全部超时        → 团队永远拿不到新闻（实测裁决官：「材料无新闻、无情绪」）→ **功能失效**
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { codeOnly } from '../testUtils/sourceText.js';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');


const CODE = codeOnly(MANAGER);

test('★★★ 猎手并发数默认不能是硬编码的 2', () => {
  /*
   * ⚠️ 这是那个 BUG 的**直接形状**：`?? 2`。
   * 在 2 核机器上那意味着"每个猎手只分到 1/3 个核"。
   */
  assert.ok(
    !/AQ_HUNTER_CONCURRENCY \?\? ''\) \|\| 2\b/.test(CODE),
    '★ 默认并发不能再是硬编码的 2（那是"全部超时"的直接原因；注释里引用不算）',
  );
  assert.ok(
    MANAGER.includes('AQ_HUNTER_CONCURRENCY'),
    '★ 仍要允许显式覆盖（有更多核时可以调大）',
  );
});

test('★★★ 并发数必须由 CPU 核数推导', () => {
  assert.ok(
    MANAGER.includes("from 'node:os'") && MANAGER.includes('cpus()'),
    '★ 必须读 CPU 核数（并发数的唯一合理依据）',
  );
  /* 核数必须真的进入算术（不只是 import 了）。 */
  assert.ok(
    /cpus\(\)\.length/.test(MANAGER),
    '★ 核数必须真的被用来算并发',
  );
});

test('★★★ 并发数只能有【一处】实现（同一个算术写两遍 = 改一处等于没改）', () => {
  /*
   * ⚠️ 这条是**实测教训**：`?? 2` 在文件里出现过**两处**
   *（`refreshResearch` 与另一条调研路径），我只改了第一处 ——
   * 而上面那条断言**当场抓到了第二处**。
   *
   * 所以现在两处都调 `hunterConcurrency()`，而这条测试**钉住"只有一处"**。
   */
  const occurrences = CODE.match(/AQ_HUNTER_CONCURRENCY/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    `★ AQ_HUNTER_CONCURRENCY 只该在 hunterConcurrency() 里出现一次（实际 ${occurrences.length} 次）`,
  );
  assert.ok(
    /function hunterConcurrency\(\)/.test(CODE),
    '★ 必须有那个唯一的实现',
  );
});

test('★ 并发数有上限 —— 再多会互相饿死', () => {
  /*
   * 16 核上开 8 个 claude 进程也会把内存吃光（每个 150–250MB）。
   * 所以必须封顶。
   */
  assert.ok(
    /Math\.min\(3,/.test(CODE),
    '★ 必须有上限（每个 claude 进程 150–250MB，不能无限开）',
  );
});
