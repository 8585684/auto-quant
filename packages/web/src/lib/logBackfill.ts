/**
 * 「要不要把持久化的历史日志回填进实时缓冲区」—— 外部 issue #168。
 *
 * ## 为什么它需要是一个独立函数
 *
 * 这个判据原来是 `DataPage.tsx:193` 内联在 effect 里的一行：
 *
 * ```ts
 * if (source === 'socket' && restLines.length > 0 && liveLogs.length === 0) { … }
 * ```
 *
 * 而缺陷正是"用 `liveLogs.length === 0` 当**首次**回填的判据" ——
 * 清空之后那个条件成立，于是历史被立刻灌回。
 *
 * 抽出来之后，**缺陷所在的那一行第一次可被单测**（web 侧没有 jsdom/RTL）。
 * 与 `api.ts` 抽 `shouldSignOut()`（issue #148）是同一个做法。
 */

export interface BackfillInput {
  /** 当前视图来源：`socket` 走实时缓冲区，`rest` 直接读历史。 */
  source: 'socket' | 'rest';
  /** 历史日志（REST）里有多少行可用。 */
  restLineCount: number;
  /** 这个会话是否**已经**回填过一次（`useRef`，不触发重渲染）。 */
  alreadyHydrated: boolean;
  /**
   * 用户是否**主动清空**过缓冲区。
   *
   * ⚠️ 这个字段存在的理由：`alreadyHydrated` 单独一个标志**不够** ——
   * 清空之后缓冲区为空，而"用户想看空白"是一个**明确的意图**，
   * 不该被下一次轮询撤销。见 `shouldBackfill()` 里的判断顺序。
   */
  manuallyCleared: boolean;
}

/**
 * 现在该不该把历史回填进实时缓冲区？
 *
 * ## 判据的语义（按顺序）
 *
 * 1. **只有 `socket` 视图需要回填** —— `rest` 视图本来就渲染 `restLines`；
 * 2. **用户主动清空过 → 不回填**（这一条是 issue #168 的修复）。
 *    清空的意思是"我不想看这些"，不是"重新加载"。
 *    要恢复请点「重新加载」（`DataPage.tsx:423`）或刷新页面；
 * 3. **已经回填过 → 不回填**。`restQuery` 每 8–30 秒轮询一次，
 *    每次 `restLines` 都是新数组引用 —— 没有这一条的话历史会被反复重灌；
 * 4. **没有历史 → 不动作**。
 *
 * ## 为什么 `manuallyCleared` 不能只靠 `alreadyHydrated`
 *
 * 因为"清空"与"首次加载"在状态上**长得一模一样**（缓冲区都是空的）——
 * 而这正是本仓库反复修过的那类缺陷：**一个信号被两种语义共用**。
 * 所以必须有一个显式的字段区分它们，而不是靠推断。
 */
export function shouldBackfill(input: BackfillInput): boolean {
  /* 1. REST 视图直接读历史，不需要回填。 */
  if (input.source !== 'socket') return false;

  /* 2. 用户主动清空过 —— 这是明确的意图，轮询不得撤销它。 */
  if (input.manuallyCleared) return false;

  /* 3. 回填是一次性的 —— 否则每次轮询都会重灌历史。 */
  if (input.alreadyHydrated) return false;

  /* 4. 没有历史可回填。 */
  if (input.restLineCount <= 0) return false;

  return true;
}
