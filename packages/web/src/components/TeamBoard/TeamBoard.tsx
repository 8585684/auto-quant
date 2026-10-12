/**
 * **AI 工作流看板** —— 团队模式（`ai_team`）决策区的**固定头部**。
 *
 * ## 用户的要求（2026-10-12，逐条）
 *
 * > 「UI 丑陋，不直观，用户无法看清楚 AI 运行状态，界面丑陋抽象，**有英文**，
 * >  还有不合理不人性化，感觉不是给人看的」
 *
 * > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**等关键信息」
 *
 * > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以手动点击打开查看详情」
 *
 * ## 这一版与旧 `TeamRoster` 的差别（不是"美化"，是形态不同）
 *
 * | 维度 | 旧 `TeamRoster` | **本组件** |
 * |---|---|---|
 * | 配色 | 用了一批**不存在的 Tailwind 类**（`border-line` / `bg-surface-2` / `bg-ok`…）→ 渲染出来没有边框没有底色，状态灯没有颜色 | 只用 `tailwind.config.js` 里**真实存在**的令牌，逐条核对过 |
 * | 组织 | 一张 8 行的大表，**只列本轮参与过的角色** | 按**部门**分组（管理/研究/风控/执行/技术），**在岗/规划中全列出** |
 * | 状态 | 圆点只有颜色，且颜色失效 → 看不出在干什么 | 圆点 + **中文状态词**（进行中/已完成/失败/在岗/规划中），色盲也能读 |
 * | 摘要 | 只显示"最近动作"，看不出这个岗位**该干什么** | 分工 + 最近产出摘要**同时在场** |
 * | 时长 | 有 | 有（沿用），另加**阶段进度**（派发→分析→辩论→裁决→风控） |
 * | 详情 | 没有入口 | **每个岗位可点开**看它的完整步骤；另有一键展开全部 |
 *
 * ## 为什么按"部门"分组而不是平铺一张表
 *
 * 用户要的是「**有哪些智能体，都是什么分工**」。一家量化机构的分工是**有结构**的
 * （研究出材料 → 风控把关 → 执行落地），平铺成一张表就看不出这条链。
 * 部门顺序来自 `DEPARTMENT_ORDER`（与 `FIRM_ROLES` 同源），和用户脑子里的
 * 组织图一致：管理在最上面，那是决策链的起点。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEPARTMENT_ORDER, FIRM_ROLES, type FirmRole } from '@aq/shared';

import {
  PHASE_LABEL,
  STATE_HINT,
  STATE_LABEL,
  TIER_LABEL,
  clock,
  rosterEntries,
  type RosterEntry,
  type RosterState,
  type TeamStep,
} from './roster';

/** 从状态得到圆点的样式（全部是真实存在的类，见 `roster.ts` 的对照表）。 */
const DOT_CLASS: Record<RosterState, string> = {
  active: 'bg-accent animate-pulse-soft',
  done: 'bg-up',
  failed: 'bg-down',
  idle: 'border border-ink-faint',
  planned: 'bg-ink-faint/40',
};

/** 从状态得到文字颜色。 */
const STATE_TEXT_CLASS: Record<RosterState, string> = {
  active: 'text-accent',
  done: 'text-up',
  failed: 'text-down',
  idle: 'text-ink-lo',
  planned: 'text-ink-faint',
};

/**
 * 阶段的展示顺序 —— 与 `tradingDesk.ts` 的编排一致。
 *
 * 用它画一条**进度轨**：操作员一眼看出"这一轮走到哪一步了"，
 * 而不是自己去读七行日志推断。
 */
const PHASE_FLOW: readonly string[] = ['dispatch', 'analysis', 'debate', 'verdict', 'risk'];

/**
 * 已用时。`8 秒` / `1 分 12 秒`。
 *
 * 不用 `fmtDuration`（它入参是**分钟**）：团队一轮可以跑几秒到几分钟，
 * 用分钟为单位会把 8 秒显示成 `0.1 分钟`，正好丢掉这个读数唯一的价值。
 */
function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * **工作流看板**。
 *
 * @param steps 本轮的实时步骤流（`LiveCycle.steps`）
 * @param cycleNumber 本轮编号
 * @param startedAt 本轮开始时刻（epoch ms），用于算"已用时"
 * @param roster 编制表（默认 `FIRM_ROLES`；注入是为了可测）
 */
