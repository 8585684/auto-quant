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
import { mapConcurrent } from './pool.js';
import { enterCritical, leaveCritical } from './resourceGate.js';
import { compactMarketContext } from './symbolSlices.js';
import { pickForAnalysis } from './analystSampling.js';
import {
  buildSupervisorPrompt,
  parseDispatch,
  planDispatch,
  type AnalystCandidate,
} from './dispatch.js';

/**
 * **分析师的静态定义**（2026-10-13 提取为常量）。
 *
 * ## 为什么提取出来
 *
 * 原来它是函数内联的一个数组字面量 —— 而"总管要先知道**有哪些角色可选**
 * 才能决定派谁"，所以那份清单必须在**问总管之前**就存在。
 *
 * ⚠️ `contextKind` 而不是直接给 `context`：材料有两个来源
 * （行情 / 新闻），而**材料本身是运行期才知道的**（压缩与否、新闻有没有）。
 * 用"种类"而不是"字符串"，是为了让"谁用哪份材料"这件事**在这里一眼可见**。
 */
const ANALYSIS_ROLE_DEFS: ReadonlyArray<{
  role: string;
  tier: ModelTier;
  contextKind: 'market' | 'news';
  task: string;
}> = [
  {
    role: 'market_analyst',
    tier: 'T2_mid',
    contextKind: 'market',
    task: '分析当前市场的整体状态与值得关注的结构。',
  },
  {
    role: 'technical',
    tier: 'T1_fast',
    contextKind: 'market',
    task: '只做指标与形态的客观描述，不要给交易建议。',
  },
  {
    role: 'newscaster',
    tier: 'T1_fast',
    contextKind: 'news',
    task: '把新闻整理成结构化事件卡（实体、方向、强度、来源）。没有可用的新闻就明说。',
  },
  {
    role: 'sentiment',
    tier: 'T1_fast',
    contextKind: 'news',
    task: '给出市场情绪分与样本量。没有数据就明说"样本不足"，不要编。',
  },
];

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
 * **辩论者与裁决官拿到的市场材料上限**（字符）。
 *
 * 见 `debateMaterial` 的说明：原来给的是**全文**（实测约 15 万 token），
 * 而 bull 与 bear 是**串行**的 → 这一段的耗时是两份全文之和。
 *
 * 现在只给一段：足够核对事实（关键位、方向、结构），
 * 但不至于让下游重读一遍分析师已经消化过的材料。
 *
 * ⚠️ 这个值不是"越小越好"：辩论者需要能**核对**分析师的结论。
 * 完全去掉市场材料会让论证失去依据（那正是"分工"的反面 ——
 * 让下游盲信上游）。
 *
 * ── ⚠️⚠️ **不能简单 `slice(0, N)`**（2026-10-13 实测抓到的真 BUG）──────
 *
 * ## 事故：裁决官**一个候选都看不到**
 *
 * 原来写的是 `input.marketContext.slice(0, DEBATE_MARKET_CHARS)`。
 * 而材料的结构是：
 * ```
 *   # 账户 → # 全市场概览（525 个标的，约 5 万字）→ # 候选标的（12 个，每个约 9 千字）
 * ```
 * 于是**前 12000 字符全部落在"全市场概览"里**。实测：
 * ```
 *   完整材料 130,420 字符
 *   材料里的候选标题: 12 个
 *   前 12,000 字符覆盖:  **0 个候选**
 * ```
 * **也就是说：裁决官与辩论者看到的材料里没有任何一个候选的指标序列** ——
 * 而它们却要据此裁决"做不做"。难怪裁决官会说
 * 「另 6 候选无指标序列」（其实它连一个都没看到）。
 *
 * ## 修法：按**段落**取，而不是按**前缀**取
 *
 * `marketContext` 的段落以 `### N. SYMBOL` 开头（`symbolSlices.ts` 的切分依据）。
 * 所以"给一段候选材料"应当是"**从头几个候选段里取**"，
 * 而不是"取材料的开头 N 个字符"。
 *
 * 见 `headOfMarket()`：它保留**概览的头部**（那段有用：大盘背景）
 * 加上**前若干个候选的完整段**，总量控制在 `DEBATE_MARKET_CHARS` 附近。
 */
const DEBATE_MARKET_CHARS = 12_000;

/**
 * **辩论者与裁决官拿到的市场材料预算**（字符）—— **压缩后**的材料。
 *
 * 见 `analystContext`：分析师拿到的是 `compactMarketContext` 的输出
 *（每个候选从约 12k 压到约 3k）。实测：
 * ```
 *   6 个候选（压缩后） = 20,893 字符
 *  12 个候选（压缩后） = 36,583 字符
 * ```
 * 24,000 能覆盖**前 6 个候选的完整序列** + 概览头部 + 容器开销。
 *
 * ⚠️ 与 `AQ_ANALYST_UNIVERSE` 的默认值（6）**同一个口径** ——
 * 上游与下游看到同一批证据，才谈得上"核对"（那是"分工"的前提）。
 */
const DEBATE_MARKET_FOR_JUDGE_CHARS = 24_000;

/**
 * **取市场材料的"开头"** —— 但保证**包含候选段**（而不是只取前缀字符）。
 *
 * @param marketContext 完整市场材料
 * @param budgetChars 目标字符预算
 *
 * 结构：`概览头部` + `前 N 个候选段`，总量不超过 `budgetChars` 的 1.6 倍
 *（候选段是不可切的整体 —— 切一半会让模型看到"残缺的指标序列"，
 * 那比不给更糟：它会基于半截数据下结论）。
 */
