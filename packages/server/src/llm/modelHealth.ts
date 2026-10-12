/**
 * **模型健康记录 + 降级决策** —— "主管的 claude 额度不足时，自动向下平替"。
 *
 * ## 用户的原话（这是整个模块存在的理由）
 *
 * > 「GPT\CLAUDE 系列，可用额度不多、也或许不可用，但是其他得模型基本能不限量供应……
 * >  因此设计系统你也要更加智能，**要有冗余、回退机制**，比如你设计得主管用最高智能
 * >  得claude模型，但是实际使用中，万一claude额度不足了，**系统能智能把主管模型换成
 * >  向下平替**。保证系统不中断，持续工作」
 *
 * ## 判据从哪来（全部实测，不是猜）
 *
 * 2026-10-12 对 magpie 网关做的故障注入实测，得到这些**可编程的**错误形态：
 *
 * | 现象 | 判定 | 动作 |
 * |---|---|---|
 * | HTTP 404 `magpie knows no model` | 模型不存在/下线 | **立刻降级**（且长期标记失效）|
 * | HTTP 429 `Endpoint is unavailable` | 上游挂 / 额度尽 | **降级**，冷却一段时间 |
 * | HTTP 429 `rate_limit`（其他 429）| 限流 | **优先退避重试**，连续失败才降级 |
 * | HTTP 200 但 `content` 为空 + `finish=length` | 思维链吃光 token 预算 | **加大 max_tokens 重试**（**不降级**）|
 * | HTTP 400 `invalid request` | 请求格式错 | **不降级**（是 bug，降级会掩盖它）|
 *
 * ⚠️ **两个必须记住的实测事实**：
 *
 * 1. **429 被 magpie 同时用于"限流"和"端点不可用"** —— 只看状态码会误判，
 *    必须读 message 区分。这正是 `classifyFailure` 存在的理由。
 * 2. **同一模型的可用性是波动的** —— `ling-3.1-flash-free` 在 mt=512 成功、
 *    mt=16/128/2048 失败。所以**单次失败不足以判死一个模型**，
 *    必须"重试 + 降级"双保险，且失效要有冷却期（不能一次失败就永久拉黑）。
 */

/** 一次失败的分类 —— 决定"重试"还是"降级"。 */
export type FailureKind =
  /** 模型不存在/下线 → 降级。 */
  | 'model_missing'
  /** 上游不可用或额度尽 → 降级。 */
  | 'endpoint_down'
  /** 限流 → 先退避重试。 */
  | 'rate_limited'
  /** 超时 → 重试（可能是慢）。 */
  | 'timeout'
  /** 网络/连接失败 → 重试。 */
  | 'connection'
  /** 空内容（思维链吃光预算）→ **加大 max_tokens 重试，不降级**。 */
  | 'empty_content'
  /** 请求本身错（400）→ **不重试不降级**，这是 bug 要修。 */
  | 'bad_request'
  /** 认证/权限 → 不重试（重试没用），降级或报错。 */
  | 'auth'
  /** 其他未知。 */
  | 'unknown';

/** 失败分类的结果。 */
export interface FailureVerdict {
  kind: FailureKind;
  /** 该不该换下一个模型。 */
  shouldFallback: boolean;
  /** 该不该原地重试（同一模型）。 */
  shouldRetry: boolean;
  /** 面向人的中文原因。 */
  reason: string;
}

/**
 * 把一次失败翻译成"该重试还是该降级"。
 *
 * 输入是**原始错误文本 + HTTP 状态码** —— 因为实测证明只看状态码不够
 *（429 有两种截然不同的含义）。
 */
