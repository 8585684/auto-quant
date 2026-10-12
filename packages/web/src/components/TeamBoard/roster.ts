/**
 * **AI 交易公司的编制表** —— 团队模式（`ai_team`）工作流区的**单一事实来源**。
 *
 * ## 用户的要求（这是本文件存在的理由，2026-10-12）
 *
 * > 「UI 丑陋，不直观，用户无法看清楚 AI 运行状态，界面丑陋抽象，**有英文**，
 * >  还有不合理不人性化，感觉不是给人看的」
 *
 * > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**等关键信息」
 *
 * > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以手动点击打开查看详情」
 *
 * ## ⚠️ 为什么这个文件是新建的，而不是改 `TeamRoster.tsx`
 *
 * `TeamRoster.tsx` / `FirmRoster.tsx` / `DebateView.tsx` 里用了一整批
 * **本项目 Tailwind 配置里根本不存在的类名** —— 实测（对构建产物 CSS 逐类核对）：
 *
 * | 用到的类 | `tailwind.config.js` 里的真相 |
 * |---|---|
 * | `border-line` / `divide-line` | ❌ 不存在（有 `base-700`/`750`/`800`，**没有 `line`**） |
 * | `bg-surface-1` / `-2` / `-3` | ❌ 不存在（层级色叫 `base-*`） |
 * | `text-ink-soft` | ❌ 不存在（文字四级是 `ink-hi/mid/lo/faint`） |
 * | `bg-ok` / `text-ok` / `bg-danger` / `text-danger` | ❌ 不存在（语义色是 `up` / `down` / `warn`） |
 *
 * **Tailwind 对不存在的类不报错、不告警，只是不生成样式** —— 于是那三个组件
 * 渲染出来是"**一堆没有边框、没有底色、状态灯根本没有颜色**"的裸文字。
 * 这正是用户说的「界面丑陋抽象、不是给人看的」的一部分，而且它**编译全绿**。
 * 本仓库为同一类问题付过代价（`animate-pulseSoft` 那个从不闪烁的状态徽章，
 * 见 `scripts/ui-smoke.mjs` 的注释），所以这里不再"改一改"，而是**重写**。
 *
 * ## 三态：在岗 / 忙碌 / 规划中（用户要"看清楚 AI 运行状态"）
 *
 * 用户抱怨的核心是"看不出 AI 在不在干活"。所以每个岗位有**一个明确的状态**：
 *
 * | 状态 | 什么时候 | 界面 |
 * |---|---|---|
 * | 🟢 **进行中** | 本轮有它的步骤，最后一步还没出结果 | 呼吸圆点 |
 * | ✅ **已完成** | 本轮有它的步骤，且看到了完成类的措辞 | 实心绿点 |
 * | ⚠ **失败** | 本轮它的步骤里有 error / 失败措辞 | 红点 + 原因 |
 * | ⚪ **在岗（本轮未参与）** | 已实现，但这一轮没叫它 | 空心点 |
 * | ⬜ **规划中** | **还没实现** | 灰点 + 明确标注 |
 *
 * 最后两态**必须区分**：把它们合成"未参与"会让操作员以为"社区监控有人在看，
 * 只是这轮没轮到" —— 而实际上**根本没有人在看**。那是两种完全不同的结论。
 */

import type { FirmRole } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  展示用的设计令牌（全部来自 `tailwind.config.js`，逐条核对过）                 */
/* -------------------------------------------------------------------------- */

/**
 * 文字层级。
 *
 * ⚠️ **不要写 `text-ink-soft`** —— 那个类不存在（见文件头）。四级就是这四个。
 */
export const INK = {
  hi: 'text-ink-hi',
  mid: 'text-ink-mid',
  lo: 'text-ink-lo',
  faint: 'text-ink-faint',
} as const;

/** 卡片/分隔的边框与底色（层级色 `base-*`，不是 `surface-*`）。 */
export const SURFACE = {
  /** 抬升面板：比面板底色 `base-900` 高一层，盒子才浮得出来。 */
  raised: 'bg-base-850',
  /** 凹陷（代码块、空态）。 */
  sunken: 'bg-base-950',
  border: 'border-base-700',
  borderSoft: 'border-base-750',
  divider: 'border-base-800',
} as const;

