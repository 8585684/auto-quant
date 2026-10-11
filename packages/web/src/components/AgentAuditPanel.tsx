/**
 * **智能体审计面板** —— 让操作员看到"团队到底做了什么、学到了什么"。
 *
 * ## 用户的要求（2026-10-12）
 *
 * > 「我理想中这次更新以后的效果：开启以后，整个智能体团队就开始并发工作，有主管、
 * >  分析账户的、有调查新闻的、有监控社区的、有查市场情绪的、有维护系统的程序员、
 * >  **有汇报工作的**、有文员、有交易员、有风控员等等」
 * >
 * > 「团队模式下，决策看板应该很大区别于前两种了，看板应该直观显示有哪些智能体，
 * >  都是什么分工，都在做什么，**时间、决策**，等等一切你觉得有必要的显示在上面」
 *
 * 这个面板就是那个「**汇报工作的**」—— 它把三张此前**前端完全不可见**的表
 *（`agent_runs` / `agent_experiments` / `agent_memory`）呈现出来。
 *
 * ## 为什么这三张表重要
 *
 * | 表 | 回答的问题 |
 * |---|---|
 * | `agent_runs` | **谁跑了、跑了多久、花了多少 token** —— 成本与活跃度 |
 * | `agent_experiments` | **改了什么参数、真实结果如何** —— "自我迭代"的审计线索 |
 * | `agent_memory` | **从每笔平仓里学到了什么** —— 它有没有在变聪明 |
 *
 * 三张表缺一张，操作员就只能看到"它在跑"，看不到"它在学"。
 *
 * ## 为什么对非团队模式也显示
 *
 * 这三张表是 `ai_managed` 模式就有的（AI 自己调参 + 复盘）。
 * 所以面板**不按模式隐藏** —— 只有"有没有数据"决定显示什么。
 * 团队模式会往 `agent_runs` 里写更多（每个角色一条），于是内容更丰富。
 */

import { useState } from 'react';

import { api, type AgentAudit } from '../lib/api';
import { usePolled } from '../lib/hooks';
import { Panel } from './ui';

/** 把 ISO 时刻显示成 `MM-DD HH:MM`。 */
function stamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 大数字可读化（token 常常是六位数）。 */
function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 秒数可读化。 */
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}分`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}秒`;
  return `${Math.round(ms)}毫秒`;
}

/** 一张小表。 */
function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className="text-base font-medium text-ink-hi">{title}</span>
        <span className="num text-xs text-ink-faint">{count}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{hint}</span>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/**
 * 审计面板。
 *
 * ⚠️ **没有数据时显示一句"还没有"，而不是一个空壳** ——
 * 空表会让操作员以为"功能坏了"，而真相是"这个机器人还没跑过"。
 */
export function AgentAuditPanel({ traderId }: { traderId: number }): React.ReactElement {
  const query = usePolled((signal) => api.traderAgentAudit(traderId, 20, signal), { intervalMs: 30_000 });
  const data: AgentAudit | null | undefined = query.data;

  const runs = data?.runs ?? [];
  const experiments = data?.experiments ?? [];
  const memory = data?.memory ?? [];
  const total = runs.length + experiments.length + memory.length;

  return (
    <Panel title="智能体审计">
      <p className="mb-2 px-3 pt-3 text-xs text-ink-faint">
        团队做过什么、改了什么、学到了什么 —— 这三张表此前在界面上完全看不到。
      </p>
      {query.loading && data === undefined ? (
        <div className="px-3 py-3 text-base text-ink-faint">正在读取…</div>
      ) : total === 0 ? (
        <div className="px-3 py-3 text-base text-ink-faint">
          还没有审计记录。机器人跑过一轮、或 AI 调整过一次参数之后，这里就会有内容。
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line">
          <Section title="运行轨迹" hint="谁跑了、多久、花了多少 token" count={runs.length}>
            {runs.length === 0 ? (
              <p className="text-xs text-ink-faint">还没有运行记录。</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="py-1 font-normal">时刻</th>
                    <th className="py-1 font-normal">类型</th>
                    <th className="py-1 font-normal">触发</th>
                    <th className="py-1 font-normal">结果</th>
                    <th className="py-1 text-right font-normal">token</th>
                    <th className="py-1 text-right font-normal">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-line/40">
                      <td className="num py-1 whitespace-nowrap text-ink-faint">{stamp(r.createdAt)}</td>
                      <td className="py-1 text-ink-soft">{r.kind}</td>
                      <td className="py-1 text-ink-soft">{r.trigger}</td>
                      <td className={`py-1 ${r.outcome === 'ok' ? 'text-ok' : 'text-warn'}`} title={r.detail}>
                        {r.outcome}
                      </td>
                      <td className="num py-1 text-right text-ink-faint">
                        {fmtTokens(r.tokensIn)}/{fmtTokens(r.tokensOut)}
                      </td>
                      <td className="num py-1 text-right text-ink-faint">{fmtMs(r.latencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title="参数实验"
            hint="AI 改了什么 + 真实结果（自我迭代的线索）"
            count={experiments.length}
          >
            {experiments.length === 0 ? (
              <p className="text-xs text-ink-faint">还没有参数实验记录。</p>
            ) : (
              <ul className="space-y-2">
                {experiments.map((e) => (
                  <li key={e.id} className="rounded border border-line/50 px-2 py-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                      <span className="num text-ink-faint">{stamp(e.createdAt)}</span>
                      <span className="text-ink-soft">{e.trigger}</span>
                      {/*
                        结果**必须区分"还没结算"与"结算了是 0"** ——
                        `outcomeTrades` 为 null 是"等结果中"，而 0 是"结果就是没交易"。
                        混在一起会让操作员以为"这个实验没效果"。
                      */}
                      {e.outcomeTrades === null ? (
                        <span className="text-ink-faint">等结果中</span>
                      ) : (
                        <span className={e.outcomeNetPnl !== null && e.outcomeNetPnl >= 0 ? 'text-ok' : 'text-danger'}>
                          {e.outcomeTrades} 笔 · 净 {e.outcomeNetPnl?.toFixed(2) ?? '—'}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-soft">{e.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="教训记忆" hint="从每笔平仓里学到了什么" count={memory.length}>
            {memory.length === 0 ? (
              <p className="text-xs text-ink-faint">还没有教训记录（每笔平仓后会写一条）。</p>
            ) : (
              <ul className="space-y-1.5">
                {memory.map((m) => (
                  <li key={m.id} className="flex gap-2 text-xs">
                    <span className="num w-20 shrink-0 text-ink-faint">{stamp(m.createdAt)}</span>
                    <span className="w-24 shrink-0 truncate font-medium text-ink-soft" title={m.symbol}>
                      {m.symbol}
                    </span>
                    <span className={m.netPnl >= 0 ? 'num w-16 shrink-0 text-ok' : 'num w-16 shrink-0 text-danger'}>
                      {m.netPnl >= 0 ? '+' : ''}
                      {m.netPnl.toFixed(2)}
                    </span>
                    <span className="min-w-0 flex-1 text-ink-lo">{m.lesson}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </Panel>
  );
}
