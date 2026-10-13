/**
 * **AI 交易公司的组织架构** —— 单一事实来源。
 *
 * ## 用户的要求（这是本文件存在的理由）
 *
 * > 「我理想中这次更新以后的效果：开启以后，整个智能体团队就开始并发工作，
 * >  有主管、分析账户的、有调查新闻的、有监控社区的、有查市场情绪的、
 * >  有维护系统的程序员、有汇报工作的、有文员、有交易员、有风控员等等
 * >  **一切专业交易所量化机构有的我们都要有**」
 *
 * > 「团队模式下……看板应该直观显示**有哪些智能体，都是什么分工**，
 * >  都在做什么，时间、决策，等等一切你觉得有必要的显示在上面」
 *
 * ## 为什么放在 `@aq/shared` 而不是前端组件里
 *
 * 因为**服务端的路由表也要用它**：
 *
 *   · `packages/server/src/trader/routedModel.ts` 的 `ROLE_TIERS` 决定
 *     "每个角色用哪个档位的模型"；
 *   · 而这份表决定"界面上有哪些角色、各自负责什么"。
 *
 * 两者**必须覆盖同一批角色** —— 否则会出现两种漂移，而且都很难发现：
 *
 *   ① 服务端加了新角色、界面不显示 → **操作员看不见有人在干活**；
 *   ② 界面写了某个角色、服务端没有 → **界面上有个永远不动的空位**。
 *
 * 放在 shared 里，服务端测试就能直接断言 `ROLE_TIERS` 的每个键都在这里
 * （见 `routedModel.test.ts`）—— 漂移会在测试里被抓住，而不是等用户发现。
 *
 * ## `status` 字段为什么必须诚实
 *
 * 用户列的理想组织里有**还没实现的角色**（如"监控社区"、"维护系统的程序员"）。
 * 把它们标成"在岗"会让操作员以为有人在干那件事 —— 而实际上没有。
 *
 * 所以三态：
 *   · `active`   —— 已实现，**本轮参与了**
 *   · `staffed`  —— 已实现，但本轮没参与（如只在特定条件下才被叫）
 *   · `planned`  —— **还没实现**（诚实标注，不装）
 *
 * ## ⚠️⚠️ **加新角色之前，先在这里查一遍**（2026-10-13 的真实教训）
 *
 * ## 事故：我在两轮里重复实现了三个已有角色
 *
 * 第一轮：我在 `trader/agent/roles.ts` 里新增 `engineer` / `reporter` / `clerk`，
 *         理由写得挺充分（"用户需求⑤点名要有，而系统里没有"）。
 *         判据是——我当时只查了 `roles.ts` 与 `ROLE_MAX_TOKENS`。
 *
 * 第二轮：实现 `runHealthCheck()` 并接进审视路径。**然后才发现**：
 * ```
 *   firm.ts:256    system_engineer  状态 = staffed   ← 【早在岗】
 *   selfcheck.ts   15KB：确定性层 8 条判据 + AI 层 + 严重度分级
 *   selfcheckRunner.ts 10KB
 *   selfcheck.test.ts  14KB
 *   manager.ts:3690    prompt：「你是这套自动交易系统的『系统工程师』…」
 *   线上日志：「自检的 AI 层已就绪（system_engineer 角色）」
 * ```
 * **它每 30 分钟真的在跑**，而且比我的实现完整得多
 *（我的只有 `agent_runs` 统计；它有日志分类、持仓保护、实验积压、熔断计数）。
 *
 * 于是我把那 477 行 revert 掉了。
 *
 * ## 为什么会犯这个错（这个原因比错误本身更值得记）
 *
 * 我查的判据是「`roles.ts` 里有没有这个角色」——
 * 而**这份表里一直摆着答案**。也就是说：
 * **我搜的地方不对，而我以为搜过了就不必再搜。**
 *
 * ## 所以：加角色前，按这个顺序查三处
 *
 * ```
 *   ① 本文件（FIRM_ROLES）           —— 组织架构层：这个岗位存在吗？状态是什么？
 *   ② routedModel.ts 的 ROLE_TIERS   —— 路由层：有没有档位与 token 预算？
 *   ③ 对应的实现文件（grep 角色 id）  —— 实现层：有没有人在干这件事？
 * ```
 * ⚠️ 三处**任意一处命中**，都不该新建角色，而该去**接线**或**补全**已有的那个。
 * 这也正是用户需求 ④「**不重复造轮子**」在"角色"这件事上的具体含义。
 */

