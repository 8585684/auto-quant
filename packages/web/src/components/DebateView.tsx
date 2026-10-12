/**
 * **辩论视图** —— 多头 vs 空头的对抗论证 + 裁决。
 *
 * ## 用户的要求（2026-10-12）
 *
 * > 「团队模式下，**决策看板应该很大区别于前两种了**，看板应该直观显示
 * >  有哪些智能体，都是什么分工，都在做什么，**时间、决策**，
 * >  等等一切你觉得有必要的显示在上面」
 *
 * > 「有歧义的决策、新闻什么的总管还会安排不同人**开会讨论**」
 *
 * ## 为什么"辩论"要单独一块视图（而不是混在角色列表里）
 *
 * 调研有硬证据说明**辩论是这个架构里最该被看住的一环**：
 *
 *   · 🟢 谄媚（sycophancy）会让辩论的准确率**低于**单智能体基线
 *     （arXiv:2509.23055）—— 也就是"两边说着说着就附和了"；
 *   · 🟢 agent 是**低方差**的，**一个 agent 犯错时很可能许多 agent 都错**。
 *
 * 所以操作员最需要看的是：**多空两边的论证是不是真的对立**、
 * **裁决有没有给出理由**、**有没有"不行动"这个合法结论**。
 *
 * 混在角色列表里时，这三件事都看不出来（列表只显示"已完成"）。
 *
 * ## 数据来源：已落库的 `<team>` 块
 *
 * 与团队审计块同一个来源（见 `lib/teamTrace.ts`）—— **不需要新增数据库列**。
 */

import { useState } from 'react';

import type { TeamMemberOutput } from '../lib/teamTrace';

/** 把角色 id 映射成界面上的中文标签（与 `TeamRoster` 同一套口径）。 */
const ROLE_LABEL: Record<string, string> = {
  bull: '多头研究员',
  bear: '空头研究员',
  judge: '裁决官',
};

/**
 * **辩论视图**。
 *
 * @param members 各角色产出（来自 `parseTeamTrace`）
 */
export function DebateView({ members }: { members: readonly TeamMemberOutput[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const bull = members.find((m) => m.role === 'bull');
  const bear = members.find((m) => m.role === 'bear');
  const judge = members.find((m) => m.role === 'judge');

  /* 三项都没有 → 不是一轮团队辩论（普通模式），不渲染。 */
  if (bull === undefined && bear === undefined && judge === undefined) return null;

  /*
   * 折叠态只显示"有没有真的对立"这一个判断 ——
   * 那是操作员扫视时唯一需要一眼看出的东西（见文件头引用的谄媚风险）。
   */
  const bothPresent = bull !== undefined && bear !== undefined;

  return (
    <div className="mt-1 overflow-hidden rounded-md border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-left"
      >
        <span className="shrink-0 text-xs font-medium text-ink-hi">多空辩论</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          {bothPresent
            ? `${bull.modelId ?? '?'} vs ${bear.modelId ?? '?'}`
            : bothPresent
              ? ''
              : '⚠️ 只有一方论证 —— 可能是某一侧调用失败'}
        </span>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="grid grid-cols-1 gap-2 p-2.5 md:grid-cols-3">
          {/* 多头 */}
          <DebateColumn
            title="多头研究员"
            accent="text-ok"
            model={bull?.modelId ?? null}
            text={bull?.text ?? null}
            emptyHint="这一轮没有多头论证（可能调用失败）"
          />
          {/* 空头 */}
          <DebateColumn
            title="空头研究员"
            accent="text-danger"
            model={bear?.modelId ?? null}
            text={bear?.text ?? null}
            emptyHint="这一轮没有空头论证（可能调用失败）"
          />
          {/* 裁决 —— 单独一列，因为它是**唯一有权下结论的那个** */}
          <DebateColumn
            title="裁决官（唯一结论）"
            accent="text-accent"
            model={judge?.modelId ?? null}
            text={judge?.text ?? null}
            emptyHint="这一轮没有裁决（预算耗尽或调用失败）"
          />
        </div>
      )}
    </div>
  );
}

/** 辩论的一列。 */
function DebateColumn({
  title,
  accent,
  model,
  text,
  emptyHint,
}: {
  title: string;
  accent: string;
  model: string | null;
  text: string | null;
  emptyHint: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded border border-line/60 bg-surface-1 p-2">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className={`text-xs font-medium ${accent}`}>{title}</span>
        {model !== null && model.length > 0 && (
          <span className="min-w-0 truncate text-[10px] text-ink-faint" title={model}>
            {model}
          </span>
        )}
      </div>
      {text === null || text.trim().length === 0 ? (
        <p className="text-xs text-ink-faint">{emptyHint}</p>
      ) : (
        /*
         * ⚠️ `whitespace-pre-wrap` 而不是 `truncate`：
         * 论证是要**读**的（那正是这一块存在的意义），截断会让它变成没用的装饰。
         * `max-h` + 滚动保证长论证不会把整页撑开。
         */
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-lo">
          {text}
        </p>
      )}
    </div>
  );
}