export function classifyFailure(input: {
  status: number | null;
  message: string;
  /** 调用是否已成功返回但内容为空。 */
  emptyContent?: boolean;
  /** 失败时的 finish_reason（`length` 说明是被 token 上限截断）。 */
  finishReason?: string | null;
}): FailureVerdict {
  const msg = input.message;
  const lower = msg.toLowerCase();

  /* ① 空内容（HTTP 200 但没吐字）—— 实测的思维链吃预算现象。 */
  if (input.emptyContent === true) {
    if (input.finishReason === 'length') {
      return {
        kind: 'empty_content',
        shouldFallback: false,
        shouldRetry: true,
        reason: '输出被 token 上限截断（思维链占满了预算），加大 max_tokens 重试。',
      };
    }
    return {
      kind: 'empty_content',
      shouldFallback: true,
      shouldRetry: true,
      reason: '模型返回了空内容，先重试；仍为空则换模型。',
    };
  }

  /* ② 模型不存在 —— magpie 明确回 "knows no model"。 */
  if (input.status === 404 || /knows no model|model not found|no such model/i.test(msg)) {
    return {
      kind: 'model_missing',
      shouldFallback: true,
      shouldRetry: false,
      reason: '网关不认识这个模型（可能已下线或名字写错），换下一个候选。',
    };
  }

  /* ③ 端点不可用 / 额度尽 —— 实测 magpie 用 429 表达它。 */
  /*
   * ⚠️ **`credit` / `exhaust` 是 2026-10-12 补的** —— 实测漏判过。
   *
   * 自检的 AI 层（每 30 分钟跑一次）报出：
   *
   * ```
   *   [自检/ai] AI 层调用失败：WorkBuddy AI: Credits exhausted.
   *   Please visit the link below to purchase add-on packs and get more credits
   * ```
   *
   * 这句话里**没有** `quota` / `insufficient` / `额度` 任何一个词 ——
   * 于是判据把它归到"不认识"的一类，**没有触发换模型**，
   * 整个调用就这么失败了。
   *
   * 后果比"一次调用失败"更大：那个供应商的模型会**一直**被选中、
   * **一直**失败，直到有人去看日志。而这正是 `ModelRouter` 的降级链
   * 本该解决的问题（`maxFallbacks: 3`）。
   *
   * 补上 `credit` 与 `exhaust` 之后，这句话会被正确识别成"额度尽" → 换下一个候选。
   */
  if (
    /endpoint is unavailable|not an available free model|insufficient|quota|allowance|余额|额度|credit|exhaust/i.test(
      lower,
    )
  ) {
    return {
      kind: 'endpoint_down',
      shouldFallback: true,
      shouldRetry: false,
      reason: '上游端点不可用或额度已尽，换下一个候选（这是设计内的降级）。',
    };
  }

  /* ④ 认证/权限 —— 重试无用。 */
  if (input.status === 401 || input.status === 403 || /unauthor|forbidden|invalid.*key/i.test(lower)) {
    return {
      kind: 'auth',
      shouldFallback: true,
      shouldRetry: false,
      reason: '认证或权限失败，重试无用，换候选。',
    };
  }

  /* ⑤ 请求格式错 —— **绝不降级**：降级会掩盖真正的 bug。 */
  if (input.status === 400 || /invalid request|cannot unmarshal|must be a nonempty/i.test(lower)) {
    return {
      kind: 'bad_request',
      shouldFallback: false,
      shouldRetry: false,
      reason: '请求本身不合法（400）—— 这是代码 bug，不该靠换模型掩盖。',
    };
  }

  /* ⑥ 限流（429 的其他形态）—— 先退避重试。 */
  if (input.status === 429 || /rate.?limit|too many requests|429/i.test(lower)) {
    return {
      kind: 'rate_limited',
      shouldFallback: false,
      shouldRetry: true,
      reason: '被限流，先退避重试（连续失败再降级）。',
    };
  }

  /* ⑦ 超时。 */
  if (input.status === 408 || input.status === 504 || /timeout|timed out|aborted/i.test(lower)) {
    return {
      kind: 'timeout',
      shouldFallback: false,
      shouldRetry: true,
      reason: '超时（可能只是慢），重试。',
    };
  }

  /* ⑧ 连接层。 */
  if (input.status === null || /fetch failed|econnrefused|enotfound|socket|network/i.test(lower)) {
    return {
      kind: 'connection',
      shouldFallback: false,
      shouldRetry: true,
      reason: '连接失败（网络抖动），重试。',
    };
  }

  /* ⑨ 5xx。 */
  if (input.status !== null && input.status >= 500) {
    return {
      kind: 'endpoint_down',
      shouldFallback: true,
      shouldRetry: true,
      reason: '上游 5xx，先重试一次，仍失败则换候选。',
    };
  }

  return {
    kind: 'unknown',
    shouldFallback: true,
    shouldRetry: true,
    reason: `未归类的失败：${msg.slice(0, 120)}`,
  };
}

/** 一个模型的运行期健康状态。 */
interface HealthEntry {
  /** 连续失败次数（成功清零）。 */
  consecutiveFailures: number;
  /** 冷却截止时刻（epoch ms）；在此之前不选它。 */
  cooldownUntil: number;
  /** 累计成功/失败（用于观测，不参与决策）。 */
  okCount: number;
  failCount: number;
  /** 最后一次失败的原因（给人看）。 */
  lastFailure: string | null;
}

/**
 * **模型健康注册表** —— 降级决策的状态源。
 *
 * ## 冷却而不是永久拉黑
 *
 * 实测证明同一模型的可用性会波动（`ling-3.1-flash-free` 时好时坏），
 * 所以失败只让它**冷却一段时间**，不是永久弃用 —— 否则一个瞬时抖动
 * 会把好模型永久踢出候选链，那正是"降低实际能力"的做法。
 *
 * ## 为什么不用 DB
 *
 * 这是**运行期状态**（进程内），不是事实。落库反而会有"重启后带着陈旧健康记录"
 * 的问题。进程重启 = 重新探测，这符合"单次探测不足以判定"的实测结论。
 */