/**
 * 状态色。
 *
 * ⚠️ 语义色只有 `up` / `down` / `warn` / `accent` 四个 —— **没有 `ok` / `danger`**。
 * 写成 `bg-ok` 会得到一个没有背景色的 span（那个"状态灯"于是从来不存在）。
 */
export const TONE = {
  active: 'bg-accent',
  done: 'bg-up',
  failed: 'bg-down',
  idle: 'border border-ink-faint',
  planned: 'bg-ink-faint/40',
  activeText: 'text-accent',
  doneText: 'text-up',
  failedText: 'text-down',
} as const;

/* -------------------------------------------------------------------------- */
/*  状态                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一个岗位在当前这一轮的状态。
 *
 * `active` / `done` / `failed` 三态互斥，优先级 `failed > done > active`：
 * 一个角色**失败过**就绝不能再显示成"已完成"（那会让操作员以为它给了结论）。
 */
export type RosterState = 'active' | 'done' | 'failed' | 'idle' | 'planned';

/** 一个岗位的完整呈现数据。 */
export interface RosterEntry {
  role: FirmRole;
  state: RosterState;
  /** 最近一条动作（`null` = 本轮没参与）。 */
  latest: { at: string; message: string; level: string; phase: string | null } | null;
  /** 本轮它跑过的步数。 */
  stepCount: number;
  /** 最近一步是否在"进行中"（用于决定圆点闪不闪）。 */
  inFlight: boolean;
}

/**
 * 一步实时事件（`cycle_step` 的界面侧形状）。
 *
 * `role` / `phase` 在**声明类型**上是可选的 —— `store.ts` 的 `LiveCycle.steps`
 * 只声明了 `{ at, level, message }`，团队模式才多推这两个字段。
 * 这里显式声明成可选，调用方传入时就不需要 `as` 断言。
 */
export interface TeamStep {
  at: string;
  level: string;
  message: string;
  role?: string | null;
  phase?: string | null;
}

/**
 * 判定一个角色的状态。
 *
 * ## 为什么用措辞而不是"有没有下一条"
 *
 * 服务端只推两样东西：**步骤开始/发生的通知**（`onStep`）与**日志级别**。
 * 它**没有**推"这一步成没成"这个布尔值 —— 见 `tradingDesk.ts` 的 `note()`。
 * 所以这里只能：
 *
 *   · `level === 'error'` 或消息里出现失败措辞 → **失败**（唯一的硬信号）；
 *   · 消息里出现完成措辞（`完成` / `已裁决` / `已出`）→ **已完成**；
 *   · 否则 → **进行中**。
 *
 * ⚠️ **不要把"没有后续步骤"当成"已完成"**：那会把一个**卡住的**角色
 * 显示成"做完了"，而卡住正是最需要被看见的情况。
 */
export function stateOfLastStep(steps: readonly TeamStep[]): 'active' | 'done' | 'failed' {
  let failed = false;
  let done = false;
  for (const s of steps) {
    if (s.level === 'error' || /失败|抛错|不可用|超时/.test(s.message)) failed = true;
    if (/完成|已裁决|已出|已完成/.test(s.message)) done = true;
  }
  if (failed) return 'failed';
  if (done) return 'done';
  return 'active';
}

/**
 * 把 `cycle_step` 流**按岗位归并**，并按**编制表顺序**输出。
 *
 * ## 为什么不按时间顺序显示
 *
 * 团队是**并行**的：4 个分析师的步骤会交错出现
 *（实测日志形状：`technical 完成` → `sentiment 完成` → `newscaster 完成` → …）。
 * 按时间排会把每个角色的过程切碎，看不出"这个角色在干什么"。
 *
 * ## 为什么顺序必须固定
 *
 * 编制表顺序取自 `FIRM_ROLES`（与服务端路由表**同一份定义**，漂移由
 * `routedModel.test.ts` 挡住）。固定顺序意味着**某一轮少派了谁，其他人的
 * 位置也不跳** —— 否则操作员每轮都要重新找"技术面在哪一行"。
 *
 * @param steps 实时步骤流
 * @param activeRoles 编制表（默认取 `FIRM_ROLES`，注入是为了可测）
 */
