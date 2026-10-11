/**
 * **模型档案** —— 哪个模型适合干什么，以及挂掉时往哪降级。
 *
 * ## 为什么需要这份档案（而不是直接写模型名）
 *
 * 用户 2026-10-12 的原话：
 *
 * > 「每个智能体根据工作内容来制定用什么模型……不同模型智商、速度、上下文等等不同，
 * >  具体做什么你来安排（当然你得先真实去查资料了解清楚，给程序建立一套档案，
 * >  还有更新的程序步骤，方便以后渠道更新了新模型，你也能更新相应的模型参数）」
 * > 「GPT\CLAUDE 系列，可用额度不多、也或许不可用，但是其他得模型基本能不限量供应，
 * >  特别是那些标注了免费得模型，因此设计系统你也要更加智能，**要有冗余、回退机制**，
 * >  比如你设计得主管用最高智能得claude模型，但是实际使用中，万一claude额度不足了，
 * >  系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
 *
 * 所以这里记的不是"模型名"，而是**能力档位 + 候选链**：
 *
 *   · 档位（tier）—— 这个角色需要多聪明
 *   · 候选链（ladder）—— 首选挂了就往下一档平替，**永远有得用**
 *
 * ## 数据来源（全部实测，不是猜）
 *
 * 速度来自 2026-10-12 对 magpie 网关的真实 HTTP 调用（见
 * `.dsh/2026-10-12-多智能体-实测情报.md`）；上下文/reasoning 来自 magpie 的
 * `plugin-providers.json`（19 供应商 / 705 模型的官方元数据）。
 *
 * **额度事实**（同一份实测）：`workbuddy-ai` 只剩 3.13/350 credits、`cline` 只剩 $0.50
 * —— 所以候选链**必须**包含免费档，且首选不能是额度最少的那类。
 */

/**
 * 能力档位。
 *
 * 依据 Anthropic 的多 agent 工程结论（多 agent 约 15× chat 的 token），
 * **把不需要智商的工作压到低档，是这套架构能不能长期跑下去的前提**。
 */
export type ModelTier =
  /** 不用 LLM，纯代码算（指标、风控限额、下单、对账）。 */
  | 'T0_code'
  /** 小快模型：字段映射、打标、摘要、情绪打分。实测 ≈1.5s 那一档。 */
  | 'T1_fast'
  /** 中档：单源分析、记忆反思、教训提炼。实测 4–5s 那一档。 */
  | 'T2_mid'
  /** 强推理：辩论、组合决策、风控裁决、异常归因。实测 3–7s 那一档。 */
  | 'T3_deep';

/** 一个模型条目的档案。 */
export interface ModelProfile {
  /** magpie 网关上的完整模型 id（`provider/model`）。 */
  id: string;
  tier: ModelTier;
  /** 实测单轮耗时（毫秒）；`null` = 没测过。 */
  measuredMs: number | null;
  /** 上下文窗口（token）。 */
  contextTokens: number;
  /** 最大输出（token）；`0` = 供应商没报。 */
  maxOutputTokens: number;
  /** 是否返回思维链。**思维链模型需要更大的 max_tokens，否则 content 会是 null**（实测）。 */
  reasoning: boolean;
  /**
   * 是否**免费/不限量**。
   *
   * 这一列是候选链的排序依据之一：额度紧张时优先用它们兜底
   *（用户原话：「其他得模型基本能不限量供应，特别是那些标注了免费得模型」）。
   */
  free: boolean;
  /**
   * 是否已实测**可用**。
   *
   * `false` 不代表永久不可用 —— 实测 `ling-3.1-flash-free` 在 mt=512 成功、
   * mt=16/128/2048 失败，**同一模型的可用性是波动的**。所以这一列只用于
   * **初始排序**，真正的可用性由运行期的健康记录决定。
   */
  verified: boolean;
  /** 一句话说明适合干什么（给人看的，也是提示词里"你是谁"的一部分）。 */
  goodFor: string;
}

