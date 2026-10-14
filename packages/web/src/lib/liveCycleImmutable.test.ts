/**
 * **`cycle_step` 不能原地改 `liveCycle`**（外部 issue #157）。
 *
 * ## 缺陷形状
 *
 * `store.ts:546-556` 的 `case 'cycle_step'` 是**原地改**：
 *
 * ```ts
 * next.liveCycle.steps = [...next.liveCycle.steps, {...}];   // ← 换了数组，但没换 liveCycle
 * ```
 *
 * 而 `next` 本身是浅拷贝（`:513` 的 `{ ...current }`）—— 所以 `liveCycle` 的**引用没变**。
 *
 * zustand 用 `Object.is` 比较**选择器的返回值**，而 `useLiveCycle` 的选择器正是：
 *
 * ```ts
 * useEvents((state) => state.byTrader[traderId]?.liveCycle)   // store.ts:650
 * ```
 *
 * 引用不变 → `Object.is` 相等 → **不通知订阅者**。
 *
 * ## ⚠️ 影响面（issue 作者写"静默不重渲染"，但当前看不到）
 *
 * `TraderPage.tsx` 订阅的是**整个 `byTrader[traderId]`** —— 而那个对象每次
 * `cycle_step` 都被替换，所以步骤**照样刷新**。
 *
 * 也就是说它是一个**潜伏缺陷**：
 *   · 一旦有人给 `DecisionFeed` 加 `memo`（正常的性能优化）→ 立刻变成真故障；
 *   · 或改成只订阅 `useLiveCycle`（更精确的订阅，也是正常重构）→ 同样立刻爆发；
 *   · 而且它**已经在破坏不变量**：旧快照被追溯改写（见下面第 2 条用例）。
 *
 * ## 对照：同一个函数里的 `cycle_start` 是**对的**
 *
 * `store.ts:534` 的 `case 'cycle_start'` 用的是 `next.liveCycle = { ... }` ——
 * **替换引用**。同一个 `applyEvent` 里两种写法并存，正是这条缺陷容易被漏掉的原因。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { useEvents } from './store';

/** 把 store 恢复到干净状态（测试之间互不影响）。 */
function reset(): void {
  useEvents.setState({ byTrader: {}, status: 'idle', attempts: 0, logs: [], toasts: [] });
}

/** 起一轮。 */
function startCycle(traderId: number, cycleNumber: number): void {
  useEvents.getState().ingest({
    type: 'cycle_start',
    traderId,
    cycleNumber,
    timestamp: new Date(1_000_000).toISOString(),
  } as never);
}

/** 往当前轮里加一步。 */
function step(traderId: number, cycleNumber: number, message: string): void {
  useEvents.getState().ingest({
    type: 'cycle_step',
    traderId,
    cycleNumber,
    at: new Date(2_000_000).toISOString(),
    level: 'info',
    message,
  } as never);
}

test('★★★ cycle_step 必须换掉 liveCycle 的引用 —— 否则 zustand 选择器看不到变化', () => {
  reset();
  const traderId = 1;
  startCycle(traderId, 100);

  const before = useEvents.getState().byTrader[traderId]!.liveCycle;
  step(traderId, 100, '第一步');
  const after = useEvents.getState().byTrader[traderId]!.liveCycle;

  assert.ok(before && after, '两轮都要有 liveCycle');
  assert.notEqual(
    before,
    after,
    '★★★ `cycle_step` 必须换掉 `liveCycle` 的**引用** —— ' +
      '`useLiveCycle` 的选择器返回它，引用不变时 zustand 用 `Object.is` 判定相等、' +
      '**不通知订阅者**（issue #157）。\n' +
      '    同一个函数里的 `cycle_start` 用的就是 `next.liveCycle = { ... }` —— 两者应当一致。',
  );

  /* 而且步骤要真的进去了。 */
  assert.equal(after!.steps.length, 1, '★ 那一步必须被记录');
  assert.equal(after!.steps[0]!.message, '第一步');
});

