/**
 * **模型路由器** —— 按角色分派模型，并在失败时**自动向下平替**。
 *
 * ## 它在架构里的位置
 *
 * ```
 *   角色（调度官 / 分析师 / 风控官…）
 *        ↓  「我需要 T3 档」
 *   ModelRouter  ← 本文件
 *        ↓  选模型 → 调 magpie → 失败就降级
 *   magpie 网关（705 模型 / 额度跟踪）
 * ```
 *
 * 它包在 `DecisionModel` 之外，**不碰交易循环** —— 这是考古报告 §9.2 认定的
 * 「最小侵入接缝」：多角色/多模型可以在这一层解决，`autoTrader.ts` 一行不用改。
 *
 * ## 为什么不做成"一个角色固定一个模型"
 *
 * 用户明确要求冗余与回退（见 `modelHealth.ts` 顶部引用）。而实测额度已经见底
 *（`workbuddy-ai` 3.13/350、`cline` $0.50），所以**固定模型 = 定时停摆**。
 */

import {
  ladderForTier,
  profileOf,
  type ModelProfile,
  type ModelTier,
} from './modelCatalog.js';
import {
  ModelHealthRegistry,
  classifyFailure,
  pickAvailable,
  type FailureVerdict,
} from './modelHealth.js';

/** 一次模型调用的结果。 */
export interface RouterCallResult {
  /** 最终拿到内容的那个模型。 */
  modelId: string;
  /** 文本内容。 */
  text: string;
  latencyMs: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
  };
  /**
   * 这一次实际尝试过哪些模型（含失败的）。
   *
   * **必须暴露出来** —— 用户反复要求"看得见系统在做什么"，
   * 而"它降级了三次才拿到答案"正是最该被看见的信息。
   */
  attempts: Array<{ modelId: string; ok: boolean; ms: number; note: string }>;
}

/** 调用一个具体模型的函数（由调用方注入，便于测试与解耦）。 */
export type CallModel = (
  modelId: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: {
    signal?: AbortSignal;
    /**
     * 该模型的**输出预算**。路由器会按 `reasoning` 放大它 ——
     * 实测：思维链模型的 `reasoning_content` 会吃掉预算导致 `content: null`。
     */
    maxTokens: number;
  },
) => Promise<{
  text: string;
  latencyMs: number;
  usage: RouterCallResult['usage'];
  /** 失败时由实现抛出；路由器据此分类。 */
}>;

/** 路由器配置。 */
export interface ModelRouterOptions {
  /** 调用实现。 */
  call: CallModel;
  /** 健康注册表（可共享，让"哪个模型不行"在角色之间传播）。 */
  health?: ModelHealthRegistry;
  /**
   * 每条候选最多试几个模型。
   *
   * 默认 3：够覆盖"首选挂→平替挂→免费兜底"，又不至于一次调用把整条链跑完
   *（那会让一次失败变成一个很长的等待，实测单模型失败要 10s+）。
   */
  maxFallbacks?: number;
  /** 观测钩子：每次降级都回调一次（给日志/事件流用）。 */
  onFallback?: (info: { from: string | null; to: string; verdict: FailureVerdict }) => void;
}

/**
 * 思维链模型的输出预算放大倍数。
 *
 * **实测依据**：`gpt-6-astra` 在 `max_tokens=16/128` 时返回 `content: null` +
 * `reasoning=435/475`（思维链把预算吃光了），到 512 才正常吐字。
 * 所以对 `reasoning: true` 的模型，预算必须放大。
 */
const REASONING_BUDGET_MULTIPLIER = 4;

export class ModelRouter {
  private readonly health: ModelHealthRegistry;
  private readonly maxFallbacks: number;

  constructor(private readonly options: ModelRouterOptions) {
    this.health = options.health ?? new ModelHealthRegistry();
    this.maxFallbacks = options.maxFallbacks ?? 3;
  }

  /** 暴露健康状态（界面/日志用）。 */
  healthSnapshot(): ReturnType<ModelHealthRegistry['snapshot']> {
    return this.health.snapshot();
  }

