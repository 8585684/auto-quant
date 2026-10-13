/**
 * 智能体运行时：`AutoTrader` 与智能体模块之间的**唯一接缝**。
 *
 * ## 为什么单独一层，而不是直接写进 `autoTrader.ts`
 *
 * `autoTrader.ts` 有 3000+ 行，而且它是这个项目里**最安全攸关**的文件 ——
 * 每一处改动都在动真实资金。把智能体逻辑摊进去有两个代价：
 *
 * 1. **风险**：一个 3000 行的文件里再插一层控制流，出错的概率和排查的难度都上升。
 * 2. **耦合**：智能体成了"交易循环的一部分"，而不是"挂在交易循环上的一个能力"。
 *
 * 所以 `AutoTrader` 只在**两个点**认识它：进周期时问一次"要不要审视"、
 * 平仓之后请它"复盘这笔"。其余全在这一层里。
 *
 * ## 三条它自己必须遵守的纪律
 *
 * 1. **绝不抛穿。** 智能体是**附加**能力。它坏了、模型欠费了、端口读不到数据 ——
 *    都不该让机器人停止交易。所有对外方法都吞掉异常并记一行日志。
 * 2. **绝不阻塞交易循环太久。** 一次审视要跑工具循环（可能十几秒到几十秒）。
 *    调用方用 `void` 触发、不 `await`，避免把 3 分钟的周期撑长。
 * 3. **只在 AI 模式下动作。** `agent_config_json` 为空时它整个是空转的 ——
 *    老机器人不该因为这一层存在而有任何行为变化。
 */

import { closeReasonLabel, marginPercentToPricePercent, type StrategyConfig } from '@aq/shared';

import type { ReviewTradeFacts } from '../autoTrader.js';

import { createLogger } from '../../logger.js';
import { agentMemory, agentRuns } from '../../store/agentStore.js';
import { decisions as decisionStore } from '../../store/repositories.js';
import { traders } from '../../store/repositories.js';
import type { LoopModel } from './loop.js';
import { hasAgentConfig, readAgentConfig } from './config.js';
import { markStrategyReview, markWoken, makeAgentPorts } from './ports.js';
import {
  reviewClosedTrade,
  runHealthCheck,
  runStrategyReview,
  settlePending,
} from './orchestrator.js';
import { DEFAULT_WAKE_POLICY, type WakePolicy } from './wake.js';

const log = createLogger('trader:agent');

/* -------------------------------------------------------------------------- */
/*  体检事实的构造                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 把 `agent_runs` 的行**变成工程师能读懂的事实**。
 *
 * ## 为什么必须在这里"算好"再给模型
 *
 * 用户要求"不要让我来发现问题"，而这个角色的成败**几乎全在喂给它的数据**上。
 * 把 30 行原始 JSON 丢给它，它会去**猜**哪一行是异常；而算好之后，
 * "同一个失败出现 N 次"是**摆在那里的数字**。
 *
 * ## ⚠️ 刻意给出的四类判据
 *
 * ```
 *   ① 失败率        —— ok/degraded/failed 各几次（"静默失败"的第一判据）
 *   ② 重复的失败原因 —— 相同 detail 出现 N 次（区分"系统性"与"一次抖动"）
 *   ③ 耗时分布      —— 最大/中位（"某个角色比基线慢很多倍"）
 *   ④ 步数分布      —— 撞上限的次数（"达到步数上限"是产出不完整的前兆）
 * ```
 *
 * ⚠️ **`detail` 要按"归一化后的形状"聚合，不能按原文字符串**：
 * 每次失败的消息里带着**不同的数字与符号**（`#2554`、`97.3s`），
 * 按原文分组会让"同一类失败"看起来像 30 种不同的问题 ——
 * 而那正是这个角色要抓的东西。所以先**抹掉数字**再分组。
 */
