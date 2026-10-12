/**
 * 外壳要用的**数据**（纯读，无副作用）。
 *
 * 和它配套的是 `ShellRuntime` —— 那个负责**行为**（连推送、起轮询、渲染
 * toast）。两者分开是因为行为必须在 React 树里恰好发生一次，而数据可以
 * 被任意多个组件读。
 */
import { useApp, useEvents } from '../../lib/store';
import { NAV_GROUPS, NAV_ITEMS, type NavGroup, type NavItem } from '../../components/nav';

export interface ShellData {
  user: ReturnType<typeof useApp.getState>['user'];
  system: ReturnType<typeof useApp.getState>['system'];
  traders: ReturnType<typeof useApp.getState>['traders'];
  socketStatus: ReturnType<typeof useEvents.getState>['status'];
  runningCount: number;
  clockWarn: boolean;
  weightPercent: number;
  weightWarn: boolean;
  navItems: NavItem[];
  navGroups: NavGroup[];
}

export function useShellData(): ShellData {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const traders = useApp((s) => s.traders);
  const socketStatus = useEvents((s) => s.status);

  const runningCount = system?.runningTraders.length ?? traders.filter((t) => t.isRunning).length;

  /*
   * 两个诊断阈值。
   *
   * 时钟取**绝对值** —— 交易所的时钟快于本地同样会导致 -1021，
   * 只看正数会漏掉一半情况。
   *
   * 权重用 70% 而不是 100%：请求权重是**按分钟滚动**的，等到 100% 就已经在
   * 被拒绝了。代码里的软上限是 75%，留一点提前量。
   */
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > 2000;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system?.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;

  return {
    user,
    system,
    traders,
    socketStatus,
    runningCount,
    clockWarn,
    weightPercent,
    weightWarn: weightPercent >= 70,
    navItems: NAV_ITEMS,
    navGroups: NAV_GROUPS,
  };
}
