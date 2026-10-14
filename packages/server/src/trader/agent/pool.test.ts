import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapConcurrent } from './pool.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('★ 保持输入顺序（不能按完成先后返回）', async () => {
  /* 故意让前面的慢、后面的快 —— 顺序错了就会被抓到。 */
  const out = await mapConcurrent([3, 2, 1], 3, async (n) => {
    await sleep(n * 30);
    return n;
  });
  assert.deepEqual(
    out.map((r) => (r.ok ? r.value : null)),
    [3, 2, 1],
    '★ 结果必须与输入同序 —— 否则"第几个标的"会对错人',
  );
});

test('★★★ 并发上限被真正执行（这是它存在的唯一理由）', async () => {
  /*
   * 实测背景：claude code 单进程约 250MB，20 个并行 ≈ 5GB。
   * 用户说的"不限制并发"是 **magpie 侧**；服务器侧是真约束。
   */
  let running = 0;
  let peak = 0;
  await mapConcurrent(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(25);
    running -= 1;
    return 0;
  });
  assert.ok(peak <= 4, `★ 同时最多 4 个，实测峰值 ${peak}`);
  assert.ok(peak >= 2, `★ 但要真的并发（峰值只有 ${peak} 说明退化成串行了）`);
});

test('★★ 总耗时 ≈ 最慢那一个，而不是"分批之和"（工人池要能摊平）', async () => {
  /*
   * 4 个任务、上限 2：
   *   · 好实现（工人池领取）：≈ 第 3、4 个接着跑 → 总耗时 ≈ 两批里较慢的那批
   *   · 坏实现（切成 2 份固定分配）：[慢,快] + [慢,快] → 尾巴更长
   *
   * 这里用"耗时不均"来区分：任务 0 很慢，其余很快。
   */
  const t0 = Date.now();
  await mapConcurrent([200, 10, 10, 10], 2, async (ms) => {
    await sleep(ms);
    return ms;
  });
  const elapsed = Date.now() - t0;
  /* 理想 ≈ 200ms（慢的那个独占一个工人，其余三个挤另一个工人）。
     若实现是"固定切两份"，第二批会等第一批整体结束 → 明显超过 260ms。 */
  assert.ok(elapsed < 300, `★ 工人池要摊平尾巴（实测 ${elapsed}ms，理想约 200ms）`);
});

test('★★ 单个任务抛错 → 只标记它失败，其余照常产出', async () => {
  const out = await mapConcurrent([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('这个标的的数据源抽了');
    return n * 10;
  });
  assert.equal(out[0]!.ok, true);
  assert.equal(out[1]!.ok, false);
  assert.equal(out[2]!.ok, true, '★ 一个失败不能让整批失败');
  if (!out[1]!.ok) {
    assert.ok(out[1]!.error.includes('数据源'), '要保留原始错误信息');
    assert.equal(out[1]!.index, 1, '要能定位是第几个元素失败');
  }
});

test('★ limit < 1 抬到 1（是"串行"，不是"不跑"）', async () => {
  const out = await mapConcurrent([1, 2, 3], 0, async (n) => n);
  assert.equal(out.length, 3);
  assert.ok(out.every((r) => r.ok), '★ 不能因为 limit 配错就什么都不做');
});

test('★ 空输入 → 空输出（不起工人）', async () => {
  const out = await mapConcurrent([], 4, async () => 1);
  assert.deepEqual(out, []);
});

/* -------------------------------------------------------------------------- */
/*  NaN 的 limit 不能被静默吞掉（外部 issue #154）                              */
/* -------------------------------------------------------------------------- */

/*
 * ## 缺陷链
 *
 * `tradingDesk.ts:1431` 读环境变量时**没有 NaN 兜底**（同文件 `:1219` 与
 * `manager.ts:842/864` 都有）：
 *
 * ```ts
 * const concurrency = Number(process.env.AQ_ANALYST_CONCURRENCY ?? 4);
 * ```
 *
 * `AQ_ANALYST_CONCURRENCY=abc` → `NaN` → 传进这里：
 *
 * ```
 * Math.max(1, Math.floor(NaN)) = NaN        ← NaN 传染，钳制失效
 * Array.from({length: Math.min(NaN, n)}) → 0 个工人
 * new Array(items.length) → 稀疏数组（洞，不是 null）
 * ```
 *
 * 于是下游 `for (const a of outcome.analyses)` 对稀疏数组产出 `undefined`，
 * `deskOutput.ts:275` 解引用 `.role` 抛 `TypeError` —— 而那个异常冒到
 * `runCycle` 的 catch，**每一轮都失败**，最终进 `safe_mode`。
 *
 * ## 为什么这条用例放在 `pool.test.ts` 而不是只修调用方
 *
 * `mapConcurrent` 是**公用件**。"NaN 静默产出空数组"对**任何**调用方都是陷阱，
 * 所以公用件自己不该被 NaN 击穿 —— 按 `docs/AGENTS.md` §4.5
 * 「不要把校验加在错误的层」的正面应用：**两层都修**。
 *
 * ⚠️ 既有用例 `limit < 1 抬到 1` 覆盖了 `0`，但**没有覆盖 NaN** ——
 * 而 `Math.max(1, NaN)` 是 `NaN`（不是 1），所以那个"抬到 1"的保证
 * 在 NaN 上**失效**。这正是它长期潜伏的原因。
 */
test('★★★ limit 是 NaN 时不能产出空数组 —— 必须兜底成一个能跑的值', async () => {
  const results = await mapConcurrent([1, 2, 3, 4], Number.NaN, async (n) => n * 2);

  assert.equal(results.length, 4, '★ 结果长度必须等于输入长度');
  assert.ok(
    results.every((r) => r.ok),
    '★★★ NaN 的 limit 不能导致"一个任务都没跑" —— 那会让下游拿到 undefined 并崩溃（issue #154）',
  );
  /* 真的跑了，而不只是"长度对、内容空"。稀疏数组在这里会暴露成 undefined。 */
  assert.deepEqual(
    results.map((r) => (r.ok ? r.value : null)),
    [2, 4, 6, 8],
    '★ 每个元素都要真的被处理过 —— 稀疏数组会在这里显示成 [null,null,null,null]',
  );
});

test('★★ Infinity 的 limit 是"不限并发"，不是 NaN —— 要能正常跑完', async () => {
  const results = await mapConcurrent([1, 2, 3], Number.POSITIVE_INFINITY, async (n) => n);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok), '★ Infinity 应当正常跑完（它是合法的"不限"）');
});

test('★★ NaN 兜底之后并发上限仍然生效 —— 修 NaN 不能把限流一起放宽', async () => {
  /*
   * 反向守卫：兜底值不能是 Infinity（那会让"不限并发"变成默认行为）。
   * 这里只验证"兜底成一个有限值" —— 具体是几不重要，重要的是**有限**。
   */
  let running = 0;
  let peak = 0;
  await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), Number.NaN, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(5);
    running -= 1;
    return 0;
  });
  assert.ok(
    Number.isFinite(peak) && peak < 20,
    `★★ NaN 兜底后仍必须限流（实测峰值 ${peak}）—— 兜底成 Infinity 等于关掉并发上限`,
  );
});
