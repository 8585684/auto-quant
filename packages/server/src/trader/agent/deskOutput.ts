/**
 * **团队决策 → 交易循环格式的适配器**。
 *
 * ## 为什么需要它（这是 S3 能不能真正跑起来的关键一环）
 *
 * `autoTrader` 对模型的输出**只有一个契约**（见 `strategy/prompt.ts` 的「输出格式要求」）：
 *
 *     <decision>
 *     [ {"symbol":"BTCUSDT","action":"open_long", ...} ]
 *     </decision>
 *
 * 而交易台的产出是**多角色结构化卡片**（分析、论证、裁决）。两者形状不同，
 * 中间必须有一层翻译 —— 否则团队跑完一轮，交易循环解析不到任何决策，
 * **整轮白跑**（而且不会报错，只是"没有动作"，那是最难发现的一种失败）。
 *
 * ## 设计原则：**翻译必须可审计、不吞信息**
 *
 * 用户要求「看得见系统在做什么」。所以：
 *
 *   · 裁决里的**决策数组**原样搬进 `<decision>` 块（不做任何"智能"加工）；
 *   · 各角色的论证**附在后面**（`<team>` 块），让操作员能看到"为什么这么决策"；
 *   · **解析失败时不编造** —— 返回空决策块 + 说明，而不是猜一个动作。
 *
 * ⚠️ **绝不在这里做风控或仓位计算** —— 那是既有 `RiskEngine` 的职责。
 * 本文件只做**形状转换**，不做任何判断。
 */

import type { DeskOutcome } from './tradingDesk.js';

/** 从裁决的原始文本里抽出决策数组。 */
export interface ExtractedDecisions {
  /** 抽到的决策数组（`null` = 没抽到）。 */
  decisions: unknown[] | null;
  /**
   * 抽到的原因。
   *
   * 三种情况必须区分（混在一起会让"模型没给决策"和"格式写错了"看起来一样）：
   *   · `ok`        —— 正常抽到数组
   *   · `no-block`  —— 文本里根本没有 JSON 数组（模型可能只写了散文）
   *   · `bad-json`  —— 有像数组的片段但 JSON 解析失败
   */
  status: 'ok' | 'no-block' | 'bad-json';
  /** `bad-json` 时的原始片段（截断，供排查）。 */
  snippet?: string;
}

/**
 * 从任意文本里抽出**第一个 JSON 数组**。
 *
 * ## 为什么要自己扫括号而不是正则
 *
 * 正则 `\[[\s\S]*\]` 在**嵌套数组**上会贪婪匹配到最后一个 `]`，
 * 于是 `[{"a":[1,2]},{"b":3}]` 后面的尾巴会被吃进来变成非法 JSON。
 * 而模型的输出里嵌套数组很常见（止损止盈的数组、理由里的列表）。
 *
 * 所以扫括号计数，且**跳过字符串内部的括号** —— 否则 `{"reasoning":"买[入]点"}`
 * 会让计数错位。
 */
export function extractFirstJsonArray(text: string): ExtractedDecisions {
  const start = text.indexOf('[');
  if (start < 0) return { decisions: null, status: 'no-block' };

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(slice);
          return Array.isArray(parsed) ? { decisions: parsed, status: 'ok' } : { decisions: null, status: 'bad-json', snippet: slice.slice(0, 200) };
        } catch {
          return { decisions: null, status: 'bad-json', snippet: slice.slice(0, 200) };
        }
      }
    }
  }
  /* 括号没闭合 —— 输出被截断了（实测确有此事：token 上限）。 */
  return { decisions: null, status: 'bad-json', snippet: text.slice(start, start + 200) };
}

/**
 * 把交易台的产出翻成 `autoTrader` 能解析的文本。
 *
 * ## 输出的两部分
 *
 * 1. **`<decision>` 块** —— 交易循环唯一认的东西。裁决里抽到的决策数组原样搬进来。
 * 2. **`<team>` 块** —— 人看的审计信息（各角色产出摘要）。
 *
 * 第 2 部分**不影响解析**（`autoTrader` 只找 `<decision>`），但它是
 * "为什么这么决策"的唯一现场 —— 用户明确要求看得见。
 */
export function renderDeskOutcome(outcome: DeskOutcome): string {
  const verdict = outcome.verdict;
  const extracted = verdict?.ok === true ? extractFirstJsonArray(verdict.raw) : { decisions: null, status: 'no-block' as const };

  const decisionBlock =
    extracted.status === 'ok' && extracted.decisions !== null
      ? JSON.stringify(extracted.decisions)
      : '[]';

  const lines: string[] = [];
  lines.push('<decision>');
  lines.push(decisionBlock);
  lines.push('</decision>');
  lines.push('');
  lines.push('<team>');
  lines.push(`交易台：${outcome.summary}`);
  if (outcome.truncatedByBudget) {
    lines.push('⚠️ 本轮因预算/轮次上限提前收尾 —— 结论是在受限条件下得出的。');
  }
  if (extracted.status !== 'ok') {
    /*
     * ⚠️ **失败要说清楚是哪一种失败**，不能只说"没有决策"。
     * `no-block`（模型没给 JSON）与 `bad-json`（给了但写坏了）是两个不同的问题，
     * 对应的修法也不同（前者要改提示词，后者可能是 token 被截断）。
     */
    lines.push(
      extracted.status === 'no-block'
        ? '⚠️ 裁决里没有找到 JSON 数组 —— 模型可能只写了散文。本轮按"不行动"处理。'
        : `⚠️ 裁决里的 JSON 解析失败（可能被截断）—— 本轮按"不行动"处理。片段：${extracted.snippet ?? ''}`,
    );
  }
  lines.push('');
  lines.push('## 各角色产出');
  for (const a of outcome.analyses) {
    lines.push(`- ${a.role}（${a.modelId}）：${a.ok ? a.raw.slice(0, 300) : `失败 —— ${a.error ?? '未知'}`}`);
  }
  if (outcome.bull) lines.push(`- bull（${outcome.bull.modelId}）：${outcome.bull.ok ? outcome.bull.raw.slice(0, 400) : '失败'}`);
  if (outcome.bear) lines.push(`- bear（${outcome.bear.modelId}）：${outcome.bear.ok ? outcome.bear.raw.slice(0, 400) : '失败'}`);
  if (verdict) lines.push(`- judge（${verdict.modelId}）：${verdict.ok ? verdict.raw.slice(0, 800) : `失败 —— ${verdict.error ?? '未知'}`}`);
  lines.push('</team>');

  return lines.join('\n');
}