/** 一个角色在"公司"里的定位。 */
export interface FirmRole {
  /** 角色 id（与 `ROLE_TIERS` 的键**必须一致**）。 */
  id: string;
  /** 界面上的中文名。 */
  label: string;
  /** 负责什么（一句话，给操作员看）。 */
  duty: string;
  /** 所属部门（界面上分组用）。 */
  department: FirmDepartment;
  /**
   * 该角色的思考深度档位（与 `ROLE_TIERS` 对应）。
   *
   * `T0_code` 表示**不用 LLM** —— 纯代码逻辑（如数据看门狗、执行层）。
   * 这类角色没有"提示词"，界面上要区别对待。
   */
  tier: 'T0_code' | 'T1_fast' | 'T2_mid' | 'T3_deep';
  /**
   * 实现状态。
   *
   * ⚠️ `planned` 的角色**不会出现在任何编排里** —— 界面上必须标出来，
   * 否则操作员会以为"社区监控有人在看"，而实际上没有人在看。
   */
  status: 'staffed' | 'planned';
}

/** 部门（按"一家量化机构怎么分工"划分）。 */
export type FirmDepartment =
  | '管理' /* 统筹、汇报 */
  | '研究' /* 行情、新闻、情绪、链上 */
  | '风控' /* 风控官 */
  | '执行' /* 下单、账本 */
  | '技术' /* 数据、系统维护 */;

/** 部门在界面上的显示顺序（管理在最上面 —— 那是决策链的起点）。 */
export const DEPARTMENT_ORDER: readonly FirmDepartment[] = ['管理', '研究', '风控', '执行', '技术'];

/**
 * 完整的组织架构。
 *
 * 顺序即"决策流的顺序"：管理派活 → 研究出材料 → 风控把关 → 执行落地。
 */