export function rosterEntries(
  steps: readonly TeamStep[],
  roster: readonly FirmRole[],
): RosterEntry[] {
  /** role → 它这一轮的所有步骤 */
  const byRole = new Map<string, TeamStep[]>();
  for (const s of steps) {
    const role = s.role;
    if (role === null || role === undefined || role.length === 0) continue; /* 无角色的步骤不进编制表 */
    const bucket = byRole.get(role);
    if (bucket) bucket.push(s);
    else byRole.set(role, [s]);
  }

  const entries: RosterEntry[] = roster.map((role) => {
    const own = byRole.get(role.id);
    if (!own || own.length === 0) {
      /*
       * 「没参与」还要分两种，而**这个区分是本文件最重要的判断**：
       * `planned` 是"这个岗位根本没人"，`idle` 是"有人在，这轮没叫他"。
       * 合并它们等于告诉操作员"社区监控有人在盯着，只是这轮没轮到"。
       */
      return {
        role,
        state: role.status === 'planned' ? 'planned' : 'idle',
        latest: null,
        stepCount: 0,
        inFlight: false,
      };
    }
    const last = own[own.length - 1]!;
    return {
      role,
      state: stateOfLastStep(own),
      latest: {
        at: last.at,
        message: last.message,
        level: last.level,
        phase: last.phase ?? null,
      },
      stepCount: own.length,
      inFlight: true,
    };
  });

  /*
   * 编制表之外的角色（后端加了新岗位、界面还没登记）**追加在后面**。
   * 丢掉它们会让"某个角色在干活但界面看不到" —— 比显示成"未登记"糟得多。
   */
  const known = new Set(roster.map((r) => r.id));
  for (const [roleId, own] of byRole) {
    if (known.has(roleId)) continue;
    const last = own[own.length - 1]!;
    entries.push({
      /*
       * 未登记的岗位：**不能编造分工**。`duty` 直说"界面还没登记这个岗位"，
       * 而它确实在干活（有实时步骤），所以 `status` 记 `staffed`。
       */
      role: {
        id: roleId,
        label: roleId,
        duty: '界面还没登记这个岗位的分工 —— 但它在工作（见右侧最近动作）。',
        department: '技术',
        tier: 'T2_mid',
        status: 'staffed',
      },
      state: stateOfLastStep(own),
      latest: { at: last.at, message: last.message, level: last.level, phase: last.phase ?? null },
      stepCount: own.length,
      inFlight: true,
    });
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/*  给人看的标签                                                               */
/* -------------------------------------------------------------------------- */

/** 编排阶段的中文名（对应服务端 `phase` 字段）。 */
export const PHASE_LABEL: Record<string, string> = {
  dispatch: '派发',
  analysis: '并行分析',
  debate: '多空辩论',
  verdict: '裁决',
  risk: '风控把关',
  execute: '执行',
};

/**
 * 档位 → "这活有多难"。
 *
 * 用户是交易员，不是 ML 工程师：`T3_deep` 对他没有意义，
 * 「深度思考」才说明"这一步最贵、最影响盈亏"。
 */
export const TIER_LABEL: Record<FirmRole['tier'], string> = {
  T3_deep: '深度思考',
  T2_mid: '分析',
  T1_fast: '快速',
  T0_code: '纯代码',
};

/**
 * 状态的**文字**（不能只靠颜色 —— `DESIGN.md` §2 的硬要求，也是色盲用户的前提）。
 */
export const STATE_LABEL: Record<RosterState, string> = {
  active: '进行中',
  done: '已完成',
  failed: '失败',
  idle: '在岗',
  planned: '规划中',
};

/** 状态的悬停说明（把"这意味着什么"写清楚，而不是让人猜）。 */
export const STATE_HINT: Record<RosterState, string> = {
  active: '这一轮它正在工作 —— 还没有看到完成信号。',
  done: '这一轮它已经交出了产出。',
  failed: '这一轮它出错了 —— 展开右侧「本轮流程」看具体原因。',
  idle: '这个岗位已实现，但这一轮没有叫它（例如只在特定条件下才启用）。',
  planned: '**这个岗位还没有实现** —— 不要以为有人在干这件事。',
};

/**
 * 把 ISO 时刻显示成 `HH:MM:SS`。
 *
 * 用 24 小时制且不显示日期：工作流区回答的是"**刚刚**谁动了"，
 * 日期在这里是噪音（跨天的历史在下面的决策流水里，那里带相对时间）。
 */
export function clock(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
