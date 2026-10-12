/**
 * **决策模型路由器** —— 把 `ModelRouter` 适配成 `DecisionModel`，并承载交易台编排。
 *
 * ## 它在架构里的位置
 *
 * ```
 *   autoTrader.runCycleBody 第 7 步
 *         ↓  this.deps.model.complete(system, user)
 *   【本文件】DecisionModel 适配层
 *         ├─ 单模型路径：按档位选模型 → 失败自动降级
 *         └─ 团队路径：跑整个交易台 → 翻成 <decision> 格式
 *   ModelRouter → magpie 网关
 * ```
 *
 * ## 为什么团队编排放在这里，而不是改 `autoTrader`
 *
 * `autoTrader` 是**最安全攸关**的文件（10201 行）。考古报告认定的模型侧唯一接缝
 * 就是 `DecisionModel`（`autoTrader.ts:381-434`）—— 它只要求"给我一段文本"。
 *
 * 所以团队模式的全部复杂度（并行分析、辩论、裁决、格式翻译）**都关在这一层**：
 * `autoTrader` 完全不知道它在跟一个团队说话，它只是收到一段
 * `<decision>[...]</decision>`。**这就是"不碰交易循环"的具体形态。**
 *
 * ## 与 `ai_managed` 的关系：**零影响**
 *
 * 单模型路径（`createRoutedDecisionModel`）与团队路径（`createTeamDecisionModel`）
 * 是两个独立构造函数。智能托管用原来那个单客户端的适配器，一行都不用改。
 */

import type { Decision } from '@aq/shared';
import type { DecisionModel } from './autoTrader.js';
import type { ModelTier } from '../llm/modelCatalog.js';
import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { runTradingDesk, type AskRole, type DeskOutcome, type DeskRoleOutput } from './agent/tradingDesk.js';
import { renderDeskOutcome, extractFirstJsonArray } from './agent/deskOutput.js';
import { parseRiskOfficerVerdict } from './agent/riskOfficer.js';

/** 一次「向模型提问」要用的档位与角色。 */
export interface RoleRequest {
  /** 角色名（用于日志与审计）。 */
  role: string;
  /** 该角色需要的能力档位。 */
  tier: ModelTier;
}

/**
 * 角色 → 档位的**默认映射**（设计文档 §二 的机器表达）。
 *
 * ## 为什么档位写在这里，而不是散在各角色实现里
 *
 * 用户要求「**每个智能体根据工作内容来制定用什么模型**」。
 * 把映射集中一处，好处是：**换档位只改一个地方**，
 * 而且能一眼看出"谁在用贵模型"（避免把 T3 浪费在体力活上 ——
 * 那是 Anthropic 实测的 15× token 成本来源）。
 */
export const ROLE_TIERS: Readonly<Record<string, ModelTier>> = {
  /* --- 需要顶级判断力的（T3）--- */
  supervisor: 'T3_deep',
  judge: 'T3_deep',
  bull: 'T3_deep',
  bear: 'T3_deep',
  portfolio_manager: 'T3_deep',
  red_team: 'T3_deep',
  /*
   * **系统工程师** —— 用户理想组织里点名要的「维护系统的程序员」。
   *
   * 由**自检的 AI 层**承担（每 30 分钟读一次运行证据、把线索连起来找缺陷）。
   * 用 T3 是因为"从日志与数字里看出问题"正是最需要判断力的活。
   *
   * ⚠️ 这一条是**被测试逼出来的**：我先把 `FIRM_ROLES` 里的 `system_engineer`
   * 标成 `staffed`，而路由表里没有它 —— 于是 `tierForRole()` 会静默回退到
   * T2（能跑，但"在岗"是虚的，且我写的 T3 假设不成立）。
   * `routedModel.test.ts` 里那条一致性断言当场抓住了它。
   */
  system_engineer: 'T3_deep',

  /* --- 主要分析工作（T2）--- */
  market_analyst: 'T2_mid',
  onchain_analyst: 'T2_mid',
  memory_curator: 'T2_mid',
  risk_officer: 'T2_mid',

  /* --- 体力活：打标、摘要、抽取（T1）--- */
  newscaster: 'T1_fast',
  sentiment: 'T1_fast',
  technical: 'T1_fast',
  reporter: 'T1_fast',
  clerk: 'T1_fast',

  /* --- 不用 LLM（T0）--- */
  data_sentinel: 'T0_code',
  execution: 'T0_code',
  ops_watchdog: 'T0_code',
};