export const FIRM_ROLES: readonly FirmRole[] = [
  /* ── 管理 ────────────────────────────────────────────────────────── */
  {
    id: 'supervisor',
    label: '总管',
    duty: '统筹全局：派出调研员、指派分析师、决定要不要开会辩论',
    department: '管理',
    tier: 'T3_deep',
    status: 'staffed',
  },
  {
    id: 'judge',
    label: '裁决官',
    duty: '汇总多空论证，给出**唯一**结论（有权决定"不行动"）',
    department: '管理',
    tier: 'T3_deep',
    status: 'staffed',
  },
  {
    id: 'reporter',
    label: '汇报员',
    duty: '把一轮发生了什么整理成人能读的摘要',
    department: '管理',
    tier: 'T1_fast',
    status: 'planned',
  },

  /* ── 研究 ────────────────────────────────────────────────────────── */
  {
    id: 'market_analyst',
    label: '市场分析师',
    duty: '看候选池与多周期结构，判断当下有没有可做的形态',
    department: '研究',
    tier: 'T2_mid',
    status: 'staffed',
  },
  {
    id: 'technical',
    label: '技术面分析',
    duty: '均线、MACD、RSI、量能与关键位（体力活，要快）',
    department: '研究',
    tier: 'T1_fast',
    status: 'staffed',
  },
  {
    id: 'newscaster',
    label: '新闻调查员',
    duty: '联网搜新闻与公告，整理成"事件卡"（有主体、有方向、有来源）',
    department: '研究',
    tier: 'T1_fast',
    status: 'staffed',
  },
  {
    id: 'sentiment',
    label: '市场情绪',
    duty: '资金费率、持仓量、涨跌分布 —— 判断拥挤度与情绪极端',
    department: '研究',
    tier: 'T1_fast',
    status: 'staffed',
  },
  {
    id: 'bull',
    label: '多头研究员',
    duty: '尽最大努力论证**做多**（并给出失效条件）',
    department: '研究',
    tier: 'T3_deep',
    status: 'staffed',
  },
  {
    id: 'bear',
    label: '空头研究员',
    duty: '尽最大努力论证**做空/不行动**（并给出失效条件）',
    department: '研究',
    tier: 'T3_deep',
    status: 'staffed',
  },
  {
    id: 'onchain_analyst',
    label: '链上分析',
    duty: '链上资金流、交易所净流入流出',
    department: '研究',
    tier: 'T2_mid',
    status: 'planned',
  },
  {
    id: 'community_monitor',
    label: '社区监控',
    duty: '交易所社区、社交媒体的异常讨论与舆情',
    department: '研究',
    tier: 'T1_fast',
    status: 'planned',
  },

  /* ── 风控 ────────────────────────────────────────────────────────── */
  {
    id: 'risk_officer',
    label: '风控官',
    duty: '在裁决之后把关：可否决、可削减仓位（**用户需求 #3**）',
    department: '风控',
    tier: 'T2_mid',
    status: 'staffed',
  },
  {
    id: 'red_team',
    label: '红队',
    duty: '专门找自己系统的漏洞与"这次判断可能错在哪"',
    department: '风控',
    tier: 'T3_deep',
    status: 'planned',
  },

  /* ── 执行 ────────────────────────────────────────────────────────── */
  {
    id: 'portfolio_manager',
    label: '组合经理',
    duty: '总敞口与集中度：多个机会互相冲突时怎么取舍',
    department: '执行',
    tier: 'T3_deep',
    status: 'planned',
  },
  {
    id: 'execution',
    label: '交易员（执行层）',
    duty: '下单、挂保护单、对账 —— **纯代码，不用 LLM**',
    department: '执行',
    tier: 'T0_code',
    status: 'staffed',
  },
  {
    id: 'memory_curator',
    label: '复盘员',
    duty: '每笔平仓后写教训，供以后参考',
    department: '执行',
    tier: 'T2_mid',
    status: 'staffed',
  },

  /* ── 技术 ────────────────────────────────────────────────────────── */
  {
    id: 'data_sentinel',
    label: '数据看门狗',
    duty: '盯行情/账户数据的新鲜度，发现断流立刻报警 —— **纯代码**',
    department: '技术',
    tier: 'T0_code',
    status: 'planned',
  },
  {
    id: 'ops_watchdog',
    label: '运维看门狗',
    duty: '盯进程、连接与错误率 —— **纯代码**',
    department: '技术',
    tier: 'T0_code',
    status: 'planned',
  },
  {
    id: 'clerk',
    label: '文员',
    duty: '整理档案、去重、把散乱材料归一成结构化数据',
    department: '技术',
    tier: 'T1_fast',
    status: 'planned',
  },
  {
    id: 'system_engineer',
    label: '系统工程师',
    duty: '每 30 分钟读一次运行证据（日志、失败轮次、持仓保护、实验积压），把线索连起来找缺陷',
    department: '技术',
    tier: 'T3_deep',
    /*
     * ⚠️ **2026-10-12 从 `planned` 改为 `staffed`** —— 它真的在岗了。
     *
     * 用户理想组织里点名要的「维护系统的程序员」。在此之前这个岗位
     * 一直标着"规划中"（诚实标注：没有人干这件事）。
     *
     * 现在由自检的 AI 层承担：每 30 分钟自动跑一次，用 `system_engineer`
     * 角色（T3 档）读证据、下判断、留痕。
     * 见 `trader/selfcheckRunner.ts` 与 `manager.buildSelfCheckAsk()`。
     */
    status: 'staffed',
  },
];

/** 按 id 取角色定义。 */
export function firmRoleOf(id: string): FirmRole | undefined {
  return FIRM_ROLES.find((r) => r.id === id);
}