export function headOfMarket(marketContext: string, budgetChars: number): {
  text: string;
  candidatesShown: number;
  totalCandidates: number;
} {
  /*
   * 找候选段的起点：第一处 `### 1. `（或 `### <数字>. `）。
   * ⚠️ 用行首锚定，避免命中正文里偶然出现的 `### 1.`。
   */
  const firstCand = /^###\s*\d+\.\s*\S/m.exec(marketContext);
  if (firstCand === null) {
    /* 没有候选段（例如持仓管理轮）→ 退回前缀（那是唯一可做的事实）。 */
    return { text: marketContext.slice(0, budgetChars), candidatesShown: 0, totalCandidates: 0 };
  }
  const overviewEnd = firstCand.index;
  const overview = marketContext.slice(0, overviewEnd);
  const rest = marketContext.slice(overviewEnd);

  /* 按 `### N. ` 切开候选段。 */
  const parts = rest.split(/^(?=###\s*\d+\.\s*\S)/m);
  const total = parts.length;
  /*
   * 预算分配：概览最多占 1/4（它只是背景），其余给候选段。
   * ⚠️ 概览**必须保留** —— 它给出"大盘今天什么状态"，
   * 而那正是辩论"逆势还是顺势"的依据。
   */
  const overviewCap = Math.floor(budgetChars / 4);
  const head = overview.length > overviewCap
    ? overview.slice(0, overviewCap) + `\n（概览共 ${overview.length} 字，此处只给前 ${overviewCap} 字）\n`
    : overview;

  const picked: string[] = [];
  let used = head.length;
  for (const p of parts) {
    if (used + p.length > budgetChars) break;
    picked.push(p);
    used += p.length;
  }
  /*
   * ⚠️ **一个候选都放不下时也要给第一个**（宁可超预算，也不要给"没有候选"的材料）——
   * 那正是这个 BUG 的形态。 */
  if (picked.length === 0 && parts.length > 0) picked.push(parts[0]!);

  return {
    text: [head, ...picked].join(''),
    candidatesShown: picked.length,
    totalCandidates: total,
  };
}

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
   * 组成：**总管(1)** + 4 个分析师并行(4) + Bull(1) + Bear(1) + **Judge(1)** = 8，
   * 留余量 → **9**。
   *
   * ⚠️ **`maxCalls` 必须 ≥ 1(总管) + 分析员数 + 2×辩论轮数 + 1（裁决）**，
   * 否则裁决会被饿死 —— 这是实测踩到的：
   * ```
   *   第一版 maxCalls=8 配 maxDebateRounds=2 → 4 + 2×2 = 8 次用光，
   *   Judge 一次都没跑，整轮没有结论。
   * ```
   * ⚠️ 而 2026-10-13 接上真总管之后，**同样的错误又差点重演**：
   * `maxCalls=8` 在"1 总管 + 4 分析师 + 2 辩论 + 1 裁决 = 8"下**刚好用光**，
   * 两个既有测试当场失败（「自洽预算下不该被截断」）。所以提到 9。
   *
   * 所以下面有 `assertBudgetConsistent()` 在启动时就把这个不变量验一遍 ——
   * **让配置错误在启动那一刻暴露，而不是在跑了几十轮之后表现为"总是没有裁决"。**
   */
  maxCalls: 9,
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
 * **总管那次调用**占用的额度（2026-10-13 加）。
 *
 * ## 为什么必须显式计入不变量（我差点漏掉）
 *
 * 我把总管接上去之后，**两个既有测试当场失败**：
 * ```
 *   ★ 预算不足时【提前收尾并如实标记】  → 「自洽预算下不该被截断」实际被截断了
 *   ★ 分析师顺序必须与角色表一致
 * ```
 * 根因：`maxCalls = 8` 正好是 `4 分析师 + 1 Bull + 1 Bear + 1 Judge = 7` 加余量 1，
 * 而**总管又吃掉一次** → 分析师被截断 → **裁决官真的会被饿死**。
 *
 * > 这正是 `assertBudgetConsistent` 存在的意义：**它当场抓住了这个算术错误**。
 * > 而我如果只改 `maxCalls` 而不更新这个不变量，下一个改配置的人会再踩一次。
 */
const SUPERVISOR_CALLS = 1;

/**
 * 校验预算自洽 —— **不变量：`maxCalls` 必须容得下
 * "1 次总管 + 满编分析员 + 全部辩论 + 1 次裁决"**。
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
  const needed = SUPERVISOR_CALLS + analystCount + limits.maxDebateRounds * 2 + 1;
  if (limits.maxCalls < needed) {
    throw new Error(
      `交易台预算不自洽：需要至少 ${needed} 次调用` +
        `（${SUPERVISOR_CALLS} 总管 + ${analystCount} 分析师 + ${limits.maxDebateRounds}×2 辩论 + 1 裁决），` +
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
 *
 * ── ⚠️ **它同时是一个"资源关键区"**（2026-10-13 加）──────────────────────
 *
 * ## 为什么（一次实测定位到的真因）
 *
 * 服务器是 **2 核 / 1.9GB**（可用常驻内存仅 ~740MB），而线上同时跑着：
 * ```
 *   ① 后台调研：每 10 分钟一轮，起 claude code 进程（每个约 95–250MB）
 *   ② 这次决策：4 个分析师并发
 * ```
 * 症状：
 * ```
 *   technical：失败 —— 角色 technical 超过 120 秒未返回
 * ```
 * **而我在空载时单独实测同一个任务只要 10–13 秒**（4 个并发一起也只要 16 秒）。
 * 差别只有一个：**线上同时还有后台调研在抢 CPU**。
 *
 * ## 所以：决策期间**调研让路**
 *
 * `runOutsideCritical()` 会让后台调研等到这里结束（见 `resourceGate.ts`）。
 * 优先级是**业务定的**：决策是"要花钱/赚钱的那个动作"，
 * 调研是"下一轮才用到"的准备 —— 它晚 30 秒没有任何损失。
 *
 * ⚠️ **`finally` 不能省**：若一次异常就让计数永远 > 0，
 * 后台调研会**再也不会运行** —— 那是"安静地停掉一个功能"的失败，
 * 而它不会报错、界面上也看不出来。
 */
export async function runTradingDesk(input: Parameters<typeof runTradingDeskInner>[0]): ReturnType<typeof runTradingDeskInner> {
  enterCritical();
  try {
    return await runTradingDeskInner(input);
  } finally {
    leaveCritical();
  }
}

async function runTradingDeskInner(input: {
  ask: AskRole;
  marketContext: string;
  newsContext: string;
  /**
   * **本次调研给出的"可选情报键"** —— 裁决官只能从这里面标注依据。
   *
   * 见 `routedModel.ts` 的 `research` 与 `intel/attribution.ts`：
   * 校验"模型没编造情报来源"需要**这次真的给过它哪些键**。
   * 为空数组时裁决官**不标注**（而不是猜）。
   */
  availableIntelKeys?: string[];
  /**
   * **本轮候选标的数** —— 只用于让总管知道"有没有东西可分析"（2026-10-13）。
   *
   * ⚠️ **不传也能工作**：`tradingDesk` 会从 `marketContext` 里**数出**候选数
   *（数 `### N. SYMBOL` 标题）。这一条是**必须的** ——
   * 我第一版只留了这个字段而**没人传它**，于是总管永远看到"0 个候选"，
   * 它合理地判断"没东西可分析"→ **少派了分析师** →
   * 两个既有测试当场失败（`expected: 8, actual: 7`）。
   *
   * 传这个字段只是"调用方已经知道确切数字"时的快捷方式。
   */
  analystUniverseSize?: number;
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

  /*
   * ── ① **先问总管派谁**（2026-10-13 接线）────────────────────────────────
   *
   * ## 之前是什么样（用户需求 ① 的核心缺口）
   *
   * `firm.ts` 里总管的定义一直写着：
   * ```
   *   id: 'supervisor' · label: '总管' · tier: 'T3_deep' · status: 'staffed'
   *   duty: '统筹全局：派出调研员、指派分析师、决定要不要开会辩论'
   * ```
   * **而它从未发起过任何模型调用** —— 只有一句
   * `note('supervisor', 'dispatch', '派出 4 个分析师并行调研')` 日志标签。
   * 派谁干活由下面一行 `.slice(0, ...)` 写死。
   *
   * 也就是说：**`status: 'staffed'`（在岗）是虚的，
   * 而用户要的"最高智能AI担任最高统筹"从来没发生过。**
   *
   * ## 现在的分工
   *
   * · **代码守住硬边界**（预算 / 没新闻不派依赖新闻的角色 / 至少要有人干活）；
   * · **总管在边界内决定派哪些**（见 `dispatch.ts`）。
   *
   * ⚠️ 调用失败或解析失败时**退回全派** —— 与改动前行为一致（保守降级）。
   */
  const analystCandidates: AnalystCandidate[] = ANALYSIS_ROLE_DEFS.map((r) => ({
    role: r.role,
    /* 只有这两个角色的任务是"整理新闻" —— 没有新闻时它们只能编。 */
    needsNews: r.role === 'newscaster' || r.role === 'sentiment',
  }));
  let requestedRoles: string[] | null = null;
  /*
   * ⚠️ **候选数由材料自己数出来**（不依赖调用方传）——
   * 见 `analystUniverseSize` 的说明：我第一版只留字段而没人传值，
   * 于是总管永远看到 0，从而少派分析师。
   *
   * 数 `### N. SYMBOL` 标题 —— 那是 `prompt.ts` 渲染候选的固定形状。
   */
  const universeSize = input.analystUniverseSize
    ?? (input.marketContext.match(/^### \d+\. /gm) ?? []).length;
  if (canAsk()) {
    callsUsed += 1;
    try {
      const q = buildSupervisorPrompt({
        candidates: analystCandidates,
        hasNews: input.newsContext.trim().length > 0,
        positionCount: 0,
        symbolCount: universeSize,
      });
      /*
       * 总管的产出**不进 `analyses`** —— 它不是分析师，它的输出是"派谁"。
       * 用 `ask` 走同一条路由（于是档位、超时、降级都一致）。
       */
      const out = await safeAsk(input.ask, {
        role: 'supervisor',
        tier: 'T3_deep',
        context: q.user,
        task: q.system,
      });
      if (out.ok) {
        requestedRoles = parseDispatch(out.raw, analystCandidates.map((c) => c.role));
      }
    } catch {
      /* 拿不到决定 → `requestedRoles` 保持 null → 退回全派。 */
    }
  }
  const plan = planDispatch({
    candidates: analystCandidates,
    budget: Math.max(0, limits.maxCalls - callsUsed - 3 /* 给 Bull/Bear/Judge 留 3 次 */),
    hasNews: input.newsContext.trim().length > 0,
    requested: requestedRoles,
  });
  for (const s of plan.skipped) note('supervisor', 'dispatch', `不派 ${s.role}：${s.reason}`);
  note(
    'supervisor',
    'dispatch',
    plan.decidedBy === 'supervisor'
      ? `总管决定派 ${plan.roles.length} 个分析师：${plan.roles.join('、')}`
      : `派出 ${plan.roles.length} 个分析师并行调研（${plan.decidedBy === 'budget' ? '受预算限制' : '退回全派'}）`,
  );

  /*
   * ── **给拿大材料的两个角色一份【紧凑材料】**（2026-10-12 接线）──────────
   *
   * ## 为什么（实测数据）
   *
   * `#11` 四个分析师里**只有拿大材料的两个超时**：
   * ```
   *   market_analyst  材料 = marketContext（130,917 字符）  ❌ 超时 180s
   *   technical       材料 = marketContext（130,917 字符）  ❌ 超时 140s
   *   newscaster      材料 = newsContext（小）              ✅ 完成 55s
   *   sentiment       材料 = newsContext（小）              ✅ 完成 12s
   * ```
   * 而**模型本身不慢** —— 实测同一个路由组在小输入下只要 **2.2 / 5.2 秒**。
   *
   * ## ⚠️ 我第一版写错了（值得记下来）
   *
   * 第一版我写的是"**只给第一个标的**"（`composeSliceContext(shared, slices[0])`），
   * 理由是"它最小（9,227 字符）"。
   *
   * **那是错的**：`market_analyst` 的任务是"分析当前市场的**整体状态**"，
   * 而 `technical` 要"客观描述**指标与形态**" —— 只给一个标的，
   * 它们**看不到其余 11 个候选**，于是裁决官拿到的是一份
   * "只基于一个标的的市场判断"。
   *
   * **那是用"解决超时"换"信息缺失"，而且缺失是看不见的** ——
   * 角色会"正常完成"，只是它的结论建立在一份不完整的材料上。
   *
   * ## 正确做法：压缩，但**保留全部候选**
   *
   * ```
   *   原文                      130,917 字符
   *   压缩后（12 个候选全保留）  ~46,000 字符（小 2.8 倍）
   * ```
   * 压缩的是**冗余**（K 线只留最后 5 点、525 行概览裁到 60 行），
   * 而不是**候选数量** —— 后者是决策依据，不能动。
   *
   * ⚠️ **安全性质：切不出来时退回原文**（`compactMarketContext` 返回 `null`）——
   * **绝不给空材料或残缺材料**（那会让 agent 编造，而操作员看到的是"正常完成"）。
   *
   * ⚠️ 可用 `AQ_COMPACT_CONTEXT=off` 关掉（回到改动前的行为）。
   */
  const analystContext = (() => {
    if (process.env.AQ_COMPACT_CONTEXT === 'off') return input.marketContext;
    const compacted = compactMarketContext(input.marketContext);
    /*
     * ⚠️ 切不出来（或一个标的都没有）时**退回原文** —— 不能给残缺材料。
     */
    if (compacted === null || compacted.slices.length === 0) return input.marketContext;
    /*
     * ── **限制分析角色看到的标的数**（2026-10-12，实测临界值）──────────────
     *
     * ## 决定性实测（同一模型、同一提示词，只变材料规模）
     *
     * ```
     *    0 个标的（ 5,455 字符 /  2,182 token）→ 14.8s · content= 340 字  ✅
     *    1 个标的（ 9,211 字符 /  3,684 token）→ 14.6s · content=1658 字  ✅ 最好
     *    3 个标的（16,039 字符 /  6,416 token）→ 13.0s · content=1006 字  ✅
     *    6 个标的（26,281 字符 / 10,512 token）→ 15.1s · content= 434 字  ✅
     *   12 个标的（55,011 字符 / 22,004 token）→ 17.3s · content=   0 字  ❌ 【崩了】
     * ```
     *
     * **临界点在 6–12 个标的之间。** 到 12 个时模型"只想不说"：
     * `content = 0 字`，而 `reasoning = 2,887 字`，`finish = length`。
     *
     * ## 为什么"崩了"比"慢"更糟
     *
     * `content = 0 字` 会让角色**判定为失败**（`empty_content`）→
     * 触发"加预算重试" → 重试本身要 47.5 秒 →
     * **首次 15.7s + 重试 47.5s = 63s > T1 的 60 秒超时线**
     * → **角色缺席 → 裁决官无行情依据 → 零决策**。
     *
     * ## 所以取 6（实测它能给出 434 字有效输出、15 秒完成）
     *
     * ⚠️ **这是有代价的**：分析角色看不到第 7 名之后的候选。
     * 但**"看 6 个并给出有效分析"远好过"看 12 个但一个字都写不出"**。
     *
     * ⚠️ 而**裁决官仍然拿到完整的 12 个候选**（它的材料没被裁剪）——
     * 决策依据没有变，变的只是"分析摘要基于前 6 个"。
     *
     * ⚠️ 可用 `AQ_ANALYST_UNIVERSE=12` 调回去（便于对照测试）。
     */
    /*
     * ── ⚠️ **默认 6 个候选 —— 我改过一次"全部"，实测证明那是我错了**
     * （2026-10-13，两次实测对照）────────────────────────────────────────
     *
     * ## 为什么我一度想改成"全部"
     *
     * 线上两位分析师都指出「材料标题写候选 12 个，但正文只列了 6 个」——
     * **它们是对的**，而这确实是个真问题（见下面"标题必须与内容一致"那段）。
     *
     * ## 但我用线上真实材料做的两次实测把这个改法否掉了
     *
     * ```
     *   12 个候选（36,583 字符）
     *     mt=2048  → 15.6s · content=   0 字  ❌
     *     mt=4096  → 27.2s · content=   0 字  ❌   ← 我一度把预算提到这里，仍然不行
     *     mt=8192  → 57.0s · content=   0 字  ❌
     *     mt=16384 → 115.9s · content=2206 字  ✅   ← 要 16K 才行
     * ```
     * **要 16K 预算、116 秒**才能让 12 个候选产出内容 —— 而那个耗时
     * 远超任何合理的角色超时（`T2_mid` 180 秒虽然够，但一整轮会因此变得极慢，
     * 且 16K 预算意味着单次调用成本是原来的 8 倍）。
     *
     * **所以"给 6 个"是对的取舍**：宁可少看 6 个，也不要"一个字都写不出"。
     *
     * ## 但"标题与内容不一致"必须单独修（那才是真正的 BUG）
     *
     * 裁候选没错，**错的是让材料标题仍然宣称"12 个"** ——
     * 那会让模型花力气去解释这个矛盾，甚至怀疑材料完整性。
     * 修法在下面：**裁剪时同步改写标题**（`AQ_ANALYST_UNIVERSE` 的说明里）。
     */
    const limit = Math.max(1, Number(process.env.AQ_ANALYST_UNIVERSE ?? '') || 6);
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **不能按顺序取前 N 个 —— 那会让分析师结构性瞎掉一整类候选**
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 真 BUG（2026-10-13 线上实测）
     *
     * `#11`（团队模式）**87 轮零开仓**，而 `#10`（单模型托管）是 209/571 = 36.6%。
     * 查材料结构发现：
     * ```
     *   ###  1–6   ai_requested  ← 前 6 个【全部】是它（GTC/OGN/W/CT/SKL/DOS）
     *   ###  7–14  coinpool      ← 后 8 个【全部】是它（BTC/ETH/SOL/ZEC/…）
     * ```
     * 而这里原来写的正是 `compacted.slices.slice(0, limit)` ——
     * **恰好等于"只看 ai_requested"**。分析师于是永远看不到主流币。
     *
     * 而 `#10` 那笔赚钱的开仓正是 **ETHUSDT（coinpool）**。
     *
     * ## 为什么会这样（两个各自正确的决定合起来错了）
     *
     * ```
     *   ① strategy/coins.ts:130  "ai_requested 先加 —— 顺序就是优先级"  ← 对
     *   ② 本处（实测 12 个候选 → content=0 字）→ 只取 6 个            ← 对
     *   合起来：ai_requested 占满前 6 个 → 分析师【永远只看那一类】
     * ```
     * 这是典型的**组合性缺陷**：两个决定单独看都对，谁都没想到会合起来出问题。
     *
     * ## 修法：按来源分层取样（见 `pickForAnalysis`）
     *
     * ```
     *   ✓ 保序（模型读起来仍是"从强到弱"）
     *   ✓ 每个来源至少 1 个（即使某个来源只占 1 个位置）
     *   ✓ 只有 1 种来源时，结果与 slice(0, limit) 完全一致（行为不变）
     * ```
     * ⚠️ 最后那条是它能安全上线的关键：只在"混合来源"时改变行为，
     * 而"混合来源"正是出问题的那种情况。
     *
     * ⚠️ 说明文字里的数字也要跟着改（否则又回到"标题与内容不一致"那个老问题）。
     */
    const { picked: useSlices, droppedBySource } = pickForAnalysis(compacted.slices, limit);
    /*
     * ⚠️ **裁剪后必须改写标题**（2026-10-13 加）。
     *
     * ## 为什么（两位分析师亲自指出的）
     *
     * 线上材料标题是「候选 12 个」，而正文只给了 6 个。分析师原文：
     * ```
     *   market_analyst：「我能看到的候选只有 1–6 … 第 7–12 个的摘要没有出现在
     *                    我这轮的材料里。没有的东西我不编 —— 那 6 个我无法点评。」
     *   technical：      「材料标题写"候选 12 个"，但正文只列了 6 个 …
     *                    这 6 个我无法评价——不是"不好"，是**数据不足**。」
     * ```
     * **它们诚实且正确**，但这件事本不该让它们去猜：材料自相矛盾是**我们的错**。
     *
     * ## 修法：把"被裁掉"这件事**明说在材料里**
     *
     * 在压缩后的共享段后面插一句**真实的**说明（而不是改一个数字）：
     * 分析角色只看到前 6 个 → 就写"为控制材料规模，这里只列出前 6 个候选；
     * 其余候选由裁决官在完整材料里看到"。
     * 这样模型既知道边界，也不会以为材料坏了。
     */
    /*
     * ⚠️⚠️ **必须删掉材料里那句"可以用 `get_klines` 点名要完整序列"**（2026-10-13）。
     *
     * ## 这是一个"系统给不了的承诺"（真 BUG）
     *
     * `prompt.ts` 渲染候选区块时写着：
     * ```
     *   **其余只给摘要**……而**任何一个你想深看的标的，都可以用 `get_klines`
     *   点名要完整序列**，不必它排前面。
     * ```
     * 那句话是**给单模型写的** —— 单模型（`autoTrader`）确实有工具循环
     *（`MAX_DATA_ROUNDS = 3`），它真的能调 `get_klines`。
     *
     * 而团队模式的四个分析师走的是**单次调用（`AskRole` → `complete()`）**，
     * **没有任何工具**。于是它们读到那句话之后的反应是（线上原文）：
     * ```
     *   market_analyst：「**我没有工具**，不能调 `get_klines`。所以我能做的分析，
     *                     严格限定在这 6 个标的上。」
     *   technical：     「**我没有任何工具，不能取数。**」
     * ```
     * **它们每轮都要花一段话去否定一个系统对它们做出的承诺** ——
     * 而那段话既浪费输出预算，又让它们对自己的边界产生不确定。
     *
     * ## 修法：换成"真实边界"
     *
     * ```
     *   ✗ 「你可以用 get_klines 点名要完整序列」   ← 对分析师是假的
     *   ✓ 「你看到的就是全部；没有列出的序列你无法获取」 ← 真的
     * ```
     * ⚠️ 而**裁决官**仍然看到完整材料（它不走这条路径），所以那句承诺
     * 对它成立 —— 这里只改分析师拿到的那一份。
     */
    const NO_TOOL_PROMISE = /而\*\*任何一个你想深看的标的，都可以用 `get_klines` 点名要完整序列\*\*，不必它排前面。/;
    /*
     * ⚠️⚠️ **候选区块的标题必须与"它实际收到的内容"一致**（2026-10-13）。
     *
     * ## 这是一个"材料自相矛盾"的 BUG（实测每轮都触发）
     *
     * `prompt.ts` 渲染的标题是：
     * ```
     *   # 候选标的（14 个）
     *   **前 10 个给出完整指标序列**；**其余只给摘要**（最新值 + 最近 5 根的走向）
     * ```
     * 而分析师**只收到 6 个切片**。于是它读到一个"说有 14 个、前 10 个完整"
     * 的标题，却只看到 6 个 —— 它的反应是**每轮都写一大段免责声明**（线上原文）：
     * ```
     *   market_analyst：「本轮材料只给了我 **6 个候选的完整指标序列**…另外 8 个
     *                     候选只有摘要。我**没有工具**，所以没法去补那 8 个的序列。」
     *   technical：     「本轮共有 **14 个候选**，但材料只给了 **6 个完整序列**…
     *                     另外 8 个本轮我没有序列，也没有它们的最新值。」
     * ```
     * **四个分析师每轮各写 200–400 字**去解释这个矛盾，而那些字**不产生任何
     * 交易判断**。更糟的是它让它们对自己的输入产生不确定（"我是不是漏了什么"）。
     *
     * ## 修法：把标题改写成"它实际拿到的那一份"
     *
     * ```
     *   ✗ # 候选标的（14 个）  **前 10 个给出完整指标序列**；**其余只给摘要**
     *   ✓ # 候选标的（本轮材料列出 6 个，均已给出完整指标序列）
     * ```
     * ⚠️ 这是**对已渲染文本做定点替换**（不是重新渲染）—— 与
     * `splitMarketContext` 的纪律一致：**不改渲染，只改这一份副本**。
     * 若格式变了导致替换不中，`replace` 是幂等的（原样保留），
     * 而下面那段 `truncationNote` 仍会说明取样规则 —— **不会静默给出错材料**。
     */
    const rewriteCandidateHeader = (text: string): string =>
      text.replace(
        /# 候选标的（\d+ 个）\n\*\*前 \d+ 个给出完整指标序列\*\*（[^）]*）；\*\*其余只给摘要\*\*（最新值 \+ 最近 5 根的走向）—— 那足够用来筛掉它们，/,
        `# 候选标的（本轮材料列出 ${useSlices.length} 个，均已给出完整指标序列）\n`,
      );
    const stripToolPromise = (text: string): string =>
      text.replace(
        NO_TOOL_PROMISE,
        '**你没有工具，看不到的序列就是拿不到的** —— 所以请只基于上面真正给出的内容做判断。',
      );
    const truncationNote =
      useSlices.length < compacted.slices.length
        ? `\n\n（说明：为控制材料规模，上面只列出 **${useSlices.length}** 个候选的完整序列；` +
          `本轮共有 ${compacted.slices.length} 个候选。` +
          /*
           * ⚠️ **把"按来源各留了代表"这件事明说**（2026-10-13）。
           *
           * 原来这里只写"其余 N 个在裁决官的完整材料里"。而修掉"按顺序截取"
           * 之后取样是按来源分层的 —— 模型看到"14 个候选只给了 6 个"时，
           * 会本能地怀疑"是不是把我需要的那类漏了"。明说取样规则能消除这个疑虑，
           * 也让它知道**边界在哪**（这仍然是数据边界，只是不再是"偏心的边界"）。
           */
          (Object.keys(droppedBySource).length > 1
            ? `取样的规则是**按来源各保留代表**（不是按顺序截取），所以你看不到的那 ${compacted.slices.length - useSlices.length} 个` +
              `分布在：${Object.entries(droppedBySource)
                .map(([k, v]) => `${k} ${v} 个`)
                .join('、')}。`
            : `其余 ${compacted.slices.length - useSlices.length} 个在裁决官的完整材料里。`) +
          /*
           * ⚠️ **不要让它写"数据边界"那一段**（2026-10-13 实测）。
           *
           * 原来的措辞是"并明确说明这是你的数据边界" —— 于是四个分析师
           * **每一轮都各写一大段"先说数据边界"**（实测 market_analyst 那段
           * 占 300+ 字，technical 也是）。那些字**不产生任何交易判断**，
           * 只是在对"我看到的不是全部"这件事做免责声明。
           *
           * 而边界**已经由这段说明写清楚了** —— 让它们再复述一遍是纯浪费。
           * 所以改成"不要复述边界，直接分析"。
           */
          `**不要在回答里复述这段边界说明**（它已经说清了）—— 直接基于上面这 ${useSlices.length} 个做分析。）`
        : '';
    /* **共享部分 + 前 N 个候选**（每个候选的 K 线已压到 5 点）。 */
    return rewriteCandidateHeader(
      stripToolPromise(
        [compacted.shared + truncationNote, ...useSlices.map((s) => s.text)].join('\n\n'),
      ),
    );
  })();

  const analysisRoles: Array<{ role: string; tier: ModelTier; context: string; task: string }> =
    ANALYSIS_ROLE_DEFS.map((r) => ({
      ...r,
      /* 行情材料的两个角色用【压缩后】的材料（见 `analystContext` 的说明）；
         新闻材料的两个角色用原样（`newsContext` 本来就是小的）。 */
      context: r.contextKind === 'market' ? analystContext : input.newsContext,
    }));

  /* 总管已经决定了派谁（见上面的 `plan`）—— 这里只做"按计划过滤"。 */
  const affordable = analysisRoles.filter((r) => plan.roles.includes(r.role));
  if (affordable.length < analysisRoles.length) truncatedByBudget = true;

  callsUsed += affordable.length;
  /*
   * ── **用并发闸门，而不是无界 `Promise.all`**（2026-10-12 接线）──────────
   *
   * ## 现在只有 4 个分析师，为什么也要闸门
   *
   * 因为**这个数字会变**：用户已经提过"按币并行"（500 个标的、N 个 agent），
   * 而一旦分析角色变成"每个标的一个人"，无界 `Promise.all` 会**同时起 20+ 个**。
   *
   * 实测约束：**claude code 单进程约 250MB** —— 20 个并行 ≈ 5GB。
   * 用户说的"不限制并发"指的是 **magpie 侧**（模型调用），
   * **服务器侧的 CPU/内存是真实约束**（那是我们自己的机器）。
   *
   * ## 现在闸门给多少
   *
   * `AQ_ANALYST_CONCURRENCY`，默认 **4**。
   * · 4 个分析师时 → **等于无界**（行为与原来完全一致，没有副作用）；
   * · 将来变成 20 个标的时 → 自动变成"4 个一批"，**不需要再改这里**。
   *
   * ## 顺序与错误语义**必须保持**
   *
   * `mapConcurrent` 保证"结果与输入同序"（否则 `analyses[i]` 会对错角色），
   * 且单个失败只标记它自己（`safeAsk` 本来就不抛）。
   */
  const concurrency = Number(process.env.AQ_ANALYST_CONCURRENCY ?? 4);
  const analysisResults = await mapConcurrent(affordable, concurrency, async (a) => {
    /*
     * ⚠️ **必须走 `safeAsk`**（2026-10-12 实测踩到）。
     *
     * 原来这里直接 `input.ask(a)` + 自己的 try/catch ——
     * 于是**角色级超时对它不生效**（超时是在 `safeAsk` 里做的）。
     *
     * 后果实测可见：
     * ```
     *   [analysis] technical：完成（398758ms）      ← T1 档，超时该是 60 秒
     *   [analysis] market_analyst：完成（400858ms）
     * ```
     * **一个分析师跑了 398 秒**，而整轮就是被它拖到 7 分钟以上的。
     *
     * 而 `technical` 是 T1（"体力活"档）—— 它花 398 秒**本身就是异常信号**，
     * 正是角色超时要拦的那种情况。
     */
    const out = await safeAsk(input.ask, a);
    note(a.role, 'analysis', out.ok ? `完成（${out.latencyMs}ms）` : `失败：${out.error ?? '未知'}`);
    return out;
  });

  const analyses: DeskRoleOutput[] = analysisResults.map((r, i) => {
    if (r.ok) return r.value;
    /*
     * `mapConcurrent` 只在 `fn` **抛错**时才给 `ok: false` ——
     * 而 `safeAsk` 是不抛的，所以这条分支理论上走不到。
     * 但**不能因此省略它**：省略会让类型上多一个 `undefined`，
     * 而且将来若有人去掉 `safeAsk` 的包装，这里会静默变成 `undefined` 角色。
     */
    const a = affordable[i]!;
    note(a.role, 'analysis', `抛错：${r.error}`);
    return {
      role: a.role, modelId: '（未调用成功）', data: null, raw: '', latencyMs: 0,
      ok: false, error: r.error,
    };
  });

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
   *
   * ⚠️⚠️ **必须用 `headOfMarket()`，不能 `slice(0, N)`** ——
   * 后者实测抓到"裁决官一个候选都看不到"（见 `headOfMarket` 的说明）。
   */
  const marketHead = headOfMarket(input.marketContext, DEBATE_MARKET_CHARS);
  /*
   * ⚠️⚠️ **裁决官必须能看到候选的完整序列**（2026-10-13 实测后的第二版修正）。
   *
   * ## 第一版修对了方向、但预算配错了
   *
   * 第一版用 `headOfMarket()` 替代 `slice(0, N)` —— 方向对了（按段落取），
   * 但实测发现：**一个【未压缩】的候选段就 11,993 字符**，而预算只有 12,000
   * → 仍然只覆盖 **1 个**候选。
   *
   * 根因：**辩论者拿到的是【原文】，而分析师拿到的是【压缩后】的**
   *（`compactMarketContext` 把每个候选从约 12k 压到约 3k）。
   * 给下游原文等于让它们重读一遍上游已经消化过的东西 ——
   * 那正是 `debateMaterial` 的注释里早就说过的"分工的反面"。
   *
   * ## 所以：给**压缩后**的材料（与分析师同一份）
   *
   * 实测：压缩后 12 个候选 = 36,583 字符，而 6 个候选 = 20,893 字符。
   * 预算提到 **24,000** 就能覆盖**前 6 个候选的完整序列** +
   * 概览头部（约 4,500）+ 分析师的产出摘要（每人 1,200 × 4）。
   *
   * ⚠️ **为什么是 6 个而不是 12 个**：那是与分析师**同一个裁剪口径**
   *（`AQ_ANALYST_UNIVERSE`，实测 12 个候选会让模型"只想不说"）。
   * 上游与下游看到**同一批证据**，才谈得上"核对"。
   * 而下面那句"其余 N 个你看不到"会把边界**如实说清**
   *（否则模型会以为"没数据"—— 而那正是裁决官上一轮的原话）。
   */
  const marketHeadForDebate = headOfMarket(analystContext, DEBATE_MARKET_FOR_JUDGE_CHARS);
  const debateMaterial = [
    '## 市场（摘要 —— 与分析师看到的是同一份压缩材料）',
    marketHeadForDebate.text,
    ...(marketHeadForDebate.candidatesShown < marketHeadForDebate.totalCandidates
      ? [
          '',
          `（候选共 ${marketHeadForDebate.totalCandidates} 个，此处给了**前 ${marketHeadForDebate.candidatesShown} 个的完整序列** ——` +
            `其余 ${marketHeadForDebate.totalCandidates - marketHeadForDebate.candidatesShown} 个的指标序列**你没有**，` +
            '所以**不要因为看不到它们就说它们"没有数据"**；需要细节请问分析师的产出）',
        ]
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
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **JSON 数组必须写在最前面**（2026-10-13 实测抓到）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故（`#2552 c75`）
         *
         * 裁决官输出了正确的 13 条 `skip`，而线上落库的是：
         * ```
         *   ```json
         *   [
         *     {"symbol":"WUSDT","action":"skip","confidence":80,"reasoning":"急跌后短修复但1
         *   </team>
         * ```
         * **数组在第一个元素中间被截断** → `bad-json` → `decisions = []` → 零决策。
         *
         * ## 为什么会被截断
         *
         * 它把**推理写在前面、JSON 写在最后**，而输出预算（`ROLE_MAX_TOKENS.judge`）
         * 用尽时**从末尾砍** —— 于是被砍掉的正是那个数组。
         * 而**推理写多长是它自己决定的**（实测 1,171 字），预算总有可能不够。
         *
         * ## 修法：把数组提到最前（并明确说出来）
         *
         * 顺序变成：
         * ```
         *   ① JSON 数组（机器读的，必须完整）
         *   ② 结论 / 置信度 / 依据（人读的，可以长）
         * ```
         * 这样即使推理被砍，**数组也已经写完了**。
         *
         * ⚠️ 这比"把预算调大"更根本：预算总有上限，而**先写关键字段**
         * 让"被截断"这件事不再致命。
         *（两层都做：预算 4096→8192，同时把数组提到最前。）
         */
        '**先输出 JSON 数组，再写你的理由。** 顺序不能反 —— ' +
        '数组是机器读的，必须完整；理由可以长，但排在后面。\n\n' +
        '综合双方论证，给出**一个**结论。必须包含：' +
        '① 结论（开多/开空/不行动）② 置信度 ③ 关键依据 ④ **最大的不确定性与它的失效条件**。' +
        '如果双方证据都不足，**"不行动"是正确答案** —— 不要为了给出观点而降低标准。' +
        '\n\n' +
        /*
         * ── ⚠️ **必须独立推理，不能只复读**（2026-10-12，真实调研的结论）────────
         *
         * 调研来源：[Peacemaker or Troublemaker, arXiv:2509.23055](https://arxiv.org/html/2509.23055v1)
         *
         * 那篇论文实测出的失败模式之一正是**裁判的行为**：
         *
         * > 「有裁判时，裁判**"只复读、不做独立推理"**」
         *
         * 也就是说：让一个模型"汇总双方观点"时，它**倾向于把双方的话各抄一半、
         * 然后给个骑墙结论** —— 看起来像裁决，实际上**没有做任何判断**。
         * 而那正是"多智能体辩论"被质疑的核心原因之一。
         *
         * ## 所以这里用两个**可检验的要求**去逼它真的判断
         *
         * | 要求 | 为什么它能防"复读" |
         * |---|---|
         * | **明确写出你不同意哪一方、为什么** | 复读的人**写不出**这个 —— 它必须选边并给理由 |
         * | **如果双方都对，说明你依据什么做了取舍** | 逼它暴露**自己的判据**，而不是"综合来看" |
         *
         * ⚠️ 这两条是**提示词层面**的缓解，不是保证 —— 但它把"复读"从
         * "看起来合格的输出"变成了"明显不合格的输出"，从而**可被下游与操作员识别**。
         */
        '**你必须自己判断，不能只复读双方的话。** 具体地：' +
        '· 明确写出你**不同意哪一方**、以及为什么（如果某一方明显更弱）；' +
        '· 如果双方都有道理，说明你**依据什么做了取舍**（哪个证据权重更高、为什么）；' +
        '· 不要写"综合来看""两者都有道理"这类**不表态**的句子 —— 那等于没有裁决。' +
        '\n\n' +
        /*
         * ── **要求标注"依据了哪几条情报"**（2026-10-12，打通归因链第二段）──
         *
         * ## 为什么必须让模型标注（而不是代码猜）
         *
         * `intel/signalHealth.ts` 的失效检测（胜率崩塌 / 连续亏损 / **反应衰减**）
         * 需要"**由某个信号驱动的成交**"。而实测核查发现：
         * ```
         *   trades.source   → 只有 bot / reconciled
         *   open_reasoning  → 技术面理由
         *   Decision        → 没有情报来源字段
         * ```
         * **这条信息系统从未记录过** —— 所以失效检测一直是空转。
         *
         * ⚠️ 我**明确拒绝**了"用时间接近度猜"：归因一旦是猜的，
         * 失效检测会**基于假数据下结论** ——
         * 「"coindesk 利多"看起来在亏 → 判为失效」，而那些亏损其实与它无关。
         * **那比不接线更糟：它会自信地关掉一个好信号。**
         *
         * ## ⚠️ 只能从给定列表里选（防编造）
         *
         * 下面列出**这次真的给过它的键**，并明确"不许编"。
         * 校验在 `filterKnownIntelKeys()`：编造的键会被剔除并记日志 ——
         * 因为编造的键**永远只有 1 个样本**，会让归因数据**看起来比实际更丰富**。
         */
        ((input.availableIntelKeys ?? []).length > 0
          ? '**另外：每条决策必须标注它依据了哪几条情报。** 可选的键如下（**只能从这里选**）：\n' +
            (input.availableIntelKeys ?? []).map((k) => `  · ${k}`).join('\n') +
            '\n在 JSON 里用 `"intel_keys":["…"]` 标注（**空数组 = 这条决策是纯技术面的**）。\n' +
            '⚠️ **不要写不在上面列表里的键** —— 编造的情报来源会被剔除，而且它会让统计失真。\n\n'
          : '') +
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
        /*
         * ⚠️ **"先给数组"**（2026-10-13）—— 见 task 开头那段说明：
         * 推理写在前面而预算用尽时，被砍掉的正是排在最后的数组。
         */
        '**第一步就输出 JSON 数组**（用 ```json 代码块或裸数组都行），然后再写理由：\n' +
        '```json\n' +
        '[\n' +
        '  {"symbol":"BTCUSDT","action":"open_long","leverage":3,"positionSizeUsd":100,' +
        '"stopLoss":60000,"takeProfit":70000,"confidence":70,"riskUsd":5,' +
        '"entryType":"market","reasoning":"一句话理由"}\n' +
        ']\n' +
        '```\n' +
        /*
         * ── ⚠️⚠️ **不许只给空数组 `[]`**（2026-10-13 实测后加强）──────────────
         *
         * ## 实测形状
         *
         * 近 12 轮的统计：
         * ```
         *   格式失败（模型没给 JSON）  2 轮（17%）
         *   给了但只输出 `[]`          **9 轮（75%）**
         *   逐候选给出（12 条 skip）   1 轮
         * ```
         * 那 9 轮的 `[]` **丢掉了整轮的评估信息** —— 团队跑了 8 个角色、
         * 讨论了 3 分钟，最后落地成两个字符。
         *
         * ## 为什么"逐候选"比"空数组"好得多（不是格式洁癖）
         *
         * | | `[]` | 逐候选 skip |
         * |---|---|---|
         * | 操作员能看到什么 | 什么都没有 | **每个标的为什么不做的理由** |
         * | 下一轮能参考什么 | 无 | 上一轮对同一标的的判断 |
         * | 失效检测能归因什么 | 无 | 哪个信号在哪些标的上反复出现 |
         * | 界面决策流 | 空 | 12 条带置信度的记录 |
         *
         * 而且 `skip` **本来就不是"开仓"** —— 逐候选 skip 与"不行动"在
         * **交易语义上完全等价**（都是不开仓），只是前者**留下了推理痕迹**。
         * 所以这条要求**不会**逼它开仓（那是我明确不想要的）。
         */
        '⚠️ **即使结论是"全部不行动"，也必须逐个候选给出一条 `skip`**（带置信度与理由）。\n' +
        '**不要只给空数组 `[]`** —— 那会丢掉你对每个标的的判断，' +
        '而操作员需要知道"哪些看了、为什么不做的"。\n' +
        '空数组只在**真的没有任何候选可评估**时才用。',
    });
  } else {
    truncatedByBudget = true;
    note('judge', 'verdict', '预算用尽，未能裁决');
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   *  ⚠️ **风控官不在这里接线 —— 它在 `routedModel.ts` 的 `askRiskOfficer()`**
   * ══════════════════════════════════════════════════════════════════════
   *
   * 我一度在这里加了一次 `risk_officer` 调用（以为"从未接线"），
   * 而实测核查后发现**它早已接线且逻辑正确**（`routedModel.ts:711`）：
   * ```
   *   L791: decisions.length === 0 → 跳过（本轮不行动）
   *   L822: **全是 `skip` → 跳过**（"没有动作就没有风险敞口可审"）
   *   L837: tierForRole('risk_officer') → T3
   * ```
   *
   * 所以线上那句「⚠️ 本轮**未经风控官审阅**」**不是 BUG** ——
   * 它的成因是**裁决官一直在输出全是 `skip`**（实测 40+ 轮零决策）。
   *
   * **如果在这里再加一次，就会变成"同一件事调用两次"** ——
   * 那正是本项目反复强调要避免的（同一个事实说两遍）。
   *
   * ⚠️ 而"风控官没跑"这件事**必须可见** —— 那一层已经由
   * `deskOutput.ts` 的 `<risk>` 块如实呈现（它在 `risk === null` 时写明原因）。
   */

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
/**
 * **每个角色的超时**（毫秒），**按档位**给。
 *
 * ## 为什么需要它（实测动机）
 *
 * 实测单角色延迟波动极大 —— **同一个角色、同一个档位**：
 *
 * ```
 *   newscaster：3.8 秒  ↔  164 秒
 *   sentiment ：4.5 秒  ↔  124 秒 / 242 秒
 * ```
 *
 * 而整轮的耗时是"最慢那个角色 + 辩论 + 裁决 + 风控"——
 * **一个 242 秒的角色能把整轮拖到 7 分钟以上**（实测 341–817 秒波动）。
 *
 * ## 为什么按档位给（而不是一个数）
 *
 * 档位的定义就是"这活有多难"：
 *
 * | 档位 | 活 | 超时 | 理由 |
 * |---|---|---|---|
 * | `T1_fast` | 打标、摘要 | **60 秒** | 体力活不该要 3 分钟；慢就是有问题 |
 * | `T2_mid` | 分析 | **120 秒** | 要写完整分析 |
 * | `T3_deep` | 辩论、裁决 | **180 秒** | 最难的判断，允许更久 |
 *
 * ## 超时之后怎么办
 *
 * 与其它失败**同一条路径**（`safeAsk` 的 catch）→ 该角色标记为失败，
 * 编排继续跑（`tradingDesk` 对失败角色有降级处理）。
 *
 * ⚠️ **这是"宁可没有它，也不要为它等"** 的取舍：
 * 一个超时的分析师只是少一份材料，而**整轮卡死 = 这一轮完全没产出**。
 */
/*
 * ⚠️ **导出是为了让测试能验证"预算与超时线的协调"**（2026-10-13）。
 *
 * `ROLE_MAX_TOKENS`（输出预算）与这里（超时线）是一对**必须互相协调**的值：
 * 预算太大 → 最坏耗时超过超时线 → 角色必然超时、整轮缺席。
 * 而它们分处两个文件，所以测试需要同时读到两者才能表达那个不变量。
 */
export const ROLE_TIMEOUT_MS: Record<string, number> = {
  /*
   * ── ⚠️ **T1 从 60 秒提到 120 秒**（2026-10-13 线上实测）──────────────────
   *
   * ## 线上真实失败
   *
   * ```
   *   technical（未调用成功）：失败 —— 角色 technical 超过 60 秒未返回（按档位 T1_fast 的超时）
   * ```
   * **而它并不是"慢角色"**：我早先的实测是 8.8s / 7.4s / 11.5s / **54.3s** ——
   * 四次里有一次已经贴到 60 秒的边上。线上材料和并发情况更差一点，就直接超时。
   *
   * ## 60 秒这个值的来历（以及它为什么错）
   *
   * 它当初是按"T1 = 快角色"设的，参照的是**前三次实测**（8–12 秒）。
   * 而那个样本**没覆盖最坏情况** —— 第四次 54.3 秒已经说明分布有长尾。
   *
   * ## 为什么提到 120 秒是可以接受的
   *
   * 超时的代价是**这个角色整轮缺席**（`technical` 缺席 → 裁决官拿不到指标客观描述
   * → 输出 `[]` → **决策 0 条**）。而多等 60 秒的代价只是整轮慢一点，
   * 且整轮本来就是 121–197 秒量级。
   *
   * ⚠️ 这与 `market_analyst` 那次是同一类错误：**用"典型值"设边界，
   * 而不是用"最坏情况"设边界**。
   */
  T1_fast: 120_000,
  /*
   * ── ⚠️ **T2 从 120 秒提到 180 秒**（2026-10-12 实测后改）────────────────
   *
   * ## 实测数据（`#11` 全部 analysis 日志，16 条）
   *
   * ```
   *   technical       完成 4 · 失败 0     ← T1，超时 60s
   *   sentiment       完成 4 · 失败 0     ← T1
   *   newscaster      完成 4 · 失败 0     ← T1
   *   market_analyst  完成 2 · 失败 2     ← 【唯一的 T2】，超时 120s
   * ```
   *
   * **失败率 50%，而且是唯一失败的角色。**
   *
   * ## 为什么只有它
   *
   * 它是**唯一用 T2 档**的角色，任务也最重
   *（"分析当前市场的整体状态与值得关注的结构" vs 另三个是"客观描述指标"
   *  / "整理事件卡" / "给情绪分"）。
   *
   * **后果不只是"少一份材料"**：它是"判断有没有机会"的核心角色 ——
   * 它缺席时裁决官没有行情依据，**实测连续 12+ 轮输出 `[]`（零决策）**。
   *
   * ## 为什么"提高超时"比"降档"更对
   *
   * 降档（T2 → T1）会让它用 flash 模型做最重的那个任务 ——
   * 那是**用质量换速度**，而它恰恰是决策链的上游。
   * 而 120 秒对"通读 8 个候选 + 给出市场状态"确实偏紧。
   *
   * ⚠️ **代价**：最坏情况下整轮多花 60 秒。
   * 但那比"零决策"好得多 —— 零决策意味着**这一轮完全没干活**。
   */
  T2_mid: 180_000,
  T3_deep: 180_000,
  T0_code: 30_000,
};

/**
 * 问一个角色，**失败与超时都不抛出**。
 *
 * 编排对"某个角色没产出"是有降级处理的（辩论/裁决都会标注"缺失"），
 * 所以这里把异常转成 `ok: false` 的结果对象，让编排继续走 ——
 * 而不是让一个角色的失败把整轮炸掉。
 */
/**
 * **算一个角色的超时**（按档位基准 + 输入规模缩放）。
 *
 * 抽成**纯函数**是为了能直接测它 —— 否则只能写一个"等 65 秒看会不会被砍"
 * 的测试，那会让门禁慢一分钟（而这条规则本身很简单）。
 *
 * 判据见 `safeAsk` 里的说明：**模型不慢，慢的是输入**。
 */
export function roleTimeoutMs(tier: string, contextChars: number): number {
  const base = ROLE_TIMEOUT_MS[tier] ?? 120_000;
  /* 每 1 万字符给 10 秒（起步基准，与档位基准取大者）。 */
  const bySize = Math.round(contextChars / 10_000) * 10_000;
  /* 上限 300 秒：不能让一个角色无限等下去（那会拖死整轮）。 */
  return Math.min(Math.max(base, bySize), 300_000);
}
async function safeAsk(
  ask: AskRole,
  req: { role: string; tier: ModelTier; context: string; task: string },
): Promise<DeskRoleOutput> {
  const started = Date.now();
  /*
   * ── **超时按输入规模缩放**（2026-10-12 加）────────────────────────────
   *
   * ## 为什么固定超时是错的
   *
   * 实测（`#11`）：
   * ```
   *   user_prompt = 130,902 字符 ≈ 37,401 tokens
   *   team-grunt   小输入 2.2 秒   ← 模型本身不慢
   *   team-analyst 小输入 5.2 秒   ← 模型本身不慢
   *   但实际运行：technical 超时 60s · market_analyst 超时 180s
   * ```
   *
   * **模型不慢，慢的是"要读 3.7 万 token"。**
   * 而 `ROLE_TIMEOUT_MS` 是**固定值** —— 它假设每次输入都差不多大，
   * 而实际输入规模取决于候选池与材料量（会变）。
   *
   * ## 判据：按字符数线性放宽
   *
   * 取"每 1 万字符给 10 秒"作为**起步基准**，与档位基准取大者：
   * ```
   *   3 万字符  → 30 秒  → 与档位基准取大 → T1 仍是 60 秒
   *   13 万字符 → 130 秒 → T1 会放宽到 130 秒（而不是 60 秒被砍）
   * ```
   *
   * ⚠️ **这只是"止血"，不是根治。**
   * 根治是**把输入变小**（用户建议的"按币并行" —— 每人一个标的，
   * 输入从 13 万字符降到几百字符）。那时这个缩放会自然回到基准值。
   *
   * ⚠️ 上限 300 秒：不能让一个角色无限等下去（那会拖死整轮）。
   */
  const limit = roleTimeoutMs(req.tier, req.context.length);
  try {
    /*
     * `Promise.race` 而不是 `AbortSignal`：`AskRole` 的签名里没有 signal
     *（它是上层注入的接口），而这里只需要"不再等它" ——
     * 底层的 HTTP 请求会在 `ModelRouter` 自己的超时里被拆掉。
     */
    return await Promise.race([
      ask(req),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`角色 ${req.role} 超过 ${Math.round(limit / 1000)} 秒未返回（按档位 ${req.tier} 的超时）`)),
          limit,
        );
        /* 不因为这个定时器把进程吊住。 */
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    return {
      role: req.role,
      modelId: '（未调用成功）',
      data: null,
      raw: '',
      latencyMs: Date.now() - started,
      ok: false,
      error: (error as Error).message,
    };
  }
}
