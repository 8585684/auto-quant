/**
 * **总管的派活决策**（2026-10-13）。
 *
 * ## 用户的要求（这是本文件存在的理由）
 *
 * > 「由**最高智能AI担任最高统筹**，安排分工子智能体工作」
 * > 「总管委派子代理去做市场调研……根据资料反馈给相应的智能体做处理」
 *
 * ## 改之前是什么样
 *
 * `firm.ts` 里总管的角色定义一直写着：
 * ```
 *   id: 'supervisor' · label: '总管' · tier: 'T3_deep' · status: 'staffed'
 *   duty: '统筹全局：派出调研员、指派分析师、决定要不要开会辩论'
 * ```
 * **而它从未发起过任何模型调用** —— 只有两处日志标签
 * （`note('supervisor', ...)`）。派谁干活由 `tradingDesk.ts` 一行
 * `analysisRoles.slice(0, maxCalls - 3)` 写死。
 *
 * 也就是说：**`status: 'staffed'`（在岗）是虚的，而"最高智能AI统筹"
 * 这件事从来没发生过。**
 *
 * ## 为什么不能"让它自由决定"
 *
 * ⚠️ 有三条**硬约束**它不是可以违反的（调研里"LLM 会漂移"的实测：
 * EACL 2026 生成类任务跑题率 76–89%）：
 *
 * ```
 *   ① 调用预算 —— 它不能派超过剩余预算的人数（否则裁决被饿死）；
 *   ② 必须留下"判断者" —— 没有分析师时，辩论与裁决都失去依据；
 *   ③ 材料可得 —— `newsContext` 为空时派 `newscaster` / `sentiment`
 *      只会让它们编造（那是本项目反复强调的"看不出异常的失败"）。
 * ```
 *
 * 所以这里**不把决定权整个交出去**，而是：
 * **代码守住硬边界，总管在边界内决定"派哪些、按什么优先级"。**
 *
 * ⚠️ 拿不到总管的决定（调用失败/解析失败）时，**退回"全派"**（改动前的行为）——
 * 那是**保守且安全**的降级：多派一个分析师只是多花一次调用，
 * 而少派一个会让裁决官失去一份依据。
 */

/** 一个候选分析角色（`tradingDesk` 里的 `analysisRoles` 元素）。 */
export interface AnalystCandidate {
  role: string;
  /** 它的产出**依赖新闻材料**吗？（新闻为空时派它只会让它编造） */
  needsNews?: boolean;
}

export interface DispatchInput {
  candidates: readonly AnalystCandidate[];
  /** 剩余可用调用数（已扣掉给辩论/裁决预留的）。 */
  budget: number;
  /** 这一轮有没有新闻材料。 */
  hasNews: boolean;
  /** 总管给出的角色清单（`null` = 没拿到/没解析出来 → 退回全派）。 */
  requested: readonly string[] | null;
}

export interface DispatchResult {
  /** 实际要派的角色（按**原顺序**，便于日志与测试稳定）。 */
  roles: string[];
  /** 被总管主动砍掉的角色及理由（**要记日志** —— 那是它的决策，用户要看）。 */
  skipped: Array<{ role: string; reason: string }>;
  /** 这次是"总管决定的"还是"退回全派"。 */
  decidedBy: 'supervisor' | 'fallback_all' | 'budget';
}

/**
 * 在硬边界内执行总管的决定。
 *
 * ⚠️ **顺序固定为 `candidates` 的原顺序** —— 不按总管给的顺序重排。
 * 理由：角色的先后会影响提示词里的呈现顺序，而"总管换了个顺序"
 * 会让我**分不清"是派活变了还是措辞变了"**。它决定的是**派谁**，不是排序。
 */
