/**
 * **决策与后台调研的资源仲裁**（2026-10-13）。
 *
 * ## 为什么需要它（一次实测定位到的真因）
 *
 * 服务器规格：**2 核 CPU / 1.9GB 内存**（可用常驻只有 ~740MB）。
 *
 * 而线上同时跑着两件事：
 * ```
 *   ① 后台调研：每 10 分钟一轮，起 claude code 进程（每个约 95–250MB）
 *   ② 团队决策：4 个分析师并发（每个也是 claude/HTTP 调用）
 * ```
 *
 * 实测症状（`#11` 连续多轮）：
 * ```
 *   technical：失败 —— 角色 technical 超过 120 秒未返回
 * ```
 * **但我在空载时单独实测同一个任务只要 10–13 秒**（4 个并发一起也只要 16 秒）。
 * 差别只有一个：**线上同时还有后台调研在跑**。
 *
 * 也就是说：**超时的根因不是模型慢，是 CPU 被抢**。
 *
 * ## 为什么必须用"让路"而不是"提高超时"
 *
 * 提高超时只是把症状往后推 —— 而且**越推越糟**：
 * 超时越长，一个角色占着 CPU 的时间越长，另一件事被拖得越慢。
 * 真正的解法是**定优先级**：**决策优先，调研让路**。
 *
 * 理由（业务上的）：决策是"要花钱/赚钱的那个动作"，
 * 而调研是"下一轮才用到"的准备 —— 它晚 30 秒没有任何损失。
 *
 * ## 实现：一个计数器
 *
 * ```
 *   决策开始 → busy++      （`enterCritical()`）
 *   决策结束 → busy--      （`leaveCritical()`）
 *   调研启动前 → 若 busy > 0，等一会儿再来
 * ```
 *
 * ⚠️ 用**模块级状态**而不是实例字段：`refreshResearch` 是模块级函数，
 * 而决策在 `tradingDesk` 里 —— 两者之间没有对象可以传，也不该为了这个建一条依赖。
 */

let criticalDepth = 0;

/** 正在进行的"关键工作"（决策）数量。 */
export function criticalDepthNow(): number {
  return criticalDepth;
}

/**
 * 进入关键区（决策开始）。
 *
 * ⚠️ 必须与 `leaveCritical()` **成对**，用 try/finally ——
 * 否则一次异常就会让计数永远 > 0，**后台调研再也不会运行**
 *（那是一个"安静地停掉一个功能"的失败）。
 */
export function enterCritical(): void {
  criticalDepth += 1;
}

/** 离开关键区。 */
export function leaveCritical(): void {
  criticalDepth = Math.max(0, criticalDepth - 1);
}

/**
 * **在关键区之外执行**（等它结束再跑）。
 *
 * @param fn 要跑的工作（调研）
 * @param opts `waitMs` 轮询间隔、`maxWaitMs` 最长等待
 * @returns `fn` 的返回值；若等待超时则**仍然执行**（不能让调研永远饿死）
 *
 * ⚠️ **超时后仍然执行**：这是刻意的。若因为"决策一直不停"而永远不调研，
 * 团队就永远拿不到新闻 —— 那比"争一点 CPU"更糟。
 * 宁可让它偶尔撞一下，也不要让一个功能**静默停止**。
 */
export async function runOutsideCritical<T>(
  fn: () => Promise<T>,
  opts: { waitMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 5_000;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const deadline = Date.now() + maxWaitMs;
  while (criticalDepth > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return fn();
}