/** 取某角色的档位；未知角色保守给 T2（宁可稍贵，也不要让新角色没模型可用）。 */
export function tierForRole(role: string): ModelTier {
  return ROLE_TIERS[role] ?? 'T2_mid';
}

/**
 * 构造一个**多模型**的 `DecisionModel`。
 *
 * @param router 已经配好的模型路由器（含健康记录与降级链）
 * @param request 这一轮用哪个角色、哪个档位
 * @param baseMaxTokens 该角色的基础输出预算
 * @param onAttempt 观测钩子：每次尝试（含失败的降级）都会回调 ——
 *                  用户要求的"看得见系统在做什么"就靠它落进日志/事件流
 */
export function createRoutedDecisionModel(options: {
  router: ModelRouter;
  request: RoleRequest;
  baseMaxTokens: number;
  onAttempt?: (info: {
    role: string;
    modelId: string;
    ok: boolean;
    ms: number;
    note: string;
    fallbackCount: number;
  }) => void;
}): DecisionModel {
  const { router, request, baseMaxTokens, onAttempt } = options;

  return {
    complete: async (systemPrompt, userPrompt, callOptions) => {
      const result = await router.callByTier(
        request.tier,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
          baseMaxTokens,
        },
      );

      /*
       * 把**每一次尝试**报出去 —— 包括失败与降级。
       *
       * 用户反复要求"看得见系统在做什么"（这也是 `cycle_step` 事件存在的理由）。
       * 一次"降级了三次才拿到答案"如果不报出来，操作员只会觉得"这轮很慢"，
       * 而看不到"首选模型额度尽了"这个真事实。
       */
      if (onAttempt) {
        /*
         * ⚠️ **`fallbackCount` 是"到这一步为止已经降级了几次"**（复核发现 P2-I）。
         *
         * 第一版写的是 `index + failures`（两点：这是两个无关量的和），
         * 实测 `[失败,失败,成功]` 会输出 `2,3,4` —— 而正确的语义是 `0,1,2`
         *（第 1 次尝试还没降级、第 2 次降了 1 级、第 3 次降了 2 级）。
         *
         * 这个字段是**给操作员看的**（"为什么这轮慢"），语义错了就会误导。
         */
        let fallbacks = 0;
        for (const a of result.attempts) {
          onAttempt({
            role: request.role,
            modelId: a.modelId,
            ok: a.ok,
            ms: a.ms,
            note: a.note,
            fallbackCount: fallbacks,
          });
          if (!a.ok) fallbacks += 1;
        }
      }

      return {
        text: result.text,
        latencyMs: result.latencyMs,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens,
          reasoningTokens: result.usage.reasoningTokens,
        },
      };
    },
  };
}

/**
 * 默认的"调用一个具体模型"实现 —— 由 `manager` 注入真实的 `LlmClient` 工厂。
 *
 * 抽成类型别名只是为了让 `manager` 侧的那段胶水写得清楚：
 * **路由器不关心模型怎么调**，它只关心"选谁、失败了怎么办"。
 */
export type ModelCallFactory = (modelId: string) => CallModel;

/* -------------------------------------------------------------------------- */
/*  团队模式：跑整个交易台，返回 <decision> 文本                                 */
/* -------------------------------------------------------------------------- */

