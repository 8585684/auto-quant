/**
 * **候选材料的"取样"不能按顺序取前 N 个** —— 那会结构性偏向某一种来源。
 *
 * ## 真 BUG（2026-10-13 线上实测）
 *
 * `#11`（团队模式）**87 轮零开仓**，而 `#10`（单模型托管）是 209/571 = 36.6%。
 *
 * 查材料结构，发现：
 * ```
 *   ###  1. GTCUSDT  ai_requested   ← 分析师看得到 ┐
 *   ###  2. OGNUSDT  ai_requested                  │
 *   ###  3. WUSDT    ai_requested                  │ 前 6 个
 *   ###  4. CTUSDT   ai_requested                  │ = 全部 ai_requested
 *   ###  5. SKLUSDT  ai_requested                  │
 *   ###  6. DOSUSDT  ai_requested                 ┘
 *   ###  7. BTCUSDT  coinpool + reference  ┐
 *   ###  8. ETHUSDT  coinpool              │
 *   ###  9. SOLUSDT  coinpool              │ 后 8 个
 *   ### 10. ZECUSDT  coinpool              │ = 全部 coinpool
 *   ### 11. NEARUSDT coinpool              │ 【一个都看不到】
 *   ### 12. XRPUSDT  coinpool              │
 *   ### 13. HYPEUSDT coinpool              │
 *   ### 14. DOGEUSDT coinpool              ┘
 * ```
 * 而 `#10` 那笔赚钱的开仓正是 **ETHUSDT（coinpool）**。
 *
 * ## 为什么会这样（不是"随机的坏运气"）
 *
 * `strategy/coins.ts:130` 有一句注释写明了原因：
 * ```
 *   ⚠️ 模型点名/共识的标的先加 —— sourcesBySymbol 的【顺序就是优先级】…
 *      放在 switch 之前意味着它们排在系统选出的候选【前面】。
 * ```
 * `ai_requested` 是**上一轮模型点名要看**的标的（通常是热点、极端波动标的），
 * 它排在最前面是**对的**（模型自己要看的东西优先）。
 *
 * 而 `tradingDesk.ts` 的 `analystContext` 因为实测"12 个候选会让模型一个字都写不出"
 *（`content = 0 字`），只取 `slices.slice(0, 6)`。
 *
 * **两个各自正确的决定合起来，产生了一个错误**：
 * ```
 *   "ai_requested 优先" + "只取前 6 个"  →  【分析师永远只看 ai_requested】
 * ```
 * 这是典型的**组合性缺陷**：两个决定单独看都对，谁都没想到它们会合起来。
 *
 * ## 修法：按来源分层取样，而不是按顺序截取
 *
 * 目标是让分析师**两类都看到**（热点 + 主流），而不是只看热点。
 * 具体做法见 `pickForAnalysis()`：**保序、但保证每个来源都有代表**。
 *
 * ⚠️ **不改变任何单来源的行为**：只有 1 种来源时结果与 `slice(0, n)` 完全一致。
 * 这是这条修法能安全上线的关键 —— 它只在"混合来源"时才改变行为，
 * 而"混合来源"正是出问题的那种情况。
 */

/** 从材料标题里解析出的来源标记（`ai_requested` / `coinpool` / …）。 */
export interface SourcedSlice {
  symbol: string | null;
  text: string;
  /**
   * 来源列表。**由 `splitMarketContext` 在解析标题时一次算出** ——
   * 见 `SymbolSlice.sources` 的说明（为什么不让消费者再解析一次文本）。
   *
   * ⚠️ 解析不出时是**空数组**（而不是 `['unknown']`）——
   * 让这里能区分"没有来源信息"与"来源就是 unknown"。
   */
  sources: string[];
}

/**
 * **按来源分层取样** —— 保序，但保证每个来源都有代表。
 *
 * ## 判据（为什么不是简单的"轮流取"）
 *
 * ```
 *   ✓ 保序：结果里的相对顺序与原材料一致（模型读起来还是"从强到弱"）
 *   ✓ 每个来源至少 1 个（即使某个来源只占 1 个位置）
 *   ✓ 总数不超过 limit
 *   ✓ 只有 1 种来源时，结果 === slice(0, limit)（行为不变）
 * ```
 *
 * ## 为什么"每个来源至少 1 个"而不是"按比例分配"
 *
 * 按比例分配在"6 个 ai + 8 个 coin、limit=6"时会给出小数 ——
 * 而**取整之后的行为很难预测**（且会随 limit 变化）。
 * "至少 1 个"是一条**可断言**的规则：测试能直接钉住它。
 *
 * ⚠️ 而"至少 1 个"也是**够用**的：分析师的产出是"给裁决官一个方向感"，
 * 它不需要看完每个候选 —— 它需要的是**不因为取样方式而系统性瞎掉一整类**。
 *
 * ## ⚠️ 来源必须来自 `slice.sources` 字段，不能在这里解析 `text`
 *
 * 第一版我用正则从 `text` 里再抠一次标题 —— 结果**测试里的最小材料没写序号**
 *（`### GTCUSDT（…）`）→ 解析失败 → 退化成"按顺序取" → BUG 原地复活。
 * 根因是"同一件事算两遍"（本项目对这件事有明确教训：`prompt.ts` 的 `quantity`）。
 */