test('★★★ 旧快照不能被追溯改写 —— 这是"原地改"更本质的代价', () => {
  /*
   * 原地改不只让选择器失明，它还**破坏了"历史快照不可变"这条不变量**：
   * 任何在改动前拿到的引用，都会在改动后"看到"新数据。
   *
   * 后果：React 的 `useMemo` / `useEffect` 依赖比较、将来的 diff/undo、
   * 以及任何"我以为我拿到的是那一刻的状态"的代码，都会拿到错的东西。
   */
  reset();
  const traderId = 2;
  startCycle(traderId, 200);

  const snapshot = useEvents.getState().byTrader[traderId]!.liveCycle;
  const stepsAtSnapshot = snapshot!.steps.length;

  step(traderId, 200, '后来的一步');

  assert.equal(
    snapshot!.steps.length,
    stepsAtSnapshot,
    '★★★ 改动前的快照不能被追溯改写 —— 原地改会让它"看到"后来的步骤。\n' +
      '    这与 `clearAllLiveCycles`（store.ts:260-275）刻意"没有变化就返回同一个引用"是同一类纪律。',
  );
});

test('★★ 订阅者必须真的被通知 —— 这是"引用换了"的可观测后果', () => {
  /*
   * 前两条断言的是"引用变了"，这一条断言**它的后果**：
   * 用与 `useLiveCycle` **完全相同**的选择器订阅，看它有没有被通知。
   *
   * ⚠️ 只断言"引用不同"是不够的 —— 一个把引用换掉但**不调 `set`** 的实现
   * 也能通过前两条，而订阅者依然收不到通知。
   *
   * ⚠️ 关于断言写法：zustand 的 `subscribe(listener)` 在**每次 `set`** 时调用
   * `listener`（它不替你做选择器过滤），所以观测序列里会出现重复值。
   * 我第一版断言了精确序列 `[1, 2]`，实际收到 `[0, 1, 1, 2]` ——
   * 那**不是**缺陷（`set` 内部会触发多次），是我的断言过严。
   *
   * 正确的判据是：**每一个新步骤数都要在序列里出现过**（而不是"序列恰好等于它"）。
   */
  reset();
  const traderId = 3;
  startCycle(traderId, 300);

  const seen: number[] = [];
  const unsubscribe = useEvents.subscribe((state) => {
    seen.push(state.byTrader[traderId]?.liveCycle?.steps.length ?? -1);
  });

  step(traderId, 300, 'a');
  step(traderId, 300, 'b');
  unsubscribe();

  for (const expected of [1, 2]) {
    assert.ok(
      seen.includes(expected),
      `★★ 订阅者必须收到"步骤数 = ${expected}"的通知（实际序列 ${JSON.stringify(seen)}）—— ` +
        '这正是 issue #157 报的地方：原地改时引用不变，订阅者收不到。',
    );
  }
  /*
   * 反向：序列里**不能只有 0** —— 那意味着两次步骤一次通知都没发出
   *（原地改的表现）。上面的 `includes` 已经覆盖了，这里留一句说明意图。
   */
  assert.ok(seen.length > 1, '★ 至少要有步骤带来的通知');
});

test('★ 迟到的旧轮步骤仍被忽略 —— 修引用不能破坏这个既有行为', () => {
  /*
   * 反向守卫：`case 'cycle_step'` 里有一个 `cycleNumber` 校验
   *（"迟到的旧轮步骤不该混进新一轮的列表里"）。改引用时很容易顺手删掉它。
   */
  reset();
  const traderId = 4;
  startCycle(traderId, 400);
  step(traderId, 400, '本轮的一步');

  /* 一个属于旧轮的迟到步骤。 */
  step(traderId, 399, '上一轮的迟到步骤');

  const cycle = useEvents.getState().byTrader[traderId]!.liveCycle;
  assert.equal(cycle!.steps.length, 1, '★ 旧轮的步骤不能混进来');
  assert.equal(cycle!.steps[0]!.message, '本轮的一步');
  assert.equal(cycle!.cycleNumber, 400, '★ 轮次号不能被旧事件改掉');
});

test('★ 步骤数封顶仍然生效 —— 长轮次不会无限增长', () => {
  reset();
  const traderId = 5;
  startCycle(traderId, 500);
  for (let i = 0; i < 300; i += 1) step(traderId, 500, `第 ${i} 步`);

  const cycle = useEvents.getState().byTrader[traderId]!.liveCycle;
  assert.ok(
    cycle!.steps.length < 300,
    `★ 步骤必须封顶（实际 ${cycle!.steps.length}）—— 否则长轮次会把内存与渲染都拖垮`,
  );
  /* 保留的应当是**最后**那些。 */
  assert.equal(cycle!.steps[cycle!.steps.length - 1]!.message, '第 299 步', '★ 保留最新的');
});
