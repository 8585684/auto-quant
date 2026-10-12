/**
 * **交易台编排** —— 多智能体团队的核心流程（S3）。
 *
 * ## 它在这套架构里的位置
 *
 * ```
 *   runTradingDesk()            ← 本文件
 *        │
 *        ├─ ① 并行：多个分析师同时看不同侧面（独立任务 → 可以并行）
 *        │       行情 / 新闻 / 情绪 / 技术面
 *        │
 *        ├─ ② 对抗：Bull 与 Bear 各自构建最强论证（**必须用不同厂商的模型**）
 *        │
 *        ├─ ③ 裁决：Judge 汇总 → 收敛成一个结论（唯一裁决者）
 *        │
 *        └─ ④ 产出：结构化决策 → 交给既有的风控与执行层
 * ```
 *
 * ## 三条不可违背的结构原则（都有硬证据，见设计文档 §〇）
 *
 * | 原则 | 在这里怎么体现 |
 * |---|---|
 * | **P1 共享状态串行 + 唯一裁决者** | ① 并行（各看各的、互不依赖）；②③ **严格串行** —— 辩论与裁决是共享状态 |
 * | **P2 最终决定权由代码强制** | 编排**硬性限制轮次与预算**，终止条件由**代码**判定，不交给 LLM 自判 |
 * | **P3 风控独立且有否决权** | 本文件**不产出最终订单** —— 它只产出"提案"，风控与执行仍在既有层 |
 *
 * ## 为什么不做"无限自由的讨论"
 *
 * 调研报告的硬证据：MAST 分类法实测 7 个开源多智能体框架**失败率 41%–86.7%**，
 * 其中「步骤重复 15.7%」与「不识别终止条件 12.4%」是最高频的两类。
 * 所以这里的轮次、预算、终止条件**全部写死在代码里**，而不是提示词里"请你在
 * 讨论充分后停止"那种祈求。
 *
 * ## 为什么分析师并行、研究员串行
 *
 * 调研结论（Cognition「Don't Build Multi-Agents」+ Anthropic 多 agent 工程）：
 * **广度优先、松耦合的任务适合并行；共享状态、紧耦合的任务必须单线程**。
 * 四个分析师各看一个数据源、互不依赖 → 并行；
 * 辩论与裁决在同一个上下文上累积 → 串行。
 */

import type { ModelTier } from '../../llm/modelCatalog.js';

/** 一个角色的产出（结构化卡片）。 */
export interface DeskRoleOutput {
  role: string;
  /** 该角色用的模型（审计要记：**"谁用了什么模型"是排查质量问题的第一手信息**）。 */
  modelId: string;
  /** 结构化结果（各角色 schema 不同，见 `roles.ts` 的 `ROLES[].system`）。 */
  data: unknown;
  /** 原始文本（解析失败时保留，便于排查）。 */
  raw: string;
  latencyMs: number;
  ok: boolean;
  /** 失败原因（ok=false 时有值）。 */
  error?: string;
}

/** 一次交易台会议的完整产出。 */
/**
 * **辩论者拿到的市场材料上限**（字符）。
 *
 * 见 `debateMaterial` 的说明：原来给的是**全文**（实测约 15 万 token），
 * 而 bull 与 bear 是**串行**的 → 这一段的耗时是两份全文之和。
 *
 * 现在只给前 12000 字：足够核对事实（关键位、方向、结构），
 * 但不至于让辩论者重读一遍分析师已经消化过的材料。
 *
 * ⚠️ 这个值不是"越小越好"：辩论者需要能**核对**分析师的结论。
 * 完全去掉市场材料会让论证失去依据（那正是"分工"的反面 ——
 * 让下游盲信上游）。
 */
const DEBATE_MARKET_CHARS = 12_000;

/**
 * **分析师产出给辩论者的窗口**（字符）。
 *
 * 400（原值）太短：辩论者现在主要靠它，截断会让论证失去依据。
 * 1200 大约是"一段完整结论 + 关键依据"的长度。
 */
const ANALYST_DIGEST_CHARS = 1_200;
export interface DeskOutcome {
  /** 各分析师的并行产出。 */
  analyses: DeskRoleOutput[];
  /** 多空论证（`null` = 该角色没跑或失败）。 */
  bull: DeskRoleOutput | null;
  bear: DeskRoleOutput | null;
  /** 裁决结论。 */
  verdict: DeskRoleOutput | null;
  /** 这一轮实际用掉的模型调用次数（预算审计）。 */
  callsUsed: number;
  /** 是否因为预算/轮次上限而提前收尾。 */
  truncatedByBudget: boolean;
  /** 一句话摘要（给日志与界面用）。 */
  summary: string;
}

