/**
 * **按币并行分析** —— 用户建议的核心编排。
 *
 * ## 来源：用户的建议（2026-10-12）
 *
 * > 「以前需要用到分析币种行情的时候（例如要分析 20 个币种），以前的做法
 * >  好像是全部放到一个上下文\对话中一次性分析，貌似会导致模型思考很长，
 * >  浪费实际，这个团队模式下是否能改成拆分，假设要分析 20 个，那就
 * >  **并行 20 个子代理，同步进行一人分析一个，分析完了以后汇总**」
 *
 * ## 这个模块做什么
 *
 * ```
 *   N 个标的
 *      ↓ mapConcurrent（并发闸门，默认 4）—— 【每人一个标的】
 *   N 份同构摘要（parseDigest 校验）
 *      ↓ rankDigests（【代码】排序，不用 AI）
 *   排好序的摘要 → 交给下游（辩论/裁决）
 * ```
 *
 * ## ⚠️ 三个"必须显式处理"的失败（不能静默）
 *
 * | 情况 | 若静默会发生什么 |
 * |---|---|
 * | 某个标的分析失败 | 它**消失**了，而下游以为"这个币没被选中"（其实是没分析成）|
 * | 摘要解析失败 | 同上 —— 而且**看不出来**是解析问题还是模型问题 |
 * | 标的对不上 | 结果被记到**错误的标的名下**（数字都在、格式都对）|
 *
 * 所以返回值里**失败项也要带上**（`failed`），并且**要能被日志看见**。
 *
 * ## 与"一次看全部"的取舍（诚实标注）
 *
 * | | 一次看全部（现状）| 按币并行（本模块）|
 * |---|---|---|
 * | 上下文 | 6 万字/次 | **每份几百字** |
 * | 跨币比较 | ✅ 模型能同时看到所有币 | ❌ **看不到别人**（这是真的损失）|
 * | 并发 | 1 次调用 | N 次（闸门控制）|
 * | 排序 | 模型自己排（有位置/长度偏差）| **代码排**（可复现）|
 *
 * **"看不到别人"这个损失必须由下游补偿** —— 排序用代码做（`rankDigests`），
 * 而"为什么这几个更好"由汇总/裁决环节回答。
 */

import { mapConcurrent } from './pool.js';
import { parseDigest, rankDigests, type SymbolDigest } from './digest.js';

/** 一个标的的分析请求（由调用方构造提示词 —— 本模块不管提示词）。 */
export interface SymbolTask {
  symbol: string;
  /** 该标的的材料（由调用方准备好 —— 本模块只负责编排）。 */
  context: string;
}

export interface PerSymbolInput {
  tasks: readonly SymbolTask[];
  /** 问一次模型（由调用方注入 —— 便于测试与换实现）。 */
  ask: (task: SymbolTask) => Promise<{ ok: boolean; text: string; error?: string }>;
  /** 同时几个（默认 4）。 */
  concurrency?: number;
}

export interface PerSymbolResult {
  /** 成功解析的摘要（**已按 `rankDigests` 排序**）。 */
  digests: SymbolDigest[];
  /**
   * **失败的标的** —— 必须回传，不能吞掉。
   *
   * 理由：下游（辩论/裁决）需要知道"**这些币是没分析成**"，
   * 而不是"它们被排除了"。两者在决策上的含义完全不同。
   */
  failed: Array<{ symbol: string; reason: string }>;
  /** 并发峰值（诊断用 —— 能证明闸门真的在生效）。 */
  peakConcurrency: number;
}

/**
 * 跑一轮按币并行分析。
 *
 * ⚠️ **不抛错**：任何单个标的的失败都被收进 `failed`。
 * 因为"20 个标的里 1 个的数据源抽了"是常态，
 * 若它让整批失败，现象会是"这一轮整个分析层没产出"——
 * 而真相只是 1 个标的的问题。
 */
export async function analyzePerSymbol(input: PerSymbolInput): Promise<PerSymbolResult> {
  const concurrency = Math.max(1, input.concurrency ?? 4);

  /* 诊断用：观察并发峰值，证明闸门在生效（也便于测试断言）。 */
  let running = 0;
  let peakConcurrency = 0;

  const results = await mapConcurrent(input.tasks, concurrency, async (task) => {
    running += 1;
    peakConcurrency = Math.max(peakConcurrency, running);
    try {
      const r = await input.ask(task);
      if (!r.ok) {
        /* 模型调用本身失败（超时/空内容）—— 原样带上原因。 */
        return { ok: false as const, symbol: task.symbol, reason: r.error ?? '模型未返回' };
      }
      /*
       * ⚠️ **解析时传 `expectedSymbol`** —— 让"模型答了另一个币"这件事
       * 在这里就被抓住，而不是等到下游把结果记到错的名下。
       */
      const parsed = parseDigest(r.text, task.symbol);
      if (!parsed.ok) {
        return { ok: false as const, symbol: task.symbol, reason: `摘要解析失败：${parsed.error}` };
      }
      return { ok: true as const, digest: parsed.digest };
    } finally {
      running -= 1;
    }
  });

  const digests: SymbolDigest[] = [];
  const failed: Array<{ symbol: string; reason: string }> = [];

  for (const [i, r] of results.entries()) {
    if (r.ok) {
      const v = r.value;
      if (v.ok) digests.push(v.digest);
      else failed.push({ symbol: v.symbol, reason: v.reason });
    } else {
      /* `mapConcurrent` 只在 `ask` **抛错**时走这里。 */
      const symbol = input.tasks[i]?.symbol ?? `#${i}`;
      failed.push({ symbol, reason: r.error });
    }
  }

  return { digests: rankDigests(digests), failed, peakConcurrency };
}

/**
 * 把"按币并行"的结果渲染成**给下游的一段文本**。
 *
 * ⚠️ **失败的标的一定要写进去**（而不是只写成功的）——
 * 否则下游会以为"这些币不在考虑范围"，而真相是"没分析成"。
 */
export function renderPerSymbolOutcome(result: PerSymbolResult): string {
  const parts: string[] = [];
  if (result.digests.length > 0) {
    parts.push(
      '## 各标的分析（按信号强度排序）',
      result.digests
        .map((d) => {
          const lv: string[] = [];
          if (d.keyLevels?.support !== undefined) lv.push(`支撑 ${d.keyLevels.support}`);
          if (d.keyLevels?.resistance !== undefined) lv.push(`阻力 ${d.keyLevels.resistance}`);
          let line = `- **${d.symbol}** 方向=${d.direction} 强度=${d.score} 置信=${d.confidence}${lv.length > 0 ? ` · ${lv.join('/')}` : ''}\n  依据：${d.evidence}\n  失效条件：${d.invalidates}`;
          if (d.dataGaps !== undefined && d.dataGaps.length > 0) line += `\n  ⚠️ 数据缺口：${d.dataGaps.join('；')}`;
          return line;
        })
        .join('\n'),
    );
  } else {
    parts.push('## 各标的分析', '（本轮没有任何标的分析成功）');
  }

  if (result.failed.length > 0) {
    parts.push(
      '## ⚠️ 分析失败的标的（**不是"被排除"，是没分析成**）',
      result.failed.map((f) => `- ${f.symbol}：${f.reason}`).join('\n'),
    );
  }

  return parts.join('\n\n');
}
