/**
 * **决策模型路由器** —— 把 `ModelRouter` 适配成 `DecisionModel`。
 *
 * ## 它在架构里的位置
 *
 * ```
 *   autoTrader.runCycleBody 第 7 步
 *         ↓  this.deps.model.complete(system, user)
 *   【本文件】DecisionModel 适配层
 *         ↓  按角色/档位选模型 → 失败自动降级
 *   ModelRouter → magpie 网关
 * ```
 *
 * ## 为什么需要它（而不是直接在 manager 里写）
 *
 * 考古报告认定的**模型侧唯一接缝**是 `DecisionModel`（`autoTrader.ts:381-434`），
 * 而适配层原来只有一句 `client.complete(...)` —— 单一模型、单一客户端
 *（考古报告 H2：「单模型单客户端，`reasoningEffort` 硬编码」）。
 *
 * 把多模型逻辑放在**这里**而不是 `autoTrader` 里，是因为：
 *
 *   · `autoTrader` 是**最安全攸关**的文件（10201 行），改动越少越好；
 *   · 团队模式与智能托管**必须互不干扰**（用户硬约束）——
 *     用一层适配器切换，比在交易循环里加 `if (mode === 'ai_team')` 干净得多。
 *
 * ## 与 `ai_managed` 的关系：**零影响**
 *
 * 这个适配器**只在 `ai_team` 模式下构造**。智能托管仍然用原来那个
 * 单客户端的适配器 —— 一行都不用改。
 */

import type { DecisionModel } from './autoTrader.js';
import type { ModelTier } from '../llm/modelCatalog.js';
import { ModelRouter, type CallModel } from '../llm/modelRouter.js';

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
