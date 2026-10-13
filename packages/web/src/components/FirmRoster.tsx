/**
 * **组织架构面板** —— 把"这家 AI 交易公司有哪些人、各自干什么"摊开给操作员看。
 *
 * ## 用户的要求（这是本组件存在的理由）
 *
 * > 「我理想中这次更新以后的效果：开启以后，整个智能体团队就开始并发工作，
 * >  有主管、分析账户的、有调查新闻的、有监控社区的、有查市场情绪的、
 * >  有维护系统的程序员、有汇报工作的、有文员、有交易员、有风控员等等
 * >  **一切专业交易所量化机构有的我们都要有**」
 *
 * > 「看板应该直观显示**有哪些智能体，都是什么分工**，都在做什么」
 *
 * ## 为什么必须把"还没实现的"也列出来并标明
 *
 * 用户列的理想组织里有**还没实现的角色**（"监控社区"、"维护系统的程序员"）。
 *
 * 如果只显示已实现的，操作员会以为**公司就是这么大**；
 * 如果把未实现的也当成在岗显示，操作员会以为**有人在看社区舆情** —— 而实际上没有。
 *
 * 两种都是"看不出异常的偏差"。所以这里**列全**，并用 `status` 明确区分：
 *
 * | 标记 | 含义 |
 * |---|---|
 * | 🟢 在岗 | 已实现（本轮可能参与）|
 * | ⚪ 规划中 | **还没实现** —— 不要以为有人在干这件事 |
 *
 * ## 数据来源
 *
 * 角色定义来自 `@aq/shared` 的 `FIRM_ROLES`（与服务端路由表**同一份**，
 * 漂移由 `routedModel.test.ts` 的测试挡住）。
 * "本轮参与了没有"来自实时事件流（`LiveCycle.steps` 里的 `role`）。
 */

import { useState } from 'react';

import { DEPARTMENT_ORDER, FIRM_ROLES, firmRoleOf, type FirmRole } from '@aq/shared';

/** 档位在界面上的短标签（把"思考深度"翻译成"这活有多难"）。 */
const TIER_LABEL: Record<FirmRole['tier'], string> = {
  T3_deep: '深度思考',
  T2_mid: '分析',
  T1_fast: '快速',
  T0_code: '纯代码',
};

/** 档位的颜色（深度思考最显眼 —— 那是花钱与决定盈亏的地方）。 */
const TIER_CLASS: Record<FirmRole['tier'], string> = {
  T3_deep: 'text-accent',
  T2_mid: 'text-ink-soft',
  T1_fast: 'text-ink-faint',
  T0_code: 'text-ink-faint',
};

/**
 * 组织架构面板。
 *
 * @param activeRoles 本轮**实际参与过**的角色 id（来自实时事件流）
 */
export function FirmRoster({ activeRoles }: { activeRoles: ReadonlySet<string> }): React.ReactElement {
  /*
   * **默认收起** —— 这是"参考材料"（公司有多少岗位），不是"现在发生了什么"。
   * 20 行全展开会把实时看板挤下去，而操作员盯盘时看的是实时那部分。
   */
  const [open, setOpen] = useState(false);

  const staffed = FIRM_ROLES.filter((r) => r.status === 'staffed').length;
  const planned = FIRM_ROLES.length - staffed;
  const activeCount = [...activeRoles].filter((id) => firmRoleOf(id)?.status === 'staffed').length;

  return (
    <div className="overflow-hidden rounded-md border border-base-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-base-850 px-2.5 py-1.5 text-left"
      >
        <span className="shrink-0 text-xs font-medium text-ink-hi">组织架构</span>
        <span className="num shrink-0 text-xs text-ink-faint">{FIRM_ROLES.length} 个岗位</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          在岗 {staffed} · 规划中 {planned}
          {activeCount > 0 ? ` · 本轮参与 ${activeCount}` : ''}
        </span>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="space-y-2 p-2.5">
          <p className="text-xs text-ink-faint">
            ⚪ 标「规划中」的**还没实现** —— 不要以为有人在干那件事。
            角色定义与服务端路由表**同一份**（漂移由测试挡住）。
          </p>

          {DEPARTMENT_ORDER.map((dept) => {
            const roles = FIRM_ROLES.filter((r) => r.department === dept);
            if (roles.length === 0) return null;
            return (
              <div key={dept} className="overflow-hidden rounded border border-base-700/60">
                <div className="bg-base-850 px-2 py-1 text-xs font-medium text-ink-hi">{dept}</div>
                <ul className="divide-y divide-line/40">
                  {roles.map((r) => (
                    <RoleRow key={r.id} role={r} active={activeRoles.has(r.id)} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 一行岗位。 */
function RoleRow({ role, active }: { role: FirmRole; active: boolean }): React.ReactElement {
  const planned = role.status === 'planned';
  return (
    <li className={`flex items-start gap-2 px-2 py-1.5 ${planned ? 'opacity-50' : ''}`}>
      {/* 状态点：在岗且本轮参与 → 实心绿；在岗未参与 → 空心；规划中 → 灰 */}
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          planned ? 'bg-ink-faint/40' : active ? 'bg-up' : 'border border-ink-faint'
        }`}
        title={planned ? '规划中（还没实现）' : active ? '本轮参与了' : '在岗（本轮未参与）'}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium text-ink-hi">{role.label}</span>
          <span className={`text-[10px] ${TIER_CLASS[role.tier]}`}>{TIER_LABEL[role.tier]}</span>
          {planned && <span className="text-[10px] text-ink-faint">⚪ 规划中</span>}
          {active && !planned && <span className="text-[10px] text-up">本轮参与</span>}
        </div>
        <p className="text-[11px] leading-snug text-ink-lo">{role.duty}</p>
      </div>
    </li>
  );
}
