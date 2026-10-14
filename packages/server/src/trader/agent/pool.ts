/**
 * **并发闸门** —— 限制"同时跑几个 agent"。
 *
 * ## 为什么必须有它（用户 2026-10-12 的建议带来的必要件）
 *
 * 用户提议把"20 个标的一次性分析"改成"**20 个并行子代理，一人一个**"。
 * 方向是对的（见设计文档附五十五），但有一个**服务器侧的硬约束**：
 *
 * ```
 *   实测：claude code 单个进程约占 250MB 常驻内存
 *   20 个并行 ≈ 5GB
 * ```
 *
 * ⚠️ 用户说的"**不限制并发和用量**"指的是 **magpie 侧**（模型调用）。
 * **服务器侧的 CPU / 内存 / 文件句柄是真实约束** —— 那是我们自己的机器。
 *
 * 所以：**并发要开，但要有闸门**。例如同时跑 4–6 个，
 * 其余排队 —— 这仍然比"一次读 6 万字"快得多。
 *
 * ## 为什么不是 `Promise.all`
 *
 * `Promise.all(items.map(fn))` 会**一次性起全部** —— 20 个就是 20 个进程。
 * 而这个函数**最多同时起 `limit` 个**。
 *
 * ## 为什么不用现成的库
 *
 * 它只有二十来行，而且是**纯函数**（无依赖、可测）。
 * 为它引一个依赖不符合"不重复造轮子"的本意 —— 那条说的是**别重写 agent 运行时**，
 * 不是"别写 20 行的循环"。
 */

/**
 * 并发地跑 `fn`，**最多同时 `limit` 个**；保持输入顺序返回结果。
 *
 * @param items 要处理的元素
 * @param limit 同时最多几个（< 1 会被抬到 1 —— 那是"串行"，不是"不跑"）
 * @param fn 处理单个元素；**抛错会被捕获成 `{ ok: false, error }`**，不会中断其它任务
 *
 * ## ⚠️ `limit` 必须挡住 NaN（外部 issue #154）
 *
 * 原来的钳制是 `Math.max(1, Math.floor(limit))` —— 而 **`Math.max(1, NaN)` 是 `NaN`**
 *（NaN 会传染，不是被 max 吸收）。于是：
 *
 * ```
 * size = NaN
 * Array.from({length: Math.min(NaN, n)}) → 0 个工人        ← 一个任务都不跑
 * new Array(items.length) → 稀疏数组（洞，不是 null）        ← 下游拿到 undefined
 * ```
 *
 * 实测后果：`tradingDesk.ts:1431` 把 `AQ_ANALYST_CONCURRENCY=abc` 读成 NaN 之后，
 * `deskOutput.ts:275` 的 `for (const a of outcome.analyses)` 对稀疏数组产出 `undefined`，
 * 解引用 `.role` 抛 `TypeError` → 冒到 `runCycle` 的 catch → **每一轮都失败** → 进 `safe_mode`。
 *
 * 修在**这一层**而不只是调用方，是因为 `mapConcurrent` 是**公用件**：
 * "NaN 静默产出空数组"对任何调用方都是陷阱。按 `docs/AGENTS.md` §4.5
 * 「不要把校验加在错误的层」的正面应用 —— 公用件不该假设调用方传了合法值。
 * 调用方（`tradingDesk.ts`）同时也补了默认值，两层都修。
 *
 * 兜底值取 `1`（串行）而不是 `Infinity`：一个配错的值应当**降级成最保守的形态**，
 * 而不是悄悄变成"不限并发"。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string; index: number }>> {
  /*
   * ⚠️ **只挡 NaN，不动其它值**（外部 issue #154）。
   *
   * `Math.max(1, NaN)` 是 `NaN`（NaN 会传染，不是被 max 吸收），于是
   * `Array.from({length: Math.min(NaN, n)})` 得到 **0 个工人** —— 一个任务都不跑，
   * 而 `new Array(items.length)` 保持**稀疏**，下游 `for..of` 拿到 `undefined`。
   *
   * 所以这里只把"非数字"这一个情形兜底成 1（串行，最保守），
   * 其余行为**一字不变**：
   *
   *   · `Infinity` 仍是"不限并发"（`Math.min(Infinity, n) = n`，每元素一个工人）——
   *     那是既有语义，本函数不该改它；
   *   · `0` / 负数仍被抬到 1（"串行"，不是"不跑"）—— 既有约定，`pool.test.ts` 有断言。
   *
   * 为什么兜底成 1 而不是"不限"：一个**写错的配置**应当降级成最保守的形态，
   * 而不是悄悄变成最激进的形态。
   */
  const size = Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
  const results: Array<{ ok: true; value: R } | { ok: false; error: string; index: number }> = new Array(items.length);
  let next = 0;

  /*
   * **工人池**：起 `min(size, items.length)` 个循环，每个循环不断领取下一个下标。
   *
   * 为什么不是"把 items 切成 size 份"：那样每份的耗时不均时会出现
   * "一个工人早早干完、另一个还在跑"的尾巴 —— 而这正是最该避免的
   *（我们要的是"总耗时 ≈ 最慢那一个"，不是"最慢那一批"）。
   * 用共享下标领取（work-stealing 的最简形态）就能摊平。
   */
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index]!, index) };
      } catch (error) {
        /*
         * ⚠️ **单个失败不能让整批失败**。
         *
         * 20 个标的里某一个查不到数据是常态；若它把整批 `Promise.all` 拒掉，
         * 现象会是"这一轮整个分析层没产出"，而真相只是"1 个标的的数据源抽了"。
         * 所以错误被收进结果里，由调用方决定怎么处理。
         */
        results[index] = { ok: false, error: (error as Error).message, index };
      }
    }
  });

  await Promise.all(workers);
  return results;
}
