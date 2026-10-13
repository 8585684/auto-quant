/**
 * **消息面情报的时效性与可信度** —— 用户第二个灵感的两个核心机制。
 *
 * ## 来源：用户的"消息面猎手团队"（2026-10-12）
 *
 * > 「有一个团队会全网进行消息面的找机会（固定上网查最新消息、各种社交媒体、
 * >  名人、交易所社区、金融机构、新闻等等去找消息面的机会，找到机会以后
 * >  **自己整理、分析、上报**，然后由实战团队进行分析、测试、验证……
 * >  **并且得注意一点：消息面的东西常常有时效性，如果消息面的策略失效后，
 * >  应当会及时修正、调整、改变**」
 *
 * 用户**主动点出了时效性** —— 这是对的，而且是消息面交易最容易亏钱的地方。
 *
 * ## 三个必须处理的真问题
 *
 * | 问题 | 机制 | 本文件 |
 * |---|---|---|
 * | **时效性** | 每条情报带 **TTL**，过期**降权 → 作废** | ✅ `decay()` |
 * | **幻觉** | **强制带来源** + **交叉验证**（≥2 独立来源才算确认）| ✅ `assess()` |
 * | **策略失效** | 消息面策略连亏 → 标记失效 | ⏳ 下一步 |
 *
 * ## ⚠️ 为什么"过期"要分两档（降权 / 作废）而不是一刀切
 *
 * 消息的价值**随时间连续衰减**，不是"到点突然归零"：
 *
 * ```
 *   刚发布（0-2h）    : 权重 1.0
 *   半天内            : 权重线性降到 0.5
 *   TTL 之后          : 权重 0（作废，不再进入决策）
 * ```
 *
 * 一刀切（"2 小时后就完全不用"）会在边界上产生**突变**：
 * 1 小时 59 分的情报有用、2 小时 01 分的完全没用 —— 那不合理。
 */

/** 一条消息面情报。 */
export interface Intel {
  /** 一句话摘要（给人和模型看的）。 */
  summary: string;
  /** **来源链接** —— 必填，没有来源的情报**不可信**（防幻觉）。 */
  sourceUrl: string;
  /** 来源的**域名**（用于判断"是不是同一个来源"）。 */
  sourceHost: string;
  /** 发布时刻（毫秒时间戳）。 */
  publishedAt: number;
  /** 方向：利多 / 利空 / 中性。 */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 涉及的标的（可空 = 全市场）。 */
  symbols: readonly string[];
  /** 提出这条情报的 agent（审计用）。 */
  by: string;
}

/** 情报的时效档位。 */
export type IntelFreshness = 'fresh' | 'aging' | 'stale' | 'expired';

export interface IntelAssessment {
  freshness: IntelFreshness;
  /** 剩余权重（0~1）。0 = 不该进入决策。 */
  weight: number;
  /** 已过多久（毫秒）。 */
  ageMs: number;
  /** 交叉验证：有几个**独立来源**（按域名去重）确认了它。 */
  independentSources: number;
  /** 是否达到"已确认"门槛。 */
  confirmed: boolean;
  /** 一句话结论（给人看）。 */
  verdict: string;
}

/**
 * **默认 TTL 分档**（毫秒）。
 *
 * ⚠️ 这些是**起步值**，应按实测校准（不同消息类型的半衰期差别很大：
 * 交易所公告可能只有几十分钟，而监管政策能影响数周）。
 */
export const INTEL_TTL = {
  /** 新鲜：满权重。 */
  FRESH_MS: 2 * 60 * 60_000,
  /** 衰减结束：此后按 `aging` 线性降权。 */
  DECAY_END_MS: 12 * 60 * 60_000,
  /** 作废：超过它不再进入决策。 */
  EXPIRE_MS: 48 * 60 * 60_000,
} as const;

