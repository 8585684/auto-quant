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
  /**
   * 结束原因。**必须透传** —— 它是区分两种"空内容"的唯一依据：
   *
   *   · `'length'`  → 被 token 上限截断（思维链吃光预算）→ **加大预算重试**
   *   · 其他/null   → 真的空回复 → **重试，仍空则降级**
   *
   * 不透传的话，`classifyFailure` 里那条 `finishReason === 'length'` 分支
   * **永远不会命中**（实测发现的问题：那条分支曾是死代码）。
   */
  finishReason?: string | null;
  /** 失败时由实现抛出；路由器据此分类。 */
}>;

/** 路由器配置。 */
export interface ModelRouterOptions {
  /** 调用实现。 */
  call: CallModel;
  /** 健康注册表（可共享，让"哪个模型不行"在角色之间传播）。 */
  health?: ModelHealthRegistry;
  /**
   * **最多降级几次**（不是"最多试几个模型"）。
   *
   * 默认 3 → 循环是 `for (i = 0; i <= maxFallbacks; i++)`，即**至多试 4 个模型**。
   *
   * 数量这么定的理由：够覆盖"首选挂 → 平替挂 → 免费兜底 → 再兜一层"，
   * 又不至于一次调用把整条链跑完（那会把一次失败变成很长的等待；
   * 实测单模型失败要 10s+，4 个就是 40s+，已经吃掉一轮决策的可观预算）。
   *
   * ⚠️ **注释原来写的是"最多试几个模型：默认 3"，与代码不符**（复核发现 P2-J）。
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

/**
 * 因"被 token 上限截断"而重试时，预算再乘的倍数。
 *
 * **只乘一次**（`budgetBoosted` 是单次标记）。不设"反复加倍直到成功"的理由：
 * 那是 MAST 分类法里"步骤重复 15.7%"的形状 —— 预算越大思维链可能写得越长，
 * 收敛不了。**宁可这一次拿不到内容，也不要陷进无界重试。**
 */
const EMPTY_CONTENT_RETRY_MULTIPLIER = 2;

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
    /*
     * 被 token 上限截断时**放大预算原地重试**用的标记；`null` = 还没用过这个额度。
     * 只允许一次（见空内容分支里的说明：防止"预算越大、思维链越长"的死循环）。
     */
    let budgetBoosted: number | null = null;

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
          maxTokens: budgetFor(profile, budgetBoosted ?? options.baseMaxTokens),
        });
        const ms = Date.now() - started;

        /* ② 空内容检查 —— 实测的"HTTP 200 但没吐字"。 */
        if (result.text.trim().length === 0) {
          const verdict = classifyFailure({
            status: 200,
            message: '',
            emptyContent: true,
            finishReason: result.finishReason ?? null,
          });
          attempts.push({ modelId, ok: false, ms, note: verdict.reason });

          /*
           * ⚠️ **"被 token 上限截断"不该换模型**，而该**给同一个模型更多预算重试**。
           *
           * 实测：`gpt-6-astra` 在 mt=16/128 时 `content: null`（思维链吃光了预算），
           * mt=512 就正常吐字。**它不是坏了，是这次话说得多了一点** ——
           * 换模型会白白丢掉最强的那个（T3 候选链里它排第一）。
           *
           * 原来的实现是"换下一个候选"，与 `classifyFailure` 里
           * `shouldRetry: true, shouldFallback: false` 的承诺**不符**：
           * 循环顶部的 `pickAvailable` 跳过了 `tried`，所以永远试不到同一模型
           * —— 那条 `finishReason === 'length'` 分支等于白写。
           *
           * 这里改成：**不加入 `tried`，把预算翻倍后原地重试一次**。
           * 只重试一次（`budgetBoosted` 标记），避免"预算越大、思维链写得越长"
           * 的死循环 —— 那正是 MAST 分类法里"步骤重复 15.7%"的形状。
           */
          if (verdict.kind === 'empty_content' && result.finishReason === 'length' && budgetBoosted === null) {
            /*
             * ⚠️ **必须真的翻倍** —— 第一版这里写的是 `= options.baseMaxTokens`，
             * 那与"什么都不设置"完全等价：重试拿到**同样的预算**，必然再次被截断。
             * 等于"重试了一次但什么都没改变"，白花一次调用。
             */
            budgetBoosted = options.baseMaxTokens * EMPTY_CONTENT_RETRY_MULTIPLIER;
            tried.pop(); /* 允许重选同一个模型 */
            previousModel = modelId;
            continue;
          }

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
 *
 * ## 修过一次的 bug（2026-10-12 复核发现）
 *
 * 第一版写的是：
 *
 *     Math.min(maxOutputTokens > 0 ? maxOutputTokens : base * 4, base * 4)
 *
 * **它在 `maxOutputTokens < base × 4` 时返回的比 `base` 还小**，例如
 * `big-pickle`（maxOutput=32000）配上 `base=131072` → 返回 **32000（base 的 0.24 倍）**。
 * 也就是说：这个函数**在四个模型上把预算缩小了**，正好制造它要防的
 * `content: null` —— **注释承诺放大、代码执行缩小**。
 *
 * 为什么原来的测试没抓住：它用 `MODEL_PROFILES.find(m => m.reasoning && m.tier === 'T3_deep')`
 * 取到的是 `kimi-k3`，而它的 `maxOutputTokens === 0`（走 `base × 4` 那条路）——
 * **测试恰好只覆盖了唯一不会暴露 bug 的那个模型**。
 *
 * ## 正确的语义
 *
 * 「**放大，但不低于原值，也不超过供应商声明的上限**」：
 *
 *   · 供应商没报上限（0）→ `base × 倍率`
 *   · 报了上限 → 在 `[base, min(上限, base × 倍率)]` 之间取
 *     （`Math.max(base, …)` 保证**永不小于 base**）
 */
export function budgetFor(profile: ModelProfile | undefined, baseMaxTokens: number): number {
  if (profile?.reasoning !== true) return baseMaxTokens;
  const amplified = baseMaxTokens * REASONING_BUDGET_MULTIPLIER;
  if (profile.maxOutputTokens <= 0) return amplified;
  /*
   * `Math.max(baseMaxTokens, …)` 是关键那一半：**下限是原值**。
   * 少了它，供应商报的上限比 base 小的时候就会把预算缩下去。
   */
  return Math.max(baseMaxTokens, Math.min(profile.maxOutputTokens, amplified));
}

/** 从错误对象上尽力取 HTTP 状态码（不同层可能挂在 `status` 或 `statusCode`）。 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return null;
}