export function TeamBoard({
  steps,
  cycleNumber,
  startedAt,
  roster = FIRM_ROLES,
}: {
  steps: readonly TeamStep[];
  cycleNumber: number;
  /** `null` = 不知道开始时刻（例如页面刚连上），此时不显示计时器。 */
  startedAt: number | null;
  roster?: readonly FirmRole[];
}): React.ReactElement {
  /*
   * 计时器每秒刷新 —— 让"这一轮跑了多久"是活的。
   *
   * ⚠️ **`startedAt` 为 `null` 时不挂计时器**：拿不到开始时刻却每秒跳一个数，
   * 那个数是编的（`Date.now() - 0`），而"跑了 50000 秒"会让操作员去查一个
   * 不存在的事故。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const entries = useMemo(() => rosterEntries(steps, roster), [steps, roster]);

  /** 一键"展开全部详情" —— 用户说"用户有需要可以手动点击打开查看详情"。 */
  const [allOpen, setAllOpen] = useState(false);
  /** 单独展开的岗位（与 `allOpen` 取并集，这样"展开全部"之后再单点收起是可行的）。 */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());

  const isOpen = (id: string): boolean => (allOpen && !closed.has(id)) || (!allOpen && closed.has(id));

  /**
   * 本轮的**进度**：走到哪个阶段了。
   *
   * 判据是"这个阶段有没有出现过步骤" —— 服务端没有推"阶段完成"事件，
   * 所以只能说"到过这里"。把"到过"说成"完成"就是在编造。
   */
  const seenPhases = useMemo(() => {
    const set = new Set<string>();
    for (const s of steps) if (s.phase) set.add(s.phase);
    return set;
  }, [steps]);

  const byDept = useMemo(() => {
    const map = new Map<string, RosterEntry[]>();
    for (const dept of DEPARTMENT_ORDER) map.set(dept, []);
    for (const entry of entries) {
      const bucket = map.get(entry.role.department);
      if (bucket) bucket.push(entry);
      else map.set(entry.role.department, [entry]);
    }
    return [...map.entries()].filter(([, list]) => list.length > 0);
  }, [entries]);

  const working = entries.filter((e) => e.state === 'active' || e.state === 'done').length;
  const failed = entries.filter((e) => e.state === 'failed').length;
  const idleStaffed = entries.filter((e) => e.state === 'idle').length;
  const planned = entries.filter((e) => e.state === 'planned').length;

  const elapsedSec =
    startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <section
      aria-label="AI 工作流"
      className="overflow-hidden rounded-lg border border-base-700 bg-base-900 shadow-panel"
    >
      {/* ── 头：这一轮是谁、跑了多久、走到哪一步 ───────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-base-750 bg-base-850 px-3 py-2">
        <span className="flex items-center gap-1.5 text-base font-semibold text-ink-hi">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
          AI 工作流
        </span>
        <span className="num text-xs text-ink-lo">第 {cycleNumber} 轮</span>

        {/*
          进度轨：走到过哪些阶段。
          `text-ink-hi` 表示"到过"，`text-ink-faint` 表示"还没到" ——
          用颜色之外还有**箭头方向**表达顺序，不依赖颜色。
        */}
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs" aria-label="本轮编排进度">
          {PHASE_FLOW.map((phase, index) => {
            const seen = seenPhases.has(phase);
            return (
              <li key={phase} className="flex items-center gap-1">
                {index > 0 && (
                  <span aria-hidden className="text-ink-faint">
                    →
                  </span>
                )}
                <span className={seen ? 'text-ink-hi' : 'text-ink-faint'}>{PHASE_LABEL[phase] ?? phase}</span>
              </li>
            );
          })}
        </ol>

        {/* 三个计数把"团队现在什么状况"压成一句话。 */}
        <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs">
          <span className="text-up">本轮在干 {working}</span>
          {failed > 0 && <span className="text-down">失败 {failed}</span>}
          <span className="text-ink-lo">在岗未叫 {idleStaffed}</span>
          <span className="text-ink-faint">规划中 {planned}</span>
        </span>

        {elapsedSec !== null && (
          <span
            className={`num text-xs tabular-nums ${elapsedSec >= 120 ? 'text-warn' : 'text-ink-lo'}`}
            title="本轮从开始到现在的时长。团队模式一轮可以是几秒，也可以是几分钟 —— 调研型角色要联网查资料。"
          >
            已跑 {elapsedLabel(elapsedSec)}
          </span>
        )}

        {/*
          「展开全部」而不是"每个岗位各点一次"：用户说"有需要可以手动点击打开查看详情"，
          而"想知道这一轮到底每一步都做了什么"是一个**整体**的需求。
        */}
        <button
          type="button"
          onClick={() => {
            setAllOpen((v) => !v);
            setClosed(new Set());
          }}
          aria-expanded={allOpen}
          className="rounded px-1.5 py-0.5 text-xs text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
        >
          {allOpen ? '收起全部详情' : '展开全部详情'}
        </button>
      </header>

      {/* ── 编制表：按部门分组 ─────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <p className="px-3 py-4 text-xs text-ink-faint">团队正在组建 —— 还没有任何岗位登记。</p>
      ) : (
        <div className="space-y-2 p-2.5">
          {byDept.map(([dept, list]) => (
            <div key={dept} className="overflow-hidden rounded-md border border-base-750">
              <div className="flex items-center gap-2 border-b border-base-750 bg-base-850 px-2.5 py-1">
                <span className="text-xs font-semibold text-ink-mid">{dept}</span>
                <span className="num text-[11px] text-ink-faint">{list.length} 个岗位</span>
              </div>
              <ul className="divide-y divide-base-800">
                {list.map((entry) => (
                  <li key={entry.role.id}>
                    <AgentRow
                      entry={entry}
                      open={isOpen(entry.role.id)}
                      onToggle={() =>
                        setClosed((prev) => {
                          const next = new Set(prev);
                          if (next.has(entry.role.id)) next.delete(entry.role.id);
                          else next.add(entry.role.id);
                          return next;
                        })
                      }
                      steps={steps.filter((s) => s.role === entry.role.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 一个岗位一行（可展开）。
 *
 * ## 折叠态回答的三个问题
 *
 * 1. **它在不在干活** → 状态圆点 + 中文状态词
 * 2. **它是干什么的** → 分工（`duty`）
 * 3. **它刚做出了什么** → 最近产出摘要 + 时刻
 *
 * 三样都在**一行之内**，因为用户原话是「固定展示各智能体工作状态和摘要」——
 * 需要点开才知道"它在不在干活"就等于没做到。
 */
function AgentRow({
  entry,
  open,
  onToggle,
  steps,
}: {
  entry: RosterEntry;
  open: boolean;
  onToggle: () => void;
  steps: readonly TeamStep[];
}): React.ReactElement {
  const { role, state, latest, stepCount } = entry;
  const expandable = stepCount > 0;

  const body = (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-base font-medium text-ink-hi">{role.label}</span>
      {/*
        ⚠️ **状态用文字写出来，不能只靠圆点颜色**（`DESIGN.md` §2，也是色盲用户的前提）。
        旧版只有一个圆点，而那个圆点的颜色类名根本不存在 —— 于是它连颜色都没有。
      */}
      <span className={`text-xs font-medium ${STATE_TEXT_CLASS[state]}`} title={STATE_HINT[state]}>
        {STATE_LABEL[state]}
      </span>
      <span className="text-[11px] text-ink-faint" title="这个岗位的思考深度档位（越深越贵、越影响结论）">
        {TIER_LABEL[role.tier]}
      </span>
      {stepCount > 1 && <span className="num text-[11px] text-ink-faint">{stepCount} 步</span>}
      <span className="min-w-0 flex-1 truncate text-xs text-ink-lo" title={role.duty}>
        {role.duty}
      </span>
      {latest !== null ? (
        <>
          <span className="min-w-0 max-w-full flex-1 truncate text-xs text-ink-mid" title={latest.message}>
            {latest.phase !== null && PHASE_LABEL[latest.phase] !== undefined && (
              <span className="mr-1 rounded bg-base-800 px-1 text-[11px] text-ink-lo">
                {PHASE_LABEL[latest.phase]}
              </span>
            )}
            {latest.message}
          </span>
          <span className="num shrink-0 text-[11px] tabular-nums text-ink-faint">{clock(latest.at)}</span>
        </>
      ) : (
        <span className="shrink-0 text-xs text-ink-faint">本轮未参与</span>
      )}
    </div>
  );

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        {/* 展开箭头：**只有真的有步骤可看时才可点** —— 空按钮比没有按钮更让人困惑。 */}
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            title={open ? '收起这个岗位的步骤' : '展开这个岗位这一轮的每一步'}
            className="shrink-0 rounded p-0.5 text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
          >
            {open ? (
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight aria-hidden className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span aria-hidden className="w-4.5 shrink-0" style={{ width: '1.125rem' }} />
        )}

        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full self-start ${DOT_CLASS[state]}`}
        />
        {body}
      </div>

      {open && steps.length > 0 && (
        <ol className="space-y-1 border-t border-base-750 bg-base-850/40 px-2.5 py-2 pl-8">
          {steps.map((s, index) => (
            <li key={`${s.at}-${index}`} className="flex min-w-0 items-start gap-2 text-xs">
              <span className="num shrink-0 tabular-nums text-ink-faint">{clock(s.at)}</span>
              <span
                className={
                  s.level === 'error' ? 'text-down' : s.level === 'warn' ? 'text-warn' : 'text-ink-mid'
                }
              >
                {s.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
