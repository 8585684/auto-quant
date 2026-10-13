/**
 * **调研的三个数字必须自洽**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这三个数字分散在两处（间隔在 `ensureResearchRefresher` 里、
 * TTL 在 `researchTtlMs` 里），而它们**必须满足一个不等式** ——
 * 否则会出现"决策在两份情报之间读到空窗"。
 *
 * ## 原来那三个数字互相矛盾
 *
 * ```
 *   后台刷新间隔   10 分钟
 *   缓存 TTL       15 分钟
 *   调研实际耗时   **22.1 分钟**   ← 实测（4 猎手串行，全部有产出）
 * ```
 * 后果：每 10 分钟起一次调研（而一次 22 分钟）→ 缓存 15 分钟就过期 →
 * **决策经常读到"已过期"的缓存**，而它本可以读上一份
 *（新闻不是秒级变化的）。
 *
 * ## 为什么"6–8 分钟"那个依据是错的
 *
 * 那时是**并发 2**（四个猎手两批），而那个配置下**每个都超时** ——
 * "6–8 分钟"是"超时前跑的那一段"，不是"真的跑完"。
 * 现在串行（并发 1）**真的跑完了**，耗时 22.1 分钟。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}
const CODE = codeOnly(MANAGER);

test('★★★ TTL 必须【由刷新间隔推导】，而不是写死', () => {
  /*
   * ⚠️ 这是那个矛盾的直接形状：`?? 15 * 60_000`（写死）与间隔无关。
   */
  assert.ok(
    !/return Number\(process\.env\.AQ_RESEARCH_TTL_MS \?\? 15 \* 60_000\)/.test(CODE),
    '★ TTL 不能再写死 15 分钟（它与刷新间隔无关，会产生空窗）',
  );
  assert.ok(
    /researchIntervalMs\(\) \+ 10 \* 60_000/.test(CODE),
    '★ TTL 应当 = 刷新间隔 + 10 分钟',
  );
});

test('★★★ 刷新间隔只能有【一处】实现（同一个算术写两遍 = 改一处等于没改）', () => {
  /*
   * ⚠️ 本项目已经踩过两次这个坑（`AQ_HUNTER_CONCURRENCY` 两处、
   * `AQ_RESEARCH_TIMEOUT_MS` 两处）。间隔与 TTL 必须共用同一个来源。
   */
  const occurrences = CODE.match(/AQ_RESEARCH_INTERVAL_MS/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    `★ AQ_RESEARCH_INTERVAL_MS 只该在 researchIntervalMs() 里出现一次（实际 ${occurrences.length} 次）`,
  );
  assert.ok(/function researchIntervalMs\(\)/.test(CODE), '★ 必须有那个唯一的实现');
});

test('★★★ 默认刷新间隔必须大于实测调研耗时（22.1 分钟）', () => {
  /*
   * ⚠️ 间隔比调研耗时短 → 下一轮必然撞上还没跑完的那轮。
   * 实测 4 猎手串行 = 22.1 分钟（199+257+359+510 秒）。
   *
   * 而**不能**把默认设成"刚好 22 分钟"：不同机器/档位下耗时差很多，
   * 所以要留余量。这里断言它 ≥ 20 分钟。
   */
  const m = /return Number\.isFinite\(raw\) && raw >= 60_000 \? raw : (\d+) \* 60_000/.exec(CODE);
  assert.ok(m !== null, '★ 必须能取出默认间隔');
  const minutes = Number(m[1]);
  assert.ok(
    minutes >= 20,
    `★ 默认间隔应当 ≥ 20 分钟（实测一次调研 22.1 分钟，实际 ${minutes}）`,
  );
});