/** 一次"问某个角色"的函数（由调用方注入真实实现，便于测试）。 */
export type AskRole = (input: {
  role: string;
  tier: ModelTier;
  /** 该角色要看的材料（结构化文本）。 */
  context: string;
  /** 角色自己的任务描述。 */
  task: string;
}) => Promise<DeskRoleOutput>;

/** 编排的硬上限（P2：**由代码强制，不交给 LLM**）。 */
export const DESK_LIMITS = {
  /**
   * 一次会议最多几次模型调用。
   *
   * 组成：4 个分析师并行(4) + Bull(1) + Bear(1) + **Judge(1)** = 7，
   * 留余量 → **8**。
   *
   * ⚠️ **`maxCalls` 必须 ≥ 分析员数 + 2×辩论轮数 + 1（裁决）**，
   * 否则裁决会被饿死 —— 这是实测踩到的：
   * 第一版 `maxCalls=8` 配 `maxDebateRounds=2` 时，
   * 4 + 2×2 = 8 次就用完了，**Judge 一次都没跑**，整轮没有结论。
   *
   * 所以下面有 `assertBudgetConsistent()` 在启动时就把这个不变量验一遍 ——
   * **让配置错误在启动那一刻暴露，而不是在跑了几十轮之后表现为"总是没有裁决"。**
   */
  maxCalls: 8,
  /**
   * 辩论轮数上限。
   *
   * **从 1 起步**（TradingAgents 默认 2，但它的预算模型不同）。
   *
   * 为什么保守：调研的硬证据是 **"多 agent 辩论必然提升准确率"已被证伪**
   *（arXiv:2509.23055：谄媚会让辩论准确率**低于**单智能体基线），
   * 而 Anthropic 实测多 agent 的 token 成本约为 chat 的 **15×**。
   * 所以辩论要**够用就好**，不是越多越好。
   */
  maxDebateRounds: 1,
} as const;

/**
 * 分析员数量（满编）。**它就是预算校验的分母。**
 *
 * 想省钱应该调**它**（少派几个人），而不是调 `maxCalls` 去卡满编需求 ——
 * 后者会让"预算不足"在界面上表现为"这一轮没有决策"，从表面极难定位。
 */
export const DESK_ANALYST_COUNT = 4;

/**
 * 校验预算自洽 —— **不变量：`maxCalls` 必须容得下"满编分析员 + 全部辩论 + 1 次裁决"**。
 *
 * ## 为什么按【满编】校验，而不是按"这次实际会派几个"
 *
 * 因为分析员数量本身是预算的函数（钱不够就少派几个），按实际数校验会变成
 * **循环论证**：派 2 个时不报错、派 4 个时才报错 —— 于是配置错误在大负载时才炸，
 * 而不是启动时就炸。
 *
 * **按满编校验 = 保证任何负载下裁决都跑得到。**
 *
 * ⚠️ 实测踩到的真实缺陷：第一版 `maxCalls=8` + `maxDebateRounds=2`，
 * 4 + 2×2 = 8 用光，**Judge 一次都没跑**，整轮没有结论。
 */
export function assertBudgetConsistent(
  limits: { maxCalls: number; maxDebateRounds: number },
  analystCount = DESK_ANALYST_COUNT,
): void {
  const needed = analystCount + limits.maxDebateRounds * 2 + 1;
  if (limits.maxCalls < needed) {
    throw new Error(
      `交易台预算不自洽：需要至少 ${needed} 次调用（${analystCount} 分析师 + ${limits.maxDebateRounds}×2 辩论 + 1 裁决），` +
        `但 maxCalls=${limits.maxCalls} —— 裁决会被饿死，整轮将没有结论。`,
    );
  }
}

/**
 * 跑一次交易台会议。
 *
 * @param input.ask 问某个角色的函数（真实实现走 `ModelRouter`，测试可注入桩）
 * @param input.marketContext 市场材料（行情、候选池等的结构化文本）
 * @param input.newsContext 新闻/情绪材料（可为空 —— 没配搜索时就是空的）
 * @param input.positionContext 持仓与账户材料
 * @param input.onStep 每一步的回调（**可观测性**：让界面看得见团队在做什么）
 */