export function buildHealthFacts(
  runs: readonly {
    outcome: string | null;
    detail: string | null;
    latencyMs: number | null;
    steps: number | null;
  }[],
  traderId: number,
): string {
  const total = runs.length;
  const byOutcome = new Map<string, number>();
  for (const r of runs) {
    const k = r.outcome ?? 'unknown';
    byOutcome.set(k, (byOutcome.get(k) ?? 0) + 1);
  }

  /*
   * 归一化：抹掉数字与引号里的具体值 —— 见函数注释里那段说明。
   */
  const normalize = (s: string): string =>
    s
      .replace(/\d+(\.\d+)?/g, 'N')
      .replace(/[‘’'"][^‘’'"]{0,30}[‘’'"]/g, 'X')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);

  const byReason = new Map<string, { count: number; sample: string }>();
  for (const r of runs) {
    if (!r.detail || r.outcome === 'ok') continue;
    const key = normalize(r.detail);
    const cur = byReason.get(key);
    if (cur) cur.count += 1;
    else byReason.set(key, { count: 1, sample: r.detail.slice(0, 160) });
  }

  const lat = runs
    .map((r) => r.latencyMs ?? 0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const median = lat.length > 0 ? (lat[Math.floor(lat.length / 2)] ?? 0) : 0;
  const max = lat.length > 0 ? (lat[lat.length - 1] ?? 0) : 0;
  const steps = runs.map((r) => r.steps ?? 0);
  const maxSteps = steps.length > 0 ? Math.max(...steps) : 0;

  const lines: string[] = [];
  lines.push(`机器人 #${traderId} 最近 ${total} 次智能体运行的统计（数据来源：agent_runs 表）`);
  lines.push('');
  lines.push('## ① 结果分布（失败率就是"静默失败"的第一判据）');
  for (const [k, v] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${v} 次（${((v / total) * 100).toFixed(0)}%）`);
  }
  lines.push('');
  lines.push('## ② 重复出现的失败原因（同一个原因 N 次 = 系统性问题；1 次 = 可能只是抖动）');
  if (byReason.size === 0) {
    lines.push('  （这段时间没有失败）');
  } else {
    const sorted = [...byReason].sort((a, b) => b[1].count - a[1].count);
    for (const [shape, v] of sorted.slice(0, 8)) {
      lines.push(`  ${v.count} 次 · 形状「${shape}」`);
      lines.push(`        原文样例：${v.sample}`);
    }
  }
  lines.push('');
  lines.push('## ③ 耗时（某个角色比基线慢很多倍 = 可能已经坏了）');
  lines.push(
    `  中位 ${median}ms · 最大 ${max}ms${median > 0 ? ` · 最大是中位的 ${(max / median).toFixed(1)} 倍` : ''}`,
  );
  lines.push('');
  lines.push('## ④ 步数（撞上限 = 产出可能不完整）');
  lines.push(`  最大步数 ${maxSteps}`);
  lines.push('');
  lines.push('## ⚠️ 你【没有】的上下文（如实写在 notChecked 里）');
  lines.push('  · 服务器日志文本（你只能看到这张表的统计，看不到原始日志）');
  lines.push('  · 模型网关/provider 的状态与额度');
  lines.push('  · 调研猎手与交易决策链路的逐条结果');
  return lines.join('\n');
}

export interface AgentRuntimeDeps {
  traderId: number;
  /** 策略里的配置 —— AI 还没写过配置时的基准。 */
  strategyConfig: () => StrategyConfig;
  /**
   * 这个机器人选的策略是不是「全自动智能托管」预设。
   *
   * ⚠️ **这是启动死锁的解药。** 见 `isEnabled()` 的注释。
   */
  isAiStrategy: () => boolean;
  /** 与交易循环同一个模型客户端（`DecisionModel` 的形状正好满足 `LoopModel`）。 */
  model: LoopModel;
  /** 当前权益，用来在唤醒时打基线（判回撤用）。 */
  equityNow: () => number | null;
  /**
   * 某个标的从指定时刻到现在的涨跌幅（百分数）；取不到时 `null`。
   *
   * 由 `TraderManager` 注入（它手上有 `MarketDataService`）—— 这一层不碰网络，
   * 见 `AgentPortDeps.priceChangeSince` 的说明。
   */
  priceChangeSince: (symbol: string, sinceIso: string) => Promise<number | null>;
  policy?: WakePolicy;
}

/**
 * 一次智能体运行时。
 *
 * 生命周期跟随 `AutoTrader` 实例 —— 它自己不持有定时器，
 * 节奏由交易循环决定（这正是"事件驱动"的含义）。
 */
export class AgentRuntime {
  /**
   * 正在进行的那一轮审视。
   *
   * 存在的唯一理由是**防重入**：一次审视要跑几十秒，而周期是 3 分钟 ——
   * 如果它正好跨过两个周期，第二个周期会再触发一次，于是两轮审视
   * **读到同一份数据、各自改一遍参数**，结果取决于谁后写。
   */
  private reviewing: Promise<void> | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {}

  /**
   * 这个机器人是不是 AI 托管模式。
   *
   * ## 两个条件满足任一即为真，而且**缺一不可**
   *
   * 1. `agent_config_json` 非空 —— AI 已经接手（它自己调过参）
   * 2. **策略是「全自动智能托管」预设** —— 用户要求 AI 托管，AI 还没接手
   *
   * ## 为什么必须有第二条（这是一个启动死锁）
   *
   * 我最初只写了第一条。那样会死锁：
   *
   *     isEnabled()            ← 判据是 agent_config_json 非空
   *     agent_config_json 非空  ← 由 set_params 写入
   *     set_params 被调用       ← 需要 AI 在跑
   *     AI 在跑                ← 需要 isEnabled() 为真
   *
   * **一个刚建的 AI 机器人会安静地什么都不做** —— 它看起来在正常运行、
   * 周期照跑、日志干净，**但智能体一次都不会被调用**。这是最难发现的一类缺陷：
   * 没有任何东西报错。
   *
   * 第二条打破死锁：选了那个预设就等于"要求 AI 托管"，哪怕它还没改过任何参数。
   * 之后 AI 第一次调参写入 `agent_config_json`，第一条也开始为真 —— 两条互为补充。
   */
  isEnabled(): boolean {
    const raw = traders.get(this.deps.traderId)?.agentConfigJson;
    if (typeof raw === 'string' && raw.length > 0) return true;
    return this.deps.isAiStrategy();
  }

  /**
   * AI 模式下应当使用的配置；否则返回 null（调用方继续用策略配置）。
   *
   * **这是"AI 下发的参数真的被用上"的唯一出口** —— 没有它，
   * 前面所有模块都只是写了一堆没人读的记录。
   */
  configOverride(): StrategyConfig | null {
    if (!this.isEnabled()) return null;
    /*
     * ⚠️ **不要在这里 `JSON.parse(raw) as StrategyConfig`。**
     *
     * 断言式读取把 schema 校验留在了"写入那一刻"（`patch.ts`），于是将来给
     * `StrategyConfigSchema` 加一个**带默认值的安全字段**时，老配置读出来是
     * `undefined` —— 代码里 `x > 0` 形式的判据会**静默变成 false**，也就是
     * 把那条风控关掉，而且没有任何报错。
     *
     * 共用的 `readAgentConfig` 过 zod 并回落到策略配置。`hasAgentConfig`
     * 单独判一次是为了保住本函数的 `null` 语义：**"AI 还没写过配置"应当返回
     * null 让调用方走策略配置**，而不是把 fallback 伪装成一份"AI 配置"。
     */
    if (!hasAgentConfig(this.deps.traderId)) return null;
    /*
     * 兜底传 `null` 而不是策略配置：本函数的契约是"没有可用的 AI 配置就返回
     * null"，由调用方那句 `?? strategyConfig` 完成回落。配置坏掉时与"没写过"
     * 走同一条路 —— 行为与改动前一致，只是**多了一道 schema 校验**。
     */
    return readAgentConfig(this.deps.traderId, null);
  }

  /**
   * 进周期时问一次"要不要审视"。
   *
   * **不 await**：调用方触发它就走，避免把交易周期撑长。
   * 重入由 `reviewing` 挡住。
   */
  triggerReview(reason: 'cycle' | 'manual' = 'cycle'): void {
    if (!this.isEnabled()) return;
    if (this.reviewing) return;

    this.reviewing = this.runReview(reason)
      .catch((error) => {
        // 纪律 1：绝不抛穿。智能体坏了不该让机器人停止交易。
        log.warn(`机器人 #${this.deps.traderId} 的策略审视失败（不影响交易）：${(error as Error).message}`);
      })
      .finally(() => {
        this.reviewing = null;
      });
  }

  /**
   * 结算等待中的实验。
   *
   * 与审视分开是因为它有**第二个调用点**：每笔平仓入账后最该结算 ——
   * 那一刻刚产生真实结果。结算晚了会让策略师看到过期的历史。
   */
  settleOnly(): void {
    if (!this.isEnabled()) return;
    try {
      const r = settlePending(makeAgentPorts({
        traderId: this.deps.traderId,
        strategyConfig: this.deps.strategyConfig,
        hourlyBudget: (this.deps.policy ?? DEFAULT_WAKE_POLICY).hourlyBudget,
        priceChangeSince: this.deps.priceChangeSince,
      }));
      if (r.settled > 0) {
        log.info(`机器人 #${this.deps.traderId} 结算了 ${r.settled} 条参数实验。`);
      }
    } catch (error) {
      log.warn(`实验结算失败（不影响交易）：${(error as Error).message}`);
    }
  }

  /**
   * 一笔平仓之后请复盘员写因果结论。
   *
   * **不 await**：复盘是附加动作，不该拖慢平仓路径。
   */
  reviewTrade(input: ReviewTradeFacts): void {
    if (!this.isEnabled()) return;
    void (async () => {
      try {
        const recent = agentMemory.forSymbol(this.deps.traderId, input.symbol, 5);

        /*
         * 组装复盘素材。
         *
         * ⚠️ **这几个数字是实测逼出来的。** 最初这里只有「symbol + 平仓原因 + 净额」，
         * 于是复盘员的结论只能是「**数据不足**，无法判定盈亏归因」——
         * 而它列的缺口（持仓时间、浮盈回撤轨迹、成本占比）**全都在手边**。
         *
         * 尤其 `peakPnlPercent`：它是区分
         * 「正常波动的保护性离场」与「止盈过晚导致利润回吐」的唯一依据，
         * 而这两者的改法完全相反 —— 没有它，复盘员只能含糊其辞。
         *
         * **让 AI 说「数据不足」是这一侧的责任。**
         */
        const feeShare = input.grossPnl !== 0 ? (input.fee / Math.abs(input.grossPnl)) * 100 : null;
        const priceMove = ((input.exitPrice - input.entryPrice) / input.entryPrice) * 100;

        /*
         * 回查**入场那一轮的决策记录**，取出这笔的入场理由。
         *
         * 实测复盘员明确指出「缺少入场逻辑、周期与当时的趋势/关键位背景，
         * 无法判定这次止损是设得过紧被正常波动打掉，还是入场方向本就错误」——
         * **而那个理由就在 `decisions[].reasoning` 里，只是没被传过去。**
         *
         * 做法：在开仓时刻**之前**的决策记录里，找最近一条包含这个标的、
         * 且动作是开仓的那一轮。**找不到就明说找不到，不用别的轮次凑** ——
         * 那会让复盘员基于错误的入场理由下结论，比没有理由更糟。
         */
        const entry = (() => {
          try {
            const openedMs = new Date(input.openedAt).getTime();
            if (!Number.isFinite(openedMs)) return { kind: 'missing' as const };
            const candidates = decisionStore
              .list(this.deps.traderId, 200)
              .filter((d) => {
                const t = new Date(d.timestamp).getTime();
                return Number.isFinite(t) && t <= openedMs + 1000;
              })
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            for (const rec of candidates) {
              const hit = rec.decisions.find(
                (dec) => dec.symbol === input.symbol && /^(open_long|open_short)$/.test(dec.action),
              );
              if (hit) {
                return {
                  kind: 'found' as const,
                  cycle: rec.cycleNumber,
                  action: hit.action,
                  confidence: hit.confidence,
                  reasoning: hit.reasoning,
                  adjustments: hit.adjustments,
                };
              }
            }
            return { kind: 'missing' as const };
          } catch {
            return { kind: 'failed' as const };
          }
        })();

        const lines = [
          `标的：${input.symbol}`,
          `方向与价位：开仓 ${input.entryPrice} → 平仓 ${input.exitPrice}（价格变动 ${priceMove.toFixed(3)}%）`,
          `毛盈亏 ${input.grossPnl.toFixed(4)}　手续费 ${input.fee.toFixed(4)}　净盈亏 ${input.netPnl.toFixed(4)}`,
          feeShare === null
            ? '成本占比：毛盈亏为 0，无法计算占比。'
            : `成本占比：手续费占毛盈亏绝对值的 ${feeShare.toFixed(1)}%` +
              (feeShare >= 50 ? ' —— **成本吃掉了大部分毛收益**，这笔交易在扣费前就已经很薄。' : ''),
          `持仓时长：${input.holdMinutes.toFixed(1)} 分钟（${input.openedAt} 开仓）`,
          /*
           * ⚠️ **必须走 `closeReasonLabel`，不能直接印机器码。**
           *
           * `close_reason: 'stop_loss'` 配上「平仓价高于开仓价」在复盘员眼里
           * 就是**自相矛盾的数据** —— 而它已经这么说过至少三次（都写进了记忆）：
           *
           *     ETHUSDT  「平仓价 2789.5 高于开仓价 2762.21 却标记为 stop_loss…
           *               推测为移动止损上移触发…但数据不足以确认」
           *     BNBUSDT  「平仓价高于开仓价却标记 stop_loss，离场机制数据不足，
           *               无法确认是移动止损保护还是止盈管理失误」
           *
           * **而真相是确定的**：那些止损位被保本守卫/`adjust_protection`
           * 上移到了成本价之上，触发的结果就是保本或小赚离场 ——
           * 这正是提示词要求它做的事。`closeReasonLabel` 就是为这件事写的
           * （它把「止损触发 + 盈利」说成「移动止损（保本离场）」），
           * 而且 `prompt.ts` 早就用上了。
           *
           * 只有这里一直印机器码，于是同一个困惑从操作员身上搬到了复盘员身上。
           */
          `平仓原因：${closeReasonLabel(input.closeReason, input.netPnl)}`,
          /*
           * ⚠️ **开仓时计划的保护位 —— 必须有，否则复盘员只能去历史里猜。**
           *
           * `#104`（WLDUSDT）的复盘写的是：
           *
           *   「记录的开仓止损应为 0.5440，实际平仓价却是 0.5516，两者相差约 1.2%，
           *     说明实际止损位被收紧/挂错……**本次亏损无法区分是『趋势判断错』
           *     还是『止损设置/执行错』**。」
           *
           * 而它引用的 `0.544` 是**同一标的上一笔**（`#275`）的止损，本笔是 `0.552`
           * （决策、挂单触发价、成交滑点三者一致，没有挂错）——**它把两笔混了**，
           * 因为以前这几项事实里**根本没有"计划的止损"**。
           *
           * 这行把两个数字并排给出，它就能自己判断"是被正常回踩扫出"还是"挂错了"。
           * 两个价位都用**价格口径**，与上面那行的"价格变动"一致；
           * 而"对保证金的口径"只在浮盈轨迹那一行出现，别混。
           */
          `计划保护位：止损 ${input.stopLoss ?? '（未设置）'}、止盈 ${input.takeProfit ?? '（未设置）'}` +
            `（价格口径。对比它们与入场价/平仓价即可判断这次离场是"按计划被打掉"还是"保护位挂错了" —— ` +
            '不要再从同标的的历史记忆里找止损价，那是**别的交易**的值）',
          /*
           * 浮盈轨迹这一行刻意写成"峰值 vs 最终"，因为复盘员要判断的正是
           * "曾经赚到多少、又还回去多少"。
           *
           * ⚠️ **口径必须写出来，而且必须和上一行的「价格变动」区分开。**
           *
           * 上面那行是**价格**口径（`(exit-entry)/entry`，不含杠杆），
           * 这一行是**对保证金**的口径（含杠杆）。两行紧挨着、数字长得一样，
           * 而它差一个杠杆倍数 —— 实测就是这么被读错的：
           * `#95`（XRPUSDT 5x）记下 3.146%，模型拿它当价格涨幅去反算目标价，
           * 得到 1.5606（真实最高 1.5318），于是判定一张**从未被触及**的
           * 止盈单"应该兑现却没兑现"，并据此去改离场逻辑。
           *
           * 所以这里同时给两个口径，并明说"不要把它当价格"。
           */
          `浮盈轨迹：持仓期间最大浮盈 ${input.peakPnlPercent.toFixed(3)}%` +
            `（**对保证金的口径，含 ${input.leverage}x 杠杆 —— 折合价格约 ${marginPercentToPricePercent(input.peakPnlPercent, input.leverage).toFixed(3)}%**；` +
            '上一行的「价格变动」是价格口径，两个数不是一个东西，别拿这个去和止盈/止损价比较）' +
            (input.peakPnlPercent > 0 && input.netPnl <= 0
              ? ' —— **曾经浮盈但最终没赚到，这是"止盈/移动止损是否设晚"的直接证据。**'
              : ''),
          /*
           * 入场理由是复盘员区分「止损太紧」与「方向就错」的唯一依据，
           * 而这两种结论对应的改法完全相反。**三种状态要分清**：
           * 查到了 / 查不到（记录已轮转）/ 查出错（不是"当时没有理由"）。
           */
          entry.kind === 'found'
            ? `入场理由（第 #${entry.cycle} 轮，动作 ${entry.action}，置信度 ${entry.confidence}）：` +
              `${entry.reasoning}` +
              (entry.adjustments.length > 0
                ? `\n  风控当时记下的调整：${entry.adjustments.join('；')}`
                : '')
            : entry.kind === 'failed'
              ? '入场理由：**回查决策记录时出错**（这不等于"当时没有理由"，别据此判断）。'
              : input.closeReason === 'external'
                ? /*
                   * ⚠️ **外部平仓本来就没有我们的入场理由。**
                   *
                   * 这个仓位不是本平台开的（操作员手工下的、或别的程序下的），
                   * 所以找不到那一轮的决策记录是**正确的结果**，不是数据缺失。
                   *
                   * 原来这里一律说"可能已被轮转清理"，把复盘员引去怀疑一个不存在的
                   * 问题 —— 实测记忆 #24 就是这么写的：
                   *   「…**但入场理由缺失，无法判断是方向本就错、还是止损/出场过紧。**」
                   * 这是在一个"外部平仓"上追一个永远不会有的东西。
                   */
                  '入场理由：**这个仓位不是本平台开的**（外部交易 / 手工下单），' +
                  '所以本来就没有我们的入场理由 —— 这不是数据缺失，别据此认为记录丢了。'
                : '入场理由：**查不到对应那一轮的决策记录**（可能已被轮转清理）。' +
                  '缺少入场理由时无法区分"止损设得过紧"与"入场方向本就错误" —— 请以此为限下结论。',
        ];

        const facts =
          lines.join('\n') +
          '\n' +
          (recent.length > 0
            ? `\n这个标的历史上的记录：\n${recent.map((m) => `- ${m.lesson}`).join('\n')}`
            : '\n这个标的历史上没有记录。');

        const r = await reviewClosedTrade({
          model: this.deps.model,
          trade: input,
          facts,
          save: (m) => {
            agentMemory.insert({
              traderId: this.deps.traderId,
              tradeId: input.tradeId,
              symbol: m.symbol,
              closeReason: m.closeReason,
              netPnl: m.netPnl,
              lesson: m.lesson,
              tags: m.tags,
            });
          },
        });
        if (r.ok) log.info(`机器人 #${this.deps.traderId} 复盘 ${input.symbol}：${r.lesson}`);
      } catch (error) {
        log.warn(`复盘失败（不影响交易）：${(error as Error).message}`);
      }
    })();
  }

  /* ---------------------------------------------------------------------- */

  private async runReview(reason: 'cycle' | 'manual'): Promise<void> {
    const ports = makeAgentPorts({
      traderId: this.deps.traderId,
      strategyConfig: this.deps.strategyConfig,
      hourlyBudget: (this.deps.policy ?? DEFAULT_WAKE_POLICY).hourlyBudget,
      priceChangeSince: this.deps.priceChangeSince,
    });

    const outcome = await runStrategyReview({
      ports,
      model: this.deps.model,
      policy: this.deps.policy ?? DEFAULT_WAKE_POLICY,
      force: reason === 'manual',
    });

    if (!outcome.ran) {
      // 没醒是常态（冷却、预算、没有值得醒的事）—— 用 debug 级别，
      // 免得日志被"这一轮为什么没醒"刷满。
      log.debug(`机器人 #${this.deps.traderId} 本轮未审视：${outcome.skippedBecause}`);
      return;
    }
    /*
     * ⚠️ 顺序要紧：**先落"醒过"的时间，再打权益基线**。
     *
     * 这两个状态是冷却与回撤判据的依据。落晚了的话，如果审视过程很慢，
     * 下一轮的 `minutesSinceLastWake` 会算大，可能立刻又醒一次 —— 那就是抖动。
     */
    markWoken(this.deps.traderId, this.deps.equityNow());
    markStrategyReview(this.deps.traderId);

    log.info(
      `机器人 #${this.deps.traderId} 完成策略审视（触发 ${outcome.trigger} / ${outcome.intensity}）：` +
        `${outcome.loop?.outcome}，${outcome.loop?.steps.length ?? 0} 步`,
    );

    /*
     * ⚠️ **不 `await` 体检** —— 它是附加动作，不该把交易周期撑长。
     * 与 `runReview` 里那条纪律一致（见文件头 §2）。
     */
    void this.runHealthCheck();
  }

  /**
   * **系统体检**（工程师角色）—— 周期性指出"哪里在坏"。
   *
   * ## 为什么需要它（用户需求 ⑤ 点名要有"维护系统的程序员"）
   *
   * 用户的判断：
   * > 「这次更新你得搞智能体团队**持续观察、测试**…**不要老让我来测试和发现问题**」
   *
   * 而实测证明**系统会以"看不出异常"的方式坏掉**（本项目已抓到三次）：
   * ```
   *   调研 4 个猎手全部 4 秒失败 → 看起来像"那边没有新闻"
   *   策略师全部 outcome=failed  → 看起来像"策略师在跑"
   *   决策数组被输出预算截断     → 看起来像"模型决定观望"
   * ```
   * 三种都**没有任何东西报错**。
   *
   * ## 数据来源：`agent_runs`（每次审视一行轨迹）
   *
   * 它里面有 `outcome`（ok/degraded/failed）与 `latency_ms` ——
   * **这正是"失败率"与"耗时异常"的原始数据**。
   * 让工程师自己去看日志文本是没用的（它拿不到服务器日志），
   * 但把这张表的结构化摘要给它，它就能回答"哪个角色在系统性失败"。
   *
   * ## ⚠️ 它只能报告，不能修（`roles.ts` 里那条刻意的边界）
   *
   * 一个能自己改代码的智能体在交易系统里是**不可审计的**。
   * 它的价值在于把"看不出异常的失败"变成"一条写清楚的告警"。
   */
  private async runHealthCheck(): Promise<void> {
    try {
      /* 最近 30 次运行 —— 足够看出"系统性失败"而不是"一次抖动"。 */
      const runs = agentRuns.recent(this.deps.traderId, 30);
      if (runs.length === 0) return;

      const facts = buildHealthFacts(runs, this.deps.traderId);
      const r = await runHealthCheck({
        model: this.deps.model,
        facts,
      });

      if (r.ok) {
        /*
         * ⚠️ 用 `warn` 而不是 `info`：这条日志的唯一价值就是**被人看见**。
         * `degraded` / `broken` 必须与正常的 `healthy` 在日志里区分开。
         */
        const line = `机器人 #${this.deps.traderId} 系统体检：${r.summary}`;
        if (r.health === 'healthy') log.info(line);
        else log.warn(line);
        for (const f of r.findings.slice(0, 3)) {
          const o = f as Record<string, unknown>;
          if (typeof o.what === 'string') {
            log.warn(`  体检发现：${o.what}（证据：${String(o.evidence ?? '').slice(0, 120)}）`);
          }
        }
      } else {
        /* 体检失败不抛穿 —— 它是附加能力（见文件头 §1）。 */
        log.debug(`机器人 #${this.deps.traderId} 体检未完成：${r.error ?? '未知'}`);
      }
    } catch (error) {
      log.debug(`机器人 #${this.deps.traderId} 体检失败（不影响交易）：${(error as Error).message}`);
    }
  }
}