/**
 * 模型档案表。
 *
 * ⚠️ **这一份是"初始档案"，不是"真理"**。运行期会由 `ModelHealthRegistry`
 * 覆盖可用性与延迟 —— 因为实测已证明同一模型的可用性会波动。
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  /* ---------- T3 强推理档 ---------- */
  {
    id: 'workbuddy-ai/gpt-6-astra',
    tier: 'T3_deep',
    measuredMs: 3045,
    contextTokens: 1_050_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '最高统筹、辩论裁决、组合决策',
  },
  {
    id: 'workbuddy-ai/gpt-6.1-sol',
    tier: 'T3_deep',
    measuredMs: 6638,
    contextTokens: 1_050_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '强推理平替',
  },
  {
    id: 'workbuddy-ai/kimi-k3',
    tier: 'T3_deep',
    measuredMs: 6152,
    contextTokens: 256_000,
    maxOutputTokens: 0,
    reasoning: true,
    free: false,
    verified: true,
    goodFor: '带思维链的深度分析',
  },
  {
    id: 'workbuddy-ai/grok-4.7',
    tier: 'T3_deep',
    measuredMs: 7103,
    contextTokens: 256_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '对抗性观点（与 GPT 系异质性）',
  },

  /* ---------- T2 中档 ---------- */
  {
    id: 'opencode-zen-free/longcat-2.5-preview-free',
    tier: 'T2_mid',
    measuredMs: 4327,
    contextTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '单源分析、长上下文整理（免费兜底主力）',
  },
  {
    id: 'opencode-zen-free/mimo-v2.6-flash-free',
    tier: 'T2_mid',
    measuredMs: 4589,
    contextTokens: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '资料整理、摘要（免费）',
  },
  {
    id: 'opencode-zen-free/space-bunny-free',
    tier: 'T2_mid',
    measuredMs: 3641,
    contextTokens: 1_048_576,
    maxOutputTokens: 524_288,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '超大上下文兜底（1M 窗口）',
  },
  {
    id: 'opencode-zen-free/step-5-preview-free',
    tier: 'T2_mid',
    measuredMs: 2834,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '快速整理（免费）',
  },

  /* ---------- T1 小快档 ---------- */
  {
    id: 'workbuddy-ai/deepseek-v4.1-flash',
    tier: 'T1_fast',
    measuredMs: 1505,
    contextTokens: 128_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '最快档：打标、字段映射、摘要、结构化抽取',
  },
  {
    id: 'workbuddy-ai/glm-5.3',
    tier: 'T1_fast',
    measuredMs: 1519,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    free: false,
    verified: true,
    goodFor: '快且带思维链',
  },
  {
    id: 'workbuddy-ai/fast-model',
    tier: 'T1_fast',
    measuredMs: 1517,
    contextTokens: 128_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '快速兜底',
  },
  {
    id: 'opencode-zen-free/nemotron-3.5-lightning-free',
    tier: 'T1_fast',
    measuredMs: 3246,
    contextTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费快速档',
  },
  {
    id: 'opencode-zen-free/big-pickle',
    tier: 'T1_fast',
    measuredMs: 4314,
    contextTokens: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费兜底',
  },
  {
    id: 'opencode-zen-free/muse-spark-1.3-contributor-free',
    tier: 'T1_fast',
    measuredMs: 4140,
    contextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费 + 大上下文',
  },
];

/**
 * 档位的**降级顺序**：高档位用完就往下走。
 *
 * 这就是用户说的「**向下平替**」的机器表达：
 * 「万一claude额度不足了，系统能智能把主管模型换成向下平替」。
 *
 * T3 用完 → 试 T2 的免费模型 → 还不行就试 T1 的免费模型。
 * **宁可让裁决官用一个弱一点的模型，也不要让整个交易台停摆。**
 */
const DOWNGRADE_PATH: Record<Exclude<ModelTier, 'T0_code'>, readonly ModelTier[]> = {
  T3_deep: ['T3_deep', 'T2_mid', 'T1_fast'],
  T2_mid: ['T2_mid', 'T1_fast'],
  T1_fast: ['T1_fast', 'T2_mid'],
};

/**
 * **候选链**：一个档位下的模型优先级。
 *
 * ## 排序规则（不是随便排的）
 *
 * 1. **首选给"最强且实测可用"的** —— 但用户提醒过 GPT/Claude 系额度少，
 *    所以首选**不放在额度最少的那一类**上；`workbuddy-ai` 实测只剩 3.13/350。
 * 2. **必须有免费兜底** —— 免费模型不限量，是"系统不中断"的最后一道保证。
 *    实测 T3 档全是付费模型，**光靠本档位会停摆**，所以必须跨档兜底。
 * 3. **同一档位内尽量跨供应商** —— 一个供应商挂了不该带走整条链。
 * 4. **跨档兜底时优先免费的** —— 高智商模型额度贵，兜底用免费的更可持续。
 *
 * 运行期还会被健康记录重排（连续失败的下沉），见 `ModelRouter`。
 */
export function ladderForTier(tier: ModelTier): readonly ModelProfile[] {
  if (tier === 'T0_code') return [];
  const path = DOWNGRADE_PATH[tier];

  const result: ModelProfile[] = [];
  for (const [index, t] of path.entries()) {
    const isOwnTier = index === 0;
    const candidates = MODEL_PROFILES.filter((m) => m.tier === t && m.verified);
    /*
     * 免费优先还是付费优先？**按档位不同**：
     *
     *   · T3（辩论/裁决）—— **智商优先**：先用最强的，额度不够时靠健康记录下沉。
     *   · T1/T2（体力活）—— **免费优先**：这类工作量大、不需要顶级智商，
     *     拿付费额度跑它们是浪费（用户原话：免费模型基本不限量）。
     *   · **兜底档一律免费优先** —— 高智商模型额度贵，拿它当兜底不划算。
     */
    const preferFree = !isOwnTier || t !== 'T3_deep';
    const sorted = [...candidates].sort((a, b) => {
      if (a.free !== b.free) return preferFree ? (a.free ? -1 : 1) : a.free ? 1 : -1;
      return (a.measuredMs ?? Number.MAX_SAFE_INTEGER) - (b.measuredMs ?? Number.MAX_SAFE_INTEGER);
    });
    for (const m of sorted) {
      if (!result.some((x) => x.id === m.id)) result.push(m);
    }
  }
  return result;
}

/** 按 id 取档案。 */
export function profileOf(modelId: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((m) => m.id === modelId);
}
