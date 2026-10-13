/**
 * **把调研 agent 的产出解析成结构化情报** —— `freshness` 的完整输入接线。
 *
 * ## 为什么必须是结构化的（而不是解析散文）
 *
 * `freshness.ts` 需要每个情报的 `publishedAt` 与 `sourceHost`。
 * 上一轮我让提示词"写明发布时刻"，但**散文里的时间无法可靠解析**：
 *
 * ```
 *   "3 小时前" / "昨天" / "10-08" / "最近"  → 无法机械地转成时间戳
 * ```
 *
 * 而**猜错的代价是静默的**：一条 3 天前的消息被当成"现在" →
 * 它会被当作新鲜情报进入决策。**那正是消息面交易最典型的亏钱方式。**
 *
 * 所以让模型**直接给结构化字段**（就像 `digest.ts` 那样）——
 * 模型的活是"判断与表达"，而"把时间字符串解析成时间戳"是**代码的活**。
 *
 * ## ⚠️ 三个防幻觉的设计
 *
 * | 设计 | 防什么 |
 * |---|---|
 * | `sourceUrl` 必填且必须是 **http(s)** | 编造的"来源"（没有链接就没有来源）|
 * | `publishedAt` 用**相对小时数**（`hoursAgo`）而不是日期字符串 | 时区/格式歧义；也避免模型算错日历 |
 * | 解析失败**保留原文并明确失败** | 静默丢弃会让"没查到"与"解析坏了"分不清 |
 */

import type { Intel } from './freshness.js';

/** 模型产出的单条情报（**相对小时数**，避免日期格式歧义）。 */
interface RawIntel {
  summary?: unknown;
  sourceUrl?: unknown;
  direction?: unknown;
  symbols?: unknown;
  /** **多少小时前发布** —— 用相对值，避免时区与日历解析错误。 */
  hoursAgo?: unknown;
}

export interface ParseIntelResult {
  intel: Intel[];
  /** 被丢弃的条目及原因（**必须能看见** —— 否则"没查到"与"解析坏了"分不清）。 */
  dropped: Array<{ reason: string; raw: string }>;
}

/** 从模型输出里抽出 JSON 数组（容忍 ```json 包裹与前后废话）。 */
function extractArray(text: string): unknown[] | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 URL 里取域名（交叉验证按它去重）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 解析调研产出。
 *
 * @param text 模型输出
 * @param now 当前时刻（用于把 `hoursAgo` 转成 `publishedAt`）
 * @param by 产出者（审计用）
 */
export function parseIntelReport(text: string, now: number, by: string): ParseIntelResult {
  const arr = extractArray(text);
  if (arr === null) {
    return { intel: [], dropped: [{ reason: '没有找到 JSON 数组', raw: text.slice(0, 300) }] };
  }

  const intel: Intel[] = [];
  const dropped: Array<{ reason: string; raw: string }> = [];

  for (const item of arr) {
    if (item === null || typeof item !== 'object') {
      dropped.push({ reason: '条目不是对象', raw: JSON.stringify(item).slice(0, 200) });
      continue;
    }
    const o = item as RawIntel;

    const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
    if (summary.length === 0) {
      dropped.push({ reason: '缺 summary', raw: JSON.stringify(item).slice(0, 200) });
      continue;
    }

    /*
     * ⚠️ **来源必须是 http(s) 链接** —— 没有链接就没有来源。
     *
     * 这是防幻觉的第一道闸：模型可以编一个"据某媒体报道"，
     * 但**编不出一个真实可点的链接**（而我们会保留它供人工核对）。
     */
    const sourceUrl = typeof o.sourceUrl === 'string' ? o.sourceUrl.trim() : '';
    const host = hostOf(sourceUrl);
    if (!/^https?:\/\//i.test(sourceUrl) || host.length === 0) {
      dropped.push({ reason: `来源链接无效（${sourceUrl.slice(0, 60)}）`, raw: summary.slice(0, 120) });
      continue;
    }

    const dir = o.direction;
    const direction = dir === 'bullish' || dir === 'bearish' || dir === 'neutral' ? dir : null;
    if (direction === null) {
      dropped.push({ reason: `direction 非法（${String(dir)}）`, raw: summary.slice(0, 120) });
      continue;
    }

    /*
     * `hoursAgo` 必须是 0 以上的有限数。
     * ⚠️ **不允许负值**：那意味着"未来发布"—— 要么是模型搞错，
     * 要么是时钟问题；两种都不该被当成"最新消息"放行。
     */
    const h = o.hoursAgo;
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) {
      dropped.push({ reason: `hoursAgo 非法（${String(h)}）`, raw: summary.slice(0, 120) });
      continue;
    }

    const symbols = Array.isArray(o.symbols)
      ? o.symbols.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];

    intel.push({
      summary,
      sourceUrl,
      sourceHost: host,
      publishedAt: now - h * 3_600_000,
      direction,
      symbols,
      by,
    });
  }

  return { intel, dropped };
}
