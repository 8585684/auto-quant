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