export function planDispatch(input: DispatchInput): DispatchResult {
  const skipped: Array<{ role: string; reason: string }> = [];

  /* ── 硬边界①：预算 ──────────────────────────────────────────────── */
  const budget = Math.max(0, input.budget);
  const affordable = input.candidates.slice(0, budget);
  for (const c of input.candidates.slice(budget)) {
    skipped.push({ role: c.role, reason: '调用预算不足' });
  }

  /*
   * ── 硬边界②：没有新闻材料时不派"依赖新闻"的角色 ────────────────────
   *
   * ⚠️ 这不是"省一次调用"，而是**防编造**：`newscaster` 的任务是
   * "把新闻整理成事件卡"，没有新闻时它只能编 —— 而它会**正常完成**，
   * 操作员看到的是一个"有产出"的角色。**那是看不见的失败。**
   */
  const newsOk: AnalystCandidate[] = [];
  for (const c of affordable) {
    if (c.needsNews === true && !input.hasNews) {
      skipped.push({ role: c.role, reason: '本轮没有新闻材料（派它只会让它编造）' });
      continue;
    }
    newsOk.push(c);
  }

  /*
   * ── 总管的选择（在通过硬边界的候选里挑）────────────────────────────
   *
   * `requested === null` → 没拿到决定 → **全派**（改动前的行为，保守）。
   */
  if (input.requested === null) {
    return { roles: newsOk.map((c) => c.role), skipped, decidedBy: 'fallback_all' };
  }

  const wanted = new Set(input.requested);
  const chosen: string[] = [];
  for (const c of newsOk) {
    if (wanted.has(c.role)) chosen.push(c.role);
    else skipped.push({ role: c.role, reason: '总管认为本轮不需要' });
  }

  /*
   * ⚠️ **一个都不派 = 没有分析材料** → 辩论与裁决会失去依据。
   * 那不是"总管决定不干活"，而是**决策链断了**。
   *
   * 所以退回全派 —— 并且**如实记下"总管的决定被边界挡下"**
   * （而不是假装它决定了"全派"）。
   */
  if (chosen.length === 0) {
    return {
      roles: newsOk.map((c) => c.role),
      skipped: [
        ...skipped.filter((s) => s.reason !== '总管认为本轮不需要'),
        { role: '(全部)', reason: '总管一个都没派 —— 那会让裁决失去依据，已退回全派' },
      ],
      decidedBy: 'fallback_all',
    };
  }

  return { roles: chosen, skipped, decidedBy: 'supervisor' };
}

/**
 * **问总管"这一轮派谁"** —— 提示词与解析（2026-10-13）。
 *
 * ## 为什么让它看的东西很少
 *
 * 它**只需要判断"这一轮该问哪些角度"**，而不是"该不该交易"：
 * ```
 *   该问的：有没有新闻？行情是不是单边？账户是不是空仓？
 *   不该问它：目标价、仓位、杠杆 —— 那些是分析师与裁决官的活
 * ```
 * ⚠️ 若把完整行情丢给它，它就**变成了第五个分析师** ——
 * 那既浪费预算，也让"谁负责什么"变模糊（调研里"角色重叠"是失败模式之一）。
 *
 * ## 输出格式：**只有角色名**
 *
 * ```
 *   DISPATCH: market_analyst, technical
 * ```
 * ⚠️ 用一行文本而不是 JSON：这是一次**极小的判断**，
 * 而 JSON 会带来"解析失败 → 退回全派"的额外失败面。
 * 解析失败时退回全派（保守）。
 */
export function buildSupervisorPrompt(input: {
  candidates: readonly AnalystCandidate[];
  hasNews: boolean;
  positionCount: number;
  /** 这一轮候选标的数（让它知道"有没有东西可分析"）。 */
  symbolCount: number;
}): { system: string; user: string } {
  const roles = input.candidates
    .map((c) => `  · ${c.role}${c.needsNews === true ? '（**必须有新闻材料**）' : ''}`)
    .join('\n');
  return {
    system:
      '你是量化交易台的**总管**。你的职责只有一个：**决定这一轮要派哪几个分析师去干活。**\n' +
      '你不判断该不该交易，也不给目标价 —— 那是分析师与裁决官的活。\n\n' +
      '## 可选的分析师\n' +
      `${roles}\n\n` +
      '## 怎么判断\n' +
      '· 缺材料的角度**不要派**（派了它只能编，而它不会说"我没材料"）；\n' +
      '· 单边行情时"技术面"与"市场结构"就够了，不必全派；\n' +
      '· **宁多勿少**：少一份分析，裁决官就少一份依据。\n\n' +
      '## 输出格式（严格遵守，只输出这一行）\n' +
      'DISPATCH: 角色名1, 角色名2\n' +
      '（角色名必须来自上面的列表，逗号分隔）',
    user:
      `本轮情况：\n` +
      `· 候选标的：${input.symbolCount} 个\n` +
      `· 新闻材料：${input.hasNews ? '有' : '**没有**'}\n` +
      `· 当前持仓：${input.positionCount} 个\n\n` +
      '请决定派哪几个分析师。',
  };
}

/**
 * **解析总管的决定** —— 拿不到或解析不出时返回 `null`（调用方退回全派）。
 *
 * ⚠️ **必须校验角色名在白名单里** —— 否则它会"编"一个角色名，
 * 而那个角色没有提示词、没有档位，最终表现为"某个角色永远不产出"。
 */
export function parseDispatch(
  text: string,
  allowed: readonly string[],
): string[] | null {
  const m = /DISPATCH\s*[:：]\s*(.+)/i.exec(text);
  if (m === null || m[1] === undefined) return null;
  const allowedSet = new Set(allowed);
  const picked = m[1]
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    /* ⚠️ 白名单之外的**直接丢弃**（它编的角色名不存在）。 */
    .filter((s) => allowedSet.has(s));
  /*
   * 去重但**保序**：重复派同一个角色会让同一份材料被问两遍。
   */
  return [...new Set(picked)];
}