export class ModelHealthRegistry {
  private readonly entries = new Map<string, HealthEntry>();

  constructor(
    /** 连续失败几次开始冷却。默认 2：单次失败不足以判死（实测结论）。 */
    private readonly failureThreshold = 2,
    /** 冷却时长（毫秒）。默认 5 分钟。 */
    private readonly cooldownMs = 5 * 60_000,
    /** 注入时钟，便于测试。 */
    private readonly now: () => number = Date.now,
  ) {}

  /** 记一次成功。 */
  recordSuccess(modelId: string): void {
    const e = this.entry(modelId);
    e.consecutiveFailures = 0;
    e.cooldownUntil = 0;
    e.okCount += 1;
    e.lastFailure = null;
  }

  /** 记一次失败，并返回它是否已进入冷却。 */
  recordFailure(modelId: string, reason: string): { coolingDown: boolean } {
    const e = this.entry(modelId);
    /*
     * ⚠️ **冷却已到期时，这次失败算新一轮的开始**（2026-10-12 复核发现的 P1-E）。
     *
     * 原来只在 `recordSuccess` 里清零，于是冷却到期后 `consecutiveFailures`
     * **仍然是阈值**（例如 2）—— 下一次单点失败**立刻又冷却 5 分钟**。
     * 后果：一个"每 5 分钟试一次、试一次就再关 5 分钟"的模型，**实际可用率接近 0**，
     * 与本类注释的承诺（「失败只让它冷却一段时间……否则一个瞬时抖动会把好模型
     * 永久踢出候选链」）**正好相反**。
     *
     * 清零放在这里（写入时）而不是 `isAvailable`（读取时），是因为后者会被
     * `pickAvailable` 在每次失败之间调用 —— 放在那里会导致"连续失败"永远
     * 累积不到阈值（实测立刻被测试抓到）。
     */
    if (e.cooldownUntil > 0 && this.now() >= e.cooldownUntil) {
      e.consecutiveFailures = 0;
      e.cooldownUntil = 0;
    }
    e.consecutiveFailures += 1;
    e.failCount += 1;
    e.lastFailure = reason;
    if (e.consecutiveFailures >= this.failureThreshold) {
      e.cooldownUntil = this.now() + this.cooldownMs;
      return { coolingDown: true };
    }
    return { coolingDown: false };
  }

  /**
   * 现在能不能用它。
   *
   * ⚠️ **纯读，无副作用** —— 这一点很重要：`pickAvailable` 会在**每次失败之间**
   * 调用它，如果在这里清零计数，"连续失败"就永远累积不到阈值。
   * 那是第一版的修法，实测立刻被测试抓到（`连续第二次失败才冷却` 失败）。
   *
   * 清零改在 `recordFailure` 里做 —— 语义上也是那里更对：
   * **"是否该把这次失败算作新一轮的开始"是写入时才需要判断的事。**
   */
  isAvailable(modelId: string): boolean {
    const e = this.entries.get(modelId);
    if (!e) return true;
    return this.now() >= e.cooldownUntil;
  }

  /** 只读快照（给界面/日志用）。 */
  snapshot(): Array<{ modelId: string; available: boolean; consecutiveFailures: number; okCount: number; failCount: number; lastFailure: string | null; cooldownMsLeft: number }> {
    const t = this.now();
    return [...this.entries.entries()].map(([modelId, e]) => ({
      modelId,
      available: t >= e.cooldownUntil,
      consecutiveFailures: e.consecutiveFailures,
      okCount: e.okCount,
      failCount: e.failCount,
      lastFailure: e.lastFailure,
      cooldownMsLeft: Math.max(0, e.cooldownUntil - t),
    }));
  }

  /** 清空（测试用）。 */
  reset(): void {
    this.entries.clear();
  }

  private entry(modelId: string): HealthEntry {
    let e = this.entries.get(modelId);
    if (!e) {
      e = { consecutiveFailures: 0, cooldownUntil: 0, okCount: 0, failCount: 0, lastFailure: null };
      this.entries.set(modelId, e);
    }
    return e;
  }
}

/**
 * 从候选链里挑出**现在可用**的下一个模型。
 *
 * 返回 `null` 表示**整条链都在冷却** —— 那种情况下调用方应当：
 * ① 用链上第一个（宁可试一个刚失败过的，也不要完全停摆）；
 * ② 或者按 P2 原则（最终决定权由代码强制）向上报"当前无可用模型"。
 *
 * **不在这里做"强行选第一个"的决定** —— 那是策略，交给调用方。
 */
export function pickAvailable(
  ladder: readonly string[],
  health: ModelHealthRegistry,
  tried: readonly string[] = [],
): string | null {
  for (const id of ladder) {
    if (tried.includes(id)) continue;
    if (health.isAvailable(id)) return id;
  }
  return null;
}