export async function runTradingDesk(input: {
  ask: AskRole;
  marketContext: string;
  newsContext: string;
  positionContext: string;
  limits?: { maxCalls: number; maxDebateRounds: number };
  onStep?: (step: { role: string; phase: string; note: string }) => void;
}): Promise<DeskOutcome> {
  const limits = input.limits ?? DESK_LIMITS;
  /*
   * ⚠️ **一开工就验预算自洽** —— 让"算术错误"在启动那一刻暴露。
   *
   * 实测踩过：`maxCalls=8` 配 `maxDebateRounds=2` 时，4+2×2=8 次用光，
   * **Judge 一次都没跑**，整轮没有结论。而那个症状看起来像"模型不听话"，
   * 从表面极难定位到"是算术错了"。
   */
  assertBudgetConsistent(limits);
  let callsUsed = 0;
  let truncatedByBudget = false;

  /** 统一的"还能不能再问一次"闸门 —— **P2 原则的落地点**。 */
  const canAsk = (): boolean => callsUsed < limits.maxCalls;
  const note = (role: string, phase: string, text: string): void => {
    input.onStep?.({ role, phase, note: text });
  };

  /* ── ① 并行分析：四个分析师各看一个侧面（独立任务 → 可以并行）────────── */
  note('supervisor', 'dispatch', '派出 4 个分析师并行调研');
  const analysisRoles: Array<{ role: string; tier: ModelTier; context: string; task: string }> = [
    {
      role: 'market_analyst',
      tier: 'T2_mid',
      context: input.marketContext,
      task: '分析当前市场的整体状态与值得关注的结构。',
    },
    {
      role: 'technical',
      tier: 'T1_fast',
      context: input.marketContext,
      task: '只做指标与形态的客观描述，不要给交易建议。',
    },
    {
      role: 'newscaster',
      tier: 'T1_fast',
      context: input.newsContext,
      task: '把新闻整理成结构化事件卡（实体、方向、强度、来源）。没有可用的新闻就明说。',
    },
    {
      role: 'sentiment',
      tier: 'T1_fast',
      context: input.newsContext,
      task: '给出市场情绪分与样本量。没有数据就明说"样本不足"，不要编。',
    },
  ];

  /*
   * ⚠️ **并行但有上限**：先按剩余预算截断要派的角色数，
   * 而不是"全派出去、跑完了再发现超预算"。后者会让预算形同虚设。
   */
  const affordable = analysisRoles.slice(0, Math.max(0, limits.maxCalls - 3 /* 给 Bull/Bear/Judge 留 3 次 */));
  if (affordable.length < analysisRoles.length) truncatedByBudget = true;

  callsUsed += affordable.length;
  const analyses = await Promise.all(
    affordable.map(async (a) => {
      try {
        const out = await input.ask(a);
        note(a.role, 'analysis', out.ok ? `完成（${out.latencyMs}ms）` : `失败：${out.error ?? '未知'}`);
        return out;
      } catch (error) {
        note(a.role, 'analysis', `抛错：${(error as Error).message}`);
        return {
          role: a.role,
          modelId: '（未调用成功）',
          data: null,
          raw: '',
          latencyMs: 0,
          ok: false,
          error: (error as Error).message,
        } satisfies DeskRoleOutput;
      }
    }),
  );

  /*
   * ── ② 对抗论证：Bull 与 Bear 各自构建最强论证（**串行**，共享同一份材料）──
   *
   * ## ⚠️ 为什么**不再**把完整市场材料塞给辩论者（2026-10-12 实测修正）
   *
   * 原来这里直接拼 `input.marketContext` —— 而实测它的规模是：
   *
   * ```
   *   候选池按提示词预算从 22 个裁剪到 20 个（每个标的约占 7506 tokens）
   *   → 20 × 7506 ≈ 15 万 token
   * ```
   *
   * 于是**每个辩论者都要读 15 万字**，加上新闻、持仓、分析师产出 ——
   * 而 bull 与 bear 是**串行**的（共享材料、互相看得见），
   * 所以这一段的耗时是**两份 15 万字之和**。
   *
   * 用户对分工的设计意图恰恰相反：
   *
   * > 「总管委派子代理去做市场调研……**根据资料反馈给相应的智能体做处理，
   * >  资料整理、判断、决策**等等」
   *
   * **分析师的职责就是"资料整理"** —— 他们消化原始材料，
   * 辩论者应当基于**消化后的结论**论证，而不是把原始材料再读一遍。
   *
   * ## 现在的口径
   *
   * | 角色 | 拿到什么 |
   * |---|---|
   * | 4 个分析师 | **完整**市场材料（他们负责消化）|
   * | bull / bear | **压缩后的**市场材料 + 分析师产出 |
   * | judge | 分析师产出 + 双方论证 |
   *
   * ⚠️ **仍然保留一段市场材料**（而不是完全去掉）：
   * 辩论者需要能**核对事实**（"分析师说的那个支撑位到底是多少"）。
   * 只是不必是全文 —— 见 `DEBATE_MARKET_CHARS`。
   */
  const debateMaterial = [
    '## 市场（摘要 —— 完整材料已由分析师消化，下面是前段）',
    input.marketContext.slice(0, DEBATE_MARKET_CHARS),
    ...(input.marketContext.length > DEBATE_MARKET_CHARS
      ? ['', `（市场材料共 ${input.marketContext.length} 字，此处只给前 ${DEBATE_MARKET_CHARS} 字 —— 需要细节请问分析师产出）`]
      : []),
    '## 新闻与情绪',
    input.newsContext.length > 0 ? input.newsContext : '（本轮没有可用的新闻/情绪数据）',
    '## 持仓与账户',
    input.positionContext,
    /*
     * 分析师产出给**更长的窗口**（400 → 1200 字）——
     * 因为辩论者现在主要靠它：截得太短会让论证失去依据。
     */
    '## 分析师产出',
    analyses.map((a) => `- ${a.role}: ${a.ok ? a.raw.slice(0, ANALYST_DIGEST_CHARS) : `（失败：${a.error ?? '未知'}）`}`).join('\n'),
  ].join('\n\n');

  let bull: DeskRoleOutput | null = null;
  let bear: DeskRoleOutput | null = null;

  for (let round = 0; round < limits.maxDebateRounds; round += 1) {
    /*
     * ⚠️ **bull 与 bear 【并行】**（2026-10-12 实测：原来串行白白多花一份时间）。
     *
     * ## 为什么可以并行（这是有前提的，不是随手改）
     *
     * 两者拿到的是**同一份 `debateMaterial`** —— 它在上面的循环之外算好，
     * **不包含** bull 或 bear 自己的产出。也就是说：
     *
     * ```
     *   bull 的输入 ──┐
     *                 ├── 都只依赖 debateMaterial（互不依赖）
     *   bear 的输入 ──┘
     * ```
     *
     * 既然谁都不需要等谁，串行执行就只是**白等一份时间**。
     *
     * ## 实测动机
     *
     * 整轮耗时在 **341–817 秒**之间波动（5.7–13.6 分钟），而辩论段是
     * **两个 T3 调用串行** —— T3 是最慢的档位。并行后这一段从
     * `t_bull + t_bear` 变成 `max(t_bull, t_bear)`。
     *
     * ## 预算的记账方式（改了但语义不变）
     *
     * 原来每问一个角色就 `callsUsed += 1` 并检查一次 `canAsk()`。
     * 并行时**先检查"两个都问得起吗"**，再一起问 —— 于是
     * `callsUsed` 的最终值与原来完全一致（都是 +2），只是**检查点提前**了。
     *
     * 边界：预算只剩 1 次时，原来会问 bull、然后 `canAsk()` 失败而跳过 bear；
     * 现在**两个都不问**并标记 `truncatedByBudget`。这个差别是刻意的 ——
     * 只有 bull 一份论证会让裁决官**只听到一方**，
     * 而调研明确指出"单边论证"是谄媚与偏见最典型的入口（arXiv:2509.23055）。
     * **宁愿不带论证下去裁决，也不要只带一方的。**
     */
    if (callsUsed + 2 > limits.maxCalls) {
      truncatedByBudget = true;
      note('supervisor', 'debate', '预算不足以同时问多空双方 —— 跳过辩论（不制造单边论证）');
      break;
    }

    callsUsed += 2;
    note('bull', 'debate', `第 ${round + 1} 轮：构建做多论证`);
    note('bear', 'debate', `第 ${round + 1} 轮：构建做空/不行动论证`);

    const [bullOut, bearOut] = await Promise.all([
      safeAsk(input.ask, {
        role: 'bull',
        tier: 'T3_deep',
        context: debateMaterial,
        task: '为做多构建**最强**论证，并明确写出你的失效条件（什么情况下这个论证不成立）。',
      }),
      safeAsk(input.ask, {
        role: 'bear',
        tier: 'T3_deep',
        context: debateMaterial,
        task:
          '为做空或**不行动**构建**最强**论证，并明确写出失效条件。' +
          '注意：**"现在不交易"是一个合法的结论**，不要为了给出观点而硬找理由。',
      }),
    ]);
    bull = bullOut;
    bear = bearOut;
  }

  /* ── ③ 裁决：唯一裁决者（P1）──────────────────────────────────────── */
  let verdict: DeskRoleOutput | null = null;
  if (canAsk()) {
    callsUsed += 1;
    note('judge', 'verdict', '汇总辩论并裁决');
    verdict = await safeAsk(input.ask, {
      role: 'judge',
      tier: 'T3_deep',
      context: [
        debateMaterial,
        '## 多空论证',
        `### 做多\n${bull?.raw.slice(0, 1200) ?? '（缺失）'}`,
        `### 做空/不行动\n${bear?.raw.slice(0, 1200) ?? '（缺失）'}`,
      ].join('\n\n'),
      task:
        '综合双方论证，给出**一个**结论。必须包含：' +
        '① 结论（开多/开空/不行动）② 置信度 ③ 关键依据 ④ **最大的不确定性与它的失效条件**。' +
        '如果双方证据都不足，**"不行动"是正确答案** —— 不要为了给出观点而降低标准。' +
        '\n\n' +
        /*
         * ⚠️ **必须要求 JSON 数组**（2026-10-12 实测踩到）。
         *
         * 第一版只要求"给出结论"，没要求格式 → 裁决官输出的是**纯散文**
         *（实测：「结论：不行动。本轮不开多、不开空，也不挂入场限价单。」）。
         *
         * 而下游只从裁决文本里抽 JSON 数组（`extractFirstJsonArray`）→
         * 抽不到 → 触发两个连锁问题：
         *
         *   ① **风控官被跳过**（`decisions.length === 0` 时提前返回）——
         *      于是"风控由智能体负责"这条需求**静默失效**（日志里一次 risk 都没有）；
         *   ② 最终 `<decision>` 块是 `[]` —— **无论团队讨论出什么，都不会有任何动作**。
         *
         * 也就是说：整个团队跑了一轮，结论永远等于"什么都不做"。
         * 这是**功能性的致命缺陷**，而且从界面上看不出来（看起来像"模型决定观望"）。
         *
         * 所以这里把**输出格式写死**，并给出一个可照抄的样例。
         */
        '\n\n## ⚠️ 输出格式（必须遵守）\n' +
        '结论之后**必须**附一个 JSON 数组（用 ```json 代码块或裸数组都行）：\n' +
        '```json\n' +
        '[\n' +
        '  {"symbol":"BTCUSDT","action":"open_long","leverage":3,"positionSizeUsd":100,' +
        '"stopLoss":60000,"takeProfit":70000,"confidence":70,"riskUsd":5,' +
        '"entryType":"market","reasoning":"一句话理由"}\n' +
        ']\n' +
        '```\n' +
        '**不行动时输出空数组 `[]`**（而不是省略它）。\n' +
        '每个候选标的都要有一条：不做的用 `{"symbol":"XXXUSDT","action":"skip","confidence":N,"reasoning":"..."}`。',
    });
  } else {
    truncatedByBudget = true;
    note('judge', 'verdict', '预算用尽，未能裁决');
  }

  const okCount = analyses.filter((a) => a.ok).length;
  const summary = [
    `分析师 ${okCount}/${analyses.length} 成功`,
    bull?.ok ? '做多论证已出' : '做多论证缺失',
    bear?.ok ? '做空论证已出' : '做空论证缺失',
    verdict?.ok ? '已裁决' : '未裁决',
    `调用 ${callsUsed}/${limits.maxCalls}`,
  ].join(' · ');

  return { analyses, bull, bear, verdict, callsUsed, truncatedByBudget, summary };
}

/** 包一层：把抛错也变成 `DeskRoleOutput`（团队编排不该因为一个角色挂了整轮失败）。 */
async function safeAsk(
  ask: AskRole,
  req: { role: string; tier: ModelTier; context: string; task: string },
): Promise<DeskRoleOutput> {
  try {
    return await ask(req);
  } catch (error) {
    return {
      role: req.role,
      modelId: '（未调用成功）',
      data: null,
      raw: '',
      latencyMs: 0,
      ok: false,
      error: (error as Error).message,
    };
  }
}