export function pickForAnalysis<T extends { symbol: string | null; text: string; sources: string[] }>(
  slices: readonly T[],
  limit: number,
): { picked: T[]; droppedBySource: Record<string, number> } {
  if (limit <= 0 || slices.length === 0) {
    return { picked: [], droppedBySource: {} };
  }
  if (slices.length <= limit) {
    return { picked: [...slices], droppedBySource: {} };
  }

  /*
   * 每个切片带上它的**主来源**（取第一个，因为它最能代表"谁把它选进来的"）。
   * ⚠️ 没有来源信息的用一个统一桶 `unknown`，**不是丢掉它** ——
   * 静默丢弃正是本项目反复强调的"看不出异常的失败"。
   */
  const withSource = slices.map((s, i) => ({
    s,
    i,
    src: s.sources[0] ?? 'unknown',
  }));

  const bySource = new Map<string, typeof withSource>();
  for (const x of withSource) {
    const arr = bySource.get(x.src);
    if (arr) arr.push(x);
    else bySource.set(x.src, [x]);
  }

  /*
   * 只有 1 种来源（或全是 unknown）→ 与 `slice(0, limit)` 完全一致。
   * ⚠️ 这是这条修法能安全上线的关键：绝大多数机器人只配了一种来源，
   * 对它们来说这个改动**必须无感**。
   */
  if (bySource.size <= 1) {
    return { picked: slices.slice(0, limit), droppedBySource: {} };
  }

  /*
   * 来源的**处理顺序**：按该来源第一个出现的下标排 ——
   * 这样"排在前面的来源"先拿到名额（与原有的优先级语义一致）。
   */
  const order = [...bySource.entries()]
    .map(([src, arr]) => ({ src, first: arr[0]!.i, arr }))
    .sort((a, b) => a.first - b.first);

  /*
   * ⚠️ **分配策略：轮流取（round-robin），而不是"保底 1 个后按顺序补"**。
   *
   * ## 为什么不能用"保底后按顺序补"（第一版就是这么写的，实测不够好）
   *
   * 那个策略在真实材料上给出 `5 个 ai + 1 个 coin`：
   * ```
   *   取到：GTC(ai), OGN(ai), W(ai), CT(ai), SKL(ai), BTC(coin)
   * ```
   * **`coinpool` 确实有代表了，但只有 1 个** —— 而分析师仍然把 5 个名额
   * 花在 `ai_requested`（极端波动标的）上，只看到 1 个主流币。
   *
   * 让 BTC 有代表只是"修掉了最坏情况"，而**不是"修对了"**：
   * 分析师的产出是给裁决官的方向感，那个方向感应该来自**两类的均衡样本**，
   * 而不是"5 个热点 + 1 个主流"。
   *
   * ## 轮流取（当前实现）
   *
   * 按"该来源第一个出现的下标"排序后**轮流**分配 —— 真实材料上给出
   * `3 个 ai + 3 个 coin`。这既保序、又让两类样本量相当。
   *
   * ```
   *   第 1 轮：ai[0], coin[0]        （2 个）
   *   第 2 轮：ai[1], coin[1]        （4 个）
   *   第 3 轮：ai[2], coin[2]        （6 个）← 满
   * ```
   * ⚠️ 某来源取完后**跳过它**（不会卡住），所以"6 个 ai + 1 个 coin、
   * limit=3"会给出 `ai, coin, ai`（而不是死等不足的那个）。
   */
  const cursors = new Map<string, number>(order.map((g) => [g.src, 0]));
  const chosen = new Set<number>();
  /* 先按"每轮各来源一个"的顺序收集候选下标，直到取满或全部取完。 */
  const allTaken = order.reduce((n, g) => n + g.arr.length, 0);
  let progressed = true;
  while (chosen.size < limit && chosen.size < allTaken && progressed) {
    progressed = false;
    for (const g of order) {
      if (chosen.size >= limit) break;
      const cur = cursors.get(g.src) ?? 0;
      if (cur >= g.arr.length) continue;
      chosen.add(g.arr[cur]!.i);
      cursors.set(g.src, cur + 1);
      progressed = true;
    }
  }

  const picked = withSource
    .filter((x) => chosen.has(x.i))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
  const droppedBySource: Record<string, number> = {};
  for (const x of withSource) {
    if (chosen.has(x.i)) continue;
    droppedBySource[x.src] = (droppedBySource[x.src] ?? 0) + 1;
  }
  return { picked, droppedBySource };
}