/**
 * 造一个**跑交易台**的 `DecisionModel`。
 *
 * ## 它是怎么把"多角色协作"藏在一层适配器后面的
 *
 * `autoTrader` 调 `complete(system, user)` 时，这里：
 *
 *   1. 把 `system` + `user`（交易循环给的完整材料）当作**交易台的市场与持仓材料**；
 *   2. 跑 `runTradingDesk()` —— 4 分析师并行 → 多空辩论 → 裁决；
 *   3. 用 `renderDeskOutcome()` 把裁决翻成 `<decision>[...]</decision>` 返回。
 *
 * 交易循环那边看到的就是"模型给了个决策数组"，**它不知道背后有 7 个角色**。
 *
 * ## 两个必须守住的边界
 *
 * · **`system` 提示词被保留**：它是交易循环的规则说明（输出格式、纪律）。
 *   交易台的角色提示词是**叠加**在它之上的，不是替换 —— 否则团队会不知道
 *   要输出 `<decision>` 格式，而那是**唯一**能让它的结论生效的形式。
 *
 * · **失败不抛出，而是返回空决策块**：一次团队会议失败（某个模型额度尽、
 *   网关抖动）不该让整轮决策抛错。`renderDeskOutcome` 已经把"为什么没结论"
 *   写进 `<team>` 块了 —— **返回"不行动 + 说清原因"比抛错更有用**：
 *   前者操作员看得懂，后者只会在日志里留一条栈。
 */
/**
 * 剥掉模型输出里的 `<tool>…</tool>` 块。
 *
 * ## 为什么团队模式必须剥（实测：这是"一轮跑 4 次交易台"的根因）
 *
 * `autoTrader` 有一个**按需取数循环**（`MAX_DATA_ROUNDS = 3`）：
 * 只要模型输出里有 `<tool>` 块，它就会执行工具并**再问一次模型**。
 *
 * 对**单模型**这是廉价的（多问 1 次）。而对**团队模式**，
 * "再问一次模型"意味着**把整个交易台重跑一遍**（8 个角色）——
 * 于是"一次决策"变成最多 **4 次交易台 = 32 次角色调用**。
 *
 * 实测（`#11` 模拟盘，9 分钟）：**派出分析师 8 次、零产出、64 次模型调用**。
 *
 * ## 为什么是"剥掉"而不是"改提示词"
 *
 * 我在角色 system 提示词里已经写明「**你没有工具**」，但模型仍会按训练习惯
 * 假装调工具（实测输出 `<tool>{"tool":"list_candidates",…}`）。
 * 提示词能降低概率，**不能保证** —— 而代价是整台重跑。
 *
 * 既然团队**真的没有工具**，它输出里的任何 `<tool>` 块都是**幻觉**。
 *
 * 顺带的好处：审计块里不再混着那段假 JSON（此前实测 `<team>` 块里
 * 出现 `{"tool":"l…`，读起来很困惑）。
 *
 * ⚠️ **只在团队模式剥**（本文件是团队专用的 `createTeamDecisionModel`）——
 * 另两种模式**真的有工具**（`decisionTools.ts`），剥掉会让它们失去取数能力。
 */