  /**
   * **按档位调用** —— 这是给业务代码用的唯一入口。
   *
   * 流程：候选链 → 逐个尝试 → 失败分类 → 该重试就重试 / 该降级就降级。
   */
  async callByTier(
    tier: ModelTier,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: { signal?: AbortSignal; baseMaxTokens: number },
  ): Promise<RouterCallResult> {
    if (tier === 'T0_code') {
      throw new Error('T0_code 档不需要模型 —— 这类工作应当由代码完成（这是设计约束，不是错误）。');
    }

    const ladder = ladderForTier(tier).map((p) => p.id);
    if (ladder.length === 0) {
      throw new Error(`档位 ${tier} 没有任何候选模型 —— 模型档案（modelCatalog）需要补充。`);
    }

    const attempts: RouterCallResult['attempts'] = [];
    const tried: string[] = [];
    let previousModel: string | null = null;

    for (let i = 0; i <= this.maxFallbacks; i += 1) {
      const modelId = pickAvailable(ladder, this.health, tried);
      if (modelId === null) {
        /*
         * 整条链都在冷却 —— 这是"降级到无路可走"。
         *
         * 按 P2（最终决定权由代码强制）**不静默兜底**：抛出去让上层决定
         *（是等待、是告警、还是用最后手段）。**假装成功比失败更糟。**
         */
        throw new Error(
          `档位 ${tier} 的候选链全部处于冷却期（${ladder.length} 个模型）—— ` +
            `已尝试：${attempts.map((a) => `${a.modelId}(${a.note})`).join('；')}`,
        );
      }

      tried.push(modelId);
      const profile = profileOf(modelId);
      const started = Date.now();
      try {
        const result = await this.options.call(modelId, messages, {
          ...(options.signal ? { signal: options.signal } : {}),
          maxTokens: budgetFor(profile, options.baseMaxTokens),
        });
        const ms = Date.now() - started;

        /* ② 空内容检查 —— 实测的"HTTP 200 但没吐字"。 */
        if (result.text.trim().length === 0) {
          const verdict = classifyFailure({ status: 200, message: '', emptyContent: true, finishReason: null });
          attempts.push({ modelId, ok: false, ms, note: verdict.reason });
          this.health.recordFailure(modelId, verdict.reason);
          previousModel = modelId;
          continue;
        }

        attempts.push({ modelId, ok: true, ms, note: '成功' });
        this.health.recordSuccess(modelId);
        return { modelId, text: result.text, latencyMs: result.latencyMs, usage: result.usage, attempts };
      } catch (error) {
        const ms = Date.now() - started;
        const verdict = classifyFailure({
          status: statusOf(error),
          message: (error as Error).message,
        });
        attempts.push({ modelId, ok: false, ms, note: verdict.reason });

        if (verdict.shouldFallback) {
          this.health.recordFailure(modelId, verdict.reason);
          this.options.onFallback?.({ from: previousModel, to: modelId, verdict });
          previousModel = modelId;
          continue;
        }
        if (verdict.shouldRetry && i < this.maxFallbacks) {
          /* 可重试：不退避（退避在 LlmClient 内部已做），换下一个候选继续试。 */
          previousModel = modelId;
          continue;
        }
        /* 既不该降级也不该重试（例如 400 格式错）—— **原样抛出**，不掩盖 bug。 */
        throw error;
      }
    }

    throw new Error(
      `档位 ${tier} 试了 ${attempts.length} 个模型都失败：` +
        attempts.map((a) => `${a.modelId} → ${a.note}`).join('；'),
    );
  }
}

/**
 * 给一个模型算输出预算。
 *
 * ⚠️ **思维链模型必须放大** —— 否则实测会出现 `content: null`（预算被思维链吃光）。
 */
export function budgetFor(profile: ModelProfile | undefined, baseMaxTokens: number): number {
  if (profile?.reasoning !== true) return baseMaxTokens;
  return Math.min(
    /* 供应商报的最大输出（0 = 没报，用放大后的值）。 */
    profile.maxOutputTokens > 0 ? profile.maxOutputTokens : baseMaxTokens * REASONING_BUDGET_MULTIPLIER,
    baseMaxTokens * REASONING_BUDGET_MULTIPLIER,
  );
}

/** 从错误对象上尽力取 HTTP 状态码（不同层可能挂在 `status` 或 `statusCode`）。 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return null;
}
