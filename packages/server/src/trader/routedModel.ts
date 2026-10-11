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

import type { DecisionModel } from './autoTrader.js';
import type { ModelTier } from '../llm/modelCatalog.js';
import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { runTradingDesk, type AskRole, type DeskRoleOutput } from './agent/tradingDesk.js';
import { renderDeskOutcome } from './agent/deskOutput.js';

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
        const failures = result.attempts.filter((a) => !a.ok).length;
        for (const [index, a] of result.attempts.entries()) {
          onAttempt({
            role: request.role,
            modelId: a.modelId,
            ok: a.ok,
            ms: a.ms,
            note: a.note,
            fallbackCount: index + failures,
          });
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
export function createTeamDecisionModel(options: {
  router: ModelRouter;
  /** 交易循环给的系统提示词（含输出格式要求）。团队角色提示词会叠加在它之上。 */
  /** 每一步的回调（可观测性：让界面看得见团队在做什么）。 */
  onStep?: (step: { role: string; phase: string; note: string }) => void;
  /** 单次响应的输出预算。 */
  baseMaxTokens: number;
  /** 覆盖默认上限（测试用）。 */
  limits?: { maxCalls: number; maxDebateRounds: number };
}): DecisionModel {
  const { router, onStep, baseMaxTokens, limits } = options;

  /** 把一个角色的问题交给路由器。 */
  const ask: AskRole = async ({ role, tier, context, task }): Promise<DeskRoleOutput> => {
    const started = Date.now();
    try {
      const result = await router.callByTier(
        tier,
        [
          { role: 'system', content: `你是交易台的「${role}」。${task}` },
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
      const outcome = await runTradingDesk({
        ask,
        marketContext: systemPrompt,
        newsContext: userPrompt,
        positionContext: '',
        ...(onStep ? { onStep } : {}),
        ...(limits ? { limits } : {}),
      });

      return {
        text: renderDeskOutcome(outcome),
        latencyMs: Date.now() - started,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}