export function stripToolBlocks(text: string): string {
  return text.replace(/<tool>[\s\S]*?<\/tool>/g, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * 从交易循环给的提示词里**尽力**找出候选标的。
 *
 * ## 为什么要找，而不是让调用方传
 *
 * `DecisionModel.complete(system, user)` 是交易循环与模型之间的**唯一契约**
 *（见 `autoTrader.ts:381-434`），它只给两段文本。要拿标的就得从文本里找 ——
 * 改那个契约会牵连整个交易循环，而那是本项目最安全攸关的文件。
 *
 * ## 找不到就不搜
 *
 * 匹配不到标的时返回空数组 → `collectMarketResearch` 只查整体市场情绪
 *（那一条不需要标的）。**不猜标的** —— 猜错会让新闻分析师去查一个
 * 跟本轮无关的币。
 *
 * 判据是 `XXXUSDT` 形式的交易对（这是本项目标的的命名约定）。
 */
function symbolsFromPrompt(prompt: string): string[] {
  const matches = prompt.match(/\b[A-Z0-9]{2,15}USDT\b/g);
  if (matches === null) return [];
  /* 去重并限制数量 —— 搜索结果要进提示词，太多会把上下文吃满。 */
  return [...new Set(matches)].slice(0, 3);
}
export function createTeamDecisionModel(options: {
  router: ModelRouter;
  /** 交易循环给的系统提示词（含输出格式要求）。团队角色提示词会叠加在它之上。 */
  /** 每一步的回调（可观测性：让界面看得见团队在做什么）。 */
  onStep?: (step: { role: string; phase: string; note: string }) => void;
  /** 单次响应的输出预算。 */
  baseMaxTokens: number;
  /** 覆盖默认上限（测试用）。 */
  limits?: { maxCalls: number; maxDebateRounds: number };
  /**
   * **市场调研的取数函数**（联网搜索）。
   *
   * ## 为什么是注入的函数，而不是在里面直接调搜索
   *
   * 这样：① 这一层仍可被单元测试（注入桩即可，不碰网络）；
   * ② 搜索的配置（端点/key）留在 `manager`，与网关配置同一处来源；
   * ③ **不传就退化成原来的行为**（新闻材料为空）——
   * 既有测试与"没配搜索"的部署都不受影响。
   *
   * 用户 2026-10-12 的要求：「总管委派子代理去做市场调研（查新闻、各大交易所社区、
   * 社交媒体、新闻源等等）根据资料反馈给相应的智能体做处理」。
   */
  research?: (symbols: readonly string[]) => Promise<string>;
}): DecisionModel {
  const { router, onStep, baseMaxTokens, limits, research } = options;

  /** 把一个角色的问题交给路由器。 */
  const ask: AskRole = async ({ role, tier, context, task }): Promise<DeskRoleOutput> => {
    const started = Date.now();
    try {
      const result = await router.callByTier(
        tier,
        [
          {
            role: 'system',
            content:
              `你是交易台的「${role}」。${task}\n\n` +
              /*
               * ⚠️ **必须明确说"你没有工具"**（2026-10-12 实测踩到）。
               *
               * 第一版没写这句，于是角色**以为它能取数**，输出了：
               *
               *   · 「我将先获取市场数据来了解当前状况。让我同时列出候选池…」
               *   · 「候选标的技术形态数据缺失，**我先拉取候选池与指标序列**再做客观描述」
               *
               * 而这些"动作"**永远不会发生**（团队模式不给角色工具）——
               * 结果是模型反复"打算取数"，实测把某个角色拖到 **299 秒**，
               * 而操作员在审计块里看到的是一段**假装干活的独白**。
               *
               * 说清这一点有两层好处：
               *   ① 不再浪费 token 与时间去"计划取数"；
               *   ② 数据确实缺失时它会**如实说"数据不足"**，
               *      而不是假装去拿 —— 那正是本项目反复强调的"看不出异常的失败"。
               */
              '## 重要：你没有工具\n' +
              '**你不能调用任何工具、不能取数、不能查行情。** 只能基于下面提供的材料作答。\n' +
              '材料里没有的东西，就**如实说"数据不足"** —— 不要写"我将去获取…"、"让我先拉取…"，' +
              '因为那些动作不会发生，而且会掩盖"数据缺失"这个真问题。',
          },
          { role: 'user', content: context },
        ],
        { baseMaxTokens },
      );
      return {
        role,
        modelId: result.modelId,
        data: null,
        raw: result.text,
        latencyMs: Date.now() - started,
        ok: true,
      };
    } catch (error) {
      return {
        role,
        modelId: '（未调用成功）',
        data: null,
        raw: '',
        latencyMs: Date.now() - started,
        ok: false,
        error: (error as Error).message,
      };
    }
  };

  return {
    complete: async (systemPrompt, userPrompt) => {
      const started = Date.now();
      /*
       * 交易循环给的 `systemPrompt`（规则与输出格式）**并入市场材料** ——
       * 见上面第二段边界说明：不能丢掉它，否则团队不知道要输出什么格式。
       */
      /*
       * ⚠️ **`systemPrompt` 与 `userPrompt` 的分工（2026-10-12 实测修正）。**
       *
       * `autoTrader` 传给模型的两段文本是这样分工的：
       *
       *   · `systemPrompt` —— **规则与角色说明**（输出格式、纪律、风控约束）；
       *   · `userPrompt`   —— **真正的材料**：候选池、多周期指标序列、持仓、账户状态。
       *
       * 第一版我把它们接反了：`marketContext = systemPrompt`（规则当材料）、
       * 而 `userPrompt` 只当新闻。实测后果 —— 模型明确说：
       *
       *   「本轮材料中没有提供任何市场数据，因此无法进行市场结构分析」
       *   「提示词里没有附带任何行情数据、候选池或持仓信息 —— 我手上是空的」
       *
       * 而同一时刻日志显示「list_candidates → 20 个」—— 数据取到了，
       * **只是没进提示词**。于是团队基于"空材料"讨论，还白白慢了一轮。
       *
       * 现在：行情材料用 `userPrompt`，而**规则（systemPrompt）也一并带进去**
       *（角色需要知道输出格式与纪律，见下面 `marketContext` 的拼装）。
       */
      let newsContext = '';
      if (research !== undefined) {
        try {
          onStep?.({ role: 'supervisor', phase: 'dispatch', note: '派出调研员联网搜索新闻与情绪' });
          const researchText = await research(symbolsFromPrompt(userPrompt));
          newsContext = researchText;
        } catch (error) {
          /* 调研这一层失败不该让整轮失败 —— 行情数据仍是好的。 */
          onStep?.({ role: 'supervisor', phase: 'dispatch', note: `调研失败：${(error as Error).message}` });
        }
      }

      const outcome = await runTradingDesk({
        ask,
        /*
         * 行情材料 = **真正的数据（userPrompt）** + 规则速览（systemPrompt 的末尾一段）。
         *
         * 规则要带进去是因为角色需要知道输出格式与纪律；但**不能让它占满材料位**
         *（第一版就是这个问题）。所以规则放在后面、标明是"规则"。
         */
        marketContext: `${userPrompt}\n\n---\n\n## 团队需要遵守的规则（来自交易循环）\n${systemPrompt}`,
        newsContext,
        positionContext: '',
        ...(onStep ? { onStep } : {}),
        ...(limits ? { limits } : {}),
      });

      /*
       * ── **风控官关卡**（用户需求 #3：风控由智能体负责，不是内置规则）──────
       *
       * 位置很关键：**在裁决之后、渲染之前**。
       *
       *   · 在裁决**之前**问 → 风控官看不到团队讨论的结论，只能空谈；
       *   · 在渲染**之后**问 → 来不及改决策，只能"事后评论"（那正是
       *     TradingAgents 的教训：只提建议的风控等于没有风控）。
       *
       * ## 为什么这一层仍然不是"全部交给智能体"
       *
       * 风控官（本层）管**策略判断**：仓位大小、集中度、该不该收手 ——
       * 那是真正需要智能的部分，也是用户要的"风格由智能体负责"。
       *
       * 而**物理底线**（保证金够不够、数量可不可交易、止损存不存在）
       * 仍在下一层 `RiskEngine`，**它不可被绕过** ——
       * 把"保证金够不够"交给会幻觉的模型判断，等于拿爆仓换"智能"。
       */
      const risk = await askRiskOfficer(ask, outcome, onStep);

      return {
        /*
         * ⚠️ **剥掉 `<tool>` 块**（2026-10-12 实测：这是"一轮跑 4 次交易台"的根因）。
         *
         * ## 为什么必须剥
         *
         * `autoTrader` 有一个**按需取数循环**（`MAX_DATA_ROUNDS = 3`）：
         *
         * ```ts
         * for (let dataRound = 1; dataRound <= MAX_DATA_ROUNDS; dataRound += 1) {
         *   const calls = extractToolCalls(finalResponse.text);
         *   if (calls.length === 0) break;
         *   ... 执行工具 ...
         *   const followUp = await askAgain(...);   // ← 再问一次模型
         * }
         * ```
         *
         * 对**单模型**这是廉价的（多问 1 次）。而对**团队模式**，
         * "再问一次模型"意味着**把整个交易台重跑一遍**（8 个角色）——
         * 于是"一次决策"变成最多 **4 次交易台 = 32 次角色调用**。
         *
         * 实测证据（#11 模拟盘，9 分钟窗口）：
         * ```
         *   派出分析师 2 → 4 → 5 → 6 → 7 → 8 次
         *   新决策记录：0 条
         * ```
         * **64 次模型调用，零产出。**
         *
         * ## 为什么模型会输出 `<tool>`
         *
         * 团队角色**没有工具**（我在 system 提示词里已经写明"你没有工具"），
         * 但模型仍会按训练里的习惯**假装调工具**（实测输出
         * `<tool>{"tool":"list_candidates",...}`）。
         * 提示词能降低概率，**不能保证** —— 而代价是整台重跑。
         *
         * 所以这里做**兜底**：既然团队真的没有工具，那它的输出里
         * **任何 `<tool>` 块都是幻觉**，剥掉即可。
         *
         * 顺带的好处：审计块里不再出现那段假的工具 JSON
         *（此前实测 `<team>` 块里混着 `{"tool":"l...`，读起来很困惑）。
         */
        text: stripToolBlocks(renderDeskOutcome(outcome, risk)),
        latencyMs: Date.now() - started,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}

/**
 * 问风控官。
 *
 * ## 提取裁决里的决策 → 交给风控官 → 解析它的结论
 *
 * 决策从**裁决文本**里抽（与渲染用的是同一个抽取器）—— 保证"风控官审的东西"
 * 与"最终执行的"是**同一份**。用两次不同的抽取会引入"审的是 A、执行的是 B"的风险。
 *
 * ## 失败时不阻断
 *
 * 风控官调用失败（额度尽、网关抖动）→ 返回 `null` → 渲染层会标明
 * "本轮未经风控官审阅"。**不抛错**：一次抖动不该让整轮决策作废
 *（而下一层 `RiskEngine` 的物理底线仍在，安全不靠这一层单独保证）。
 */
async function askRiskOfficer(
  ask: AskRole,
  outcome: DeskOutcome,
  onStep?: (step: { role: string; phase: string; note: string }) => void,
): Promise<{
  approved: boolean;
  adjusted: Decision[] | null;
  reason: string;
  concern: string | null;
  modelId: string | null;
} | null> {
  const extracted = outcome.verdict?.ok === true ? extractFirstJsonArray(outcome.verdict.raw) : null;
  const decisions = (extracted?.decisions ?? []) as Decision[];

  /* 没有决策要审（本轮本来就不行动）→ 不必多花一次调用。 */
  if (decisions.length === 0) return null;

  onStep?.({ role: 'risk_officer', phase: 'risk', note: `审阅 ${decisions.length} 条决策` });

  try {
    const out = await ask({
      role: 'risk_officer',
      tier: tierForRole('risk_officer'),
      context: [
        '## 待审决策',
        JSON.stringify(decisions, null, 2),
        '## 团队讨论摘要',
        outcome.summary,
        '## 裁决官结论',
        outcome.verdict?.raw.slice(0, 1500) ?? '（缺失）',
      ].join('\n\n'),
      task:
        '审阅上面的决策，判断**风险是否可接受**。你有权**否决**或**建议削减仓位**。' +
        '必须明确表态：说"批准"或"否决"（或"削减"）。' +
        '同时给出一句话理由，以及你担心的主要风险。' +
        '⚠️ 你的职责是**风险**，不是方向 —— 不要因为"我觉得会涨"而批准，' +
        '也不要因为"我觉得会跌"而否决；只看**风险敞口是否合适**。',
    });

    const verdict = parseRiskOfficerVerdict(out.raw, decisions);
    onStep?.({
      role: 'risk_officer',
      phase: 'risk',
      note: verdict.approved ? (verdict.reduced ? '削减后放行' : '放行') : '否决',
    });
    return {
      approved: verdict.approved,
      adjusted: verdict.adjusted,
      reason: verdict.reason,
      concern: verdict.concern,
      modelId: out.modelId,
    };
  } catch (error) {
    onStep?.({ role: 'risk_officer', phase: 'risk', note: `调用失败：${(error as Error).message}` });
    return null;
  }
}