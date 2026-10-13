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
 * ## 风控官关卡（用户需求 #3）
 *
 * 裁决之后、渲染之前，**风控官**会再审一遍（见 `riskOfficer.ts`）：
 * 它可以否决或削减。它的结论写进 `<risk>` 块。
 *
 * ⚠️ **本层仍不做风控计算** —— 它只负责"把风控官的结论应用上去"。
 * 真正的物理底线在 `RiskEngine`（下一层），**那一层不可绕过**。
 */

import { isCloseAction, type Decision, type DecisionAction } from '@aq/shared';
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
 * ## 输出的三部分
 *
 * 1. **`<decision>` 块** —— 交易循环唯一认的东西。裁决里抽到的决策数组搬进来。
 * 2. **`<risk>` 块** —— 风控官的结论（批准/削减/否决 + 理由）。**审计用。**
 * 3. **`<team>` 块** —— 各角色产出摘要。**审计用。**
 *
 * 后两部分**不影响解析**（`autoTrader` 只找 `<decision>`），但它们是
 * "为什么这么决策"的唯一现场 —— 用户明确要求看得见。
 *
 * ## 风控官怎么接进来
 *
 * 由调用方把**已经问过风控官的结论**传进来（`risk`），本函数只负责
 * **把它应用到决策上**并渲染。
 *
 * 为什么不在这里问风控官：那需要一次模型调用，而本函数是**纯函数**
 *（有测试钉着、无 IO）。把 IO 留在调用方，这一层就能被测得很细 ——
 * 而"削减多少、否决了怎么办"正是最该被测的部分。
 */
export function renderDeskOutcome(
  outcome: DeskOutcome,
  risk?: {
    /** 风控官是否放行。 */
    approved: boolean;
    /** 削减后的决策（`null` = 没削减）。 */
    adjusted: Decision[] | null;
    /** 风控官给的理由。 */
    reason: string;
    /** 它担心什么。 */
    concern: string | null;
    /** 风控官用的模型（审计）。 */
    modelId?: string | null;
  } | null,
): string {
  const verdict = outcome.verdict;
  const extracted = verdict?.ok === true ? extractFirstJsonArray(verdict.raw) : { decisions: null, status: 'no-block' as const };

  /*
   * ── 风控官的应用（用户需求 #3）────────────────────────────────────────
   *
   * 三种情况：
   *   · **否决** → 决策清空（`[]`），本轮不行动；
   *   · **削减** → 用削减后的决策；
   *   · **放行** → 原样。
   *
   * ⚠️ 风控官**没跑**（`risk` 为 `null`）时**原样放行**，并**在审计块里标明
   * "本轮未经风控官审阅"** —— 静默跳过会让操作员以为"风控看过了"。
   */
  let finalDecisions: unknown[] | null = extracted.status === 'ok' ? extracted.decisions : null;
  if (risk !== undefined && risk !== null) {
    if (!risk.approved) {
      finalDecisions = [];
    } else if (risk.adjusted !== null) {
      finalDecisions = risk.adjusted as unknown[];
    }
  }

  const decisionBlock = finalDecisions !== null ? JSON.stringify(finalDecisions) : '[]';

  const lines: string[] = [];
  lines.push('<decision>');
  lines.push(decisionBlock);
  lines.push('</decision>');

  /*
   * ── `<risk>` 风控审计块 ──────────────────────────────────────────────
   */
  if (risk !== undefined && risk !== null) {
    lines.push('');
    lines.push('<risk>');
    lines.push(
      `${risk.approved ? (risk.adjusted !== null ? '削减后放行' : '放行') : '否决'}` +
        `${risk.modelId != null && risk.modelId.length > 0 ? `（${risk.modelId}）` : ''}：${risk.reason}`,
    );
    if (risk.concern !== null && risk.concern.length > 0) lines.push(`担心：${risk.concern}`);
    lines.push('</risk>');
  } else {
    lines.push('');
    lines.push('<risk>');
    lines.push('⚠️ 本轮**未经风控官审阅**（风控角色未启用或调用失败）—— 决策按裁决官结论直接放行。');
    lines.push('</risk>');
  }
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
  /*
   * ⚠️ **裁决官要留完整**（2026-10-13 修）。
   *
   * ## 原来截到 800 字，而那个长度**不够看出它的结论**
   *
   * 实测：裁决官的输出通常在 **1,500–3,000 字**（它要写：结论、置信度、
   * 关键依据、**不同意哪一方**、最大不确定性、失效条件）。
   * 截到 800 字的结果是**审计块里看不到它的 JSON 数组** ——
   * 而那个数组正是"本轮到底做了什么"的唯一凭证。
   *
   * ## 后果（我自己踩的）
   *
   * 我据此**误判**过一次：看到 800 字里没有 JSON，就断定
   * "裁决官从未输出 JSON 数组" —— 而核实后发现**它输出了**，
   * 只是数组是 `[]`（`deskOutput.ts` 的 `extracted.status === 'ok'`，
   * 所以那条"没找到 JSON 数组"的告警**没有出现**）。
   *
   * **一个为了省几百字而做的截断，制造了一个假结论。**
   *
   * 现在给 4,000 字（实测最长约 3,000）—— 完整保留它的推理与数组。
   * 分析师的 300 字**保持不变**：他们是并行产出、量大，
   * 而且他们的结论已经在辩论材料里被完整引用过。
   */
  if (verdict) lines.push(`- judge（${verdict.modelId}）：${verdict.ok ? verdict.raw.slice(0, 4_000) : `失败 —— ${verdict.error ?? '未知'}`}`);
  lines.push('</team>');

  return lines.join('\n');
}