/** 算一条情报的时效权重。 */
export function decay(publishedAt: number, now: number): { freshness: IntelFreshness; weight: number; ageMs: number } {
  const ageMs = Math.max(0, now - publishedAt);

  if (ageMs <= INTEL_TTL.FRESH_MS) {
    return { freshness: 'fresh', weight: 1, ageMs };
  }
  if (ageMs >= INTEL_TTL.EXPIRE_MS) {
    return { freshness: 'expired', weight: 0, ageMs };
  }
  if (ageMs >= INTEL_TTL.DECAY_END_MS) {
    /* 12h 之后：线性从 0.5 降到 0（到 48h 归零）。 */
    const span = INTEL_TTL.EXPIRE_MS - INTEL_TTL.DECAY_END_MS;
    const left = INTEL_TTL.EXPIRE_MS - ageMs;
    return { freshness: 'stale', weight: 0.5 * (left / span), ageMs };
  }
  /* 2h~12h：线性从 1.0 降到 0.5。 */
  const span = INTEL_TTL.DECAY_END_MS - INTEL_TTL.FRESH_MS;
  const passed = ageMs - INTEL_TTL.FRESH_MS;
  return { freshness: 'aging', weight: 1 - 0.5 * (passed / span), ageMs };
}

/**
 * 评估一组情报：时效 + 交叉验证。
 *
 * ## 交叉验证的判据：**按域名去重**
 *
 * ⚠️ 为什么按**域名**而不是"条数"：
 *
 * 同一个消息被 5 家媒体转载，**仍然只有一个信息源** —— 按条数算会把
 * "转载"误判成"5 个来源确认"。**按域名去重才反映"独立来源"的真实数量。**
 *
 * 门槛取 **2**：一条只有单一来源的消息可能是错的、也可能是谣言；
 * 两个独立来源同时报道，可信度有实质提升（这是新闻业的基本标准）。
 */
export function assess(intel: Intel, now: number, peers: readonly Intel[] = []): IntelAssessment {
  const d = decay(intel.publishedAt, now);

  /*
   * 交叉验证：**同一件事**的其它来源。
   *
   * 判据用"方向 + 标的集合"相同 —— 这是"同一件事"的可操作近似。
   * ⚠️ 这是近似：两条措辞完全不同但讲同一件事的报道**不会**被认出来。
   * 更准的做法需要语义匹配（那是下一步）。
   */
  const sameEvent = (o: Intel): boolean => {
    if (o === intel) return false;
    if (o.direction !== intel.direction) return false;
    const a = [...intel.symbols].sort().join(',');
    const b = [...o.symbols].sort().join(',');
    return a === b;
  };

  const hosts = new Set<string>([intel.sourceHost]);
  for (const p of peers) {
    if (sameEvent(p) && p.sourceHost.length > 0) hosts.add(p.sourceHost);
  }
  const independentSources = hosts.size;
  const confirmed = independentSources >= 2;

  const verdict = d.freshness === 'expired'
    ? `已过期（${(d.ageMs / 3_600_000).toFixed(1)} 小时）—— 不该进入决策`
    : !confirmed
      ? `仅 ${independentSources} 个独立来源 —— **未确认**，应降权使用`
      : `${d.freshness === 'fresh' ? '新鲜' : d.freshness === 'aging' ? '尚新' : '偏旧'}（${(d.ageMs / 3_600_000).toFixed(1)} 小时）· ${independentSources} 个独立来源已确认`;

  return { ...d, independentSources, confirmed, verdict };
}

/**
 * 把一组情报按"有效权重"排序，并**剔除过期与未确认的**。
 *
 * @param intel 所有情报
 * @param now 当前时刻
 * @param opts `requireConfirmed`（默认 true）—— 未确认的是否直接剔除
 */
export function rankIntel(
  intel: readonly Intel[],
  now: number,
  opts: { requireConfirmed?: boolean } = {},
): Array<{ intel: Intel; assessment: IntelAssessment }> {
  const requireConfirmed = opts.requireConfirmed ?? true;
  const out: Array<{ intel: Intel; assessment: IntelAssessment }> = [];

  for (const i of intel) {
    const a = assess(i, now, intel);
    if (a.weight <= 0) continue; /* 过期 → 不进决策 */
    if (requireConfirmed && !a.confirmed) continue; /* 未确认 → 不进决策 */
    out.push({ intel: i, assessment: a });
  }

  /* 权重降序；同权重时新的优先（同分下"更近的事"更该被看到）。 */
  return out.sort((x, y) =>
    y.assessment.weight - x.assessment.weight ||
    y.intel.publishedAt - x.intel.publishedAt);
}
