/**
 * **「清空」不能被回填 effect 立刻撤销**（外部 issue #168）。
 *
 * ## 缺陷经过
 *
 * `DataPage.tsx:192-196` 的回填 effect：
 *
 * ```ts
 * if (source === 'socket' && restLines.length > 0 && liveLogs.length === 0) {
 *   hydrateLogs(restLines);
 * }
 * // 依赖数组含 liveLogs.length
 * ```
 *
 * 而「清空」按钮 `:414-422` 调 `clearLogs()` → `set({ logs: [] })`
 *（`lib/store.ts:601`）。于是：
 *
 * ```
 * 点清空 → liveLogs.length 由 N 变 0 → 依赖变化 → effect 重跑
 *        → 判据成立 → hydrateLogs(restLines) 把同一批历史原样灌回
 * ```
 *
 * 而 `restQuery` 每 8–30 秒轮询，所以不只是"闪一下复原"，是**持续被灌回**。
 *
 * ## 根因
 *
 * 用"缓冲区是否为空"当"是否需要**首次**回填"的判据 ——
 * 而"**用户主动清空**"与"**页面首次加载**"在这个状态里长得一模一样。
 *
 * 这与本仓库反复记录的那类问题同源：**用一个会被两种语义共用的信号当判据**
 *（`#148` 的 401 被"会话失效"与"密码填错"共用是同一个模式，只是那一条在后端）。
 * 区别只在于：那次两边都是错误，这次一边是**用户的明确意图**。
 *
 * ## 修法
 *
 * 加一个"已经回填过"的一次性标志（`useRef`，不触发重渲染），并把它纳入判据。
 * **`clearLogs` 不该重置它** —— 清空是"我不想看这些"，不是"重新加载"。
 * 只有用户主动点"重新加载"（或刷新页面）才恢复。
 *
 * ## 为什么测纯函数
 *
 * 本仓库 web 侧没有 jsdom/RTL（`test` 只跑 `.test.ts`，挂载不了组件），
 * 而 effect 的判据正是缺陷所在。所以把判据抽成 `shouldBackfill()` ——
 * 与 `#148` 抽 `shouldSignOut()` 是同一个做法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldBackfill } from './logBackfill';

test('★★★ 用户清空之后不得再回填 —— 否则「清空」按钮是 no-op', () => {
  /*
   * 时间线：页面首次加载 → 回填 → 用户点清空 → restQuery 又回来一批 →
   * **不得再回填**。
   */
  assert.equal(
    shouldBackfill({
      source: 'socket',
      restLineCount: 300,
      alreadyHydrated: true,
      manuallyCleared: true,
    }),
    false,
    '★★★ 清空之后回填 effect 必须闭嘴 —— 否则同一批历史立刻被灌回（issue #168）',
  );
});

test('★★★ 首次加载必须回填 —— 修清空不能把首次加载一起修掉', () => {
  /* 反向守卫：这是这个 effect **存在的原因**，不能被"永不回填"取代。 */
  assert.equal(
    shouldBackfill({ source: 'socket', restLineCount: 300, alreadyHydrated: false, manuallyCleared: false }),
    true,
    '★★★ 首次加载必须回填 —— 否则打开页面看到的是空白（而这个 effect 就是为它存在的）',
  );
});

test('★ 已经回填过就不再重复回填 —— 否则每次轮询都会把历史重灌一遍', () => {
  /*
   * 即使没有"清空"这个动作，回填也必须是**一次性**的：
   * `restQuery` 每 8–30 秒回来一次，每次 `restLines` 都是新数组引用 →
   * 没有这个标志的话 effect 会反复把历史灌进缓冲区。
   */
  assert.equal(
    shouldBackfill({ source: 'socket', restLineCount: 300, alreadyHydrated: true, manuallyCleared: false }),
    false,
    '★ 回填是一次性的 —— 否则轮询会把历史反复重灌',
  );
});

test('★ 没有历史可回填时不动作', () => {
  assert.equal(
    shouldBackfill({ source: 'socket', restLineCount: 0, alreadyHydrated: false, manuallyCleared: false }),
    false,
    '★ 没有历史时不必回填',
  );
});

test('★ REST 视图（source=rest）不走回填 —— 它直接读 restLines', () => {
  assert.equal(
    shouldBackfill({ source: 'rest', restLineCount: 300, alreadyHydrated: false, manuallyCleared: false }),
    false,
    '★ REST 视图不需要回填（它本来就渲染 restLines）',
  );
});
