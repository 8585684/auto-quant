/**
 * **页面级错误边界**：一条坏数据不该让整页白屏（外部 issue #169）。
 *
 * ## 缺陷经过
 *
 * 全仓只有**一个**错误边界（`components/FeedErrorBoundary.tsx`），
 * 而它**只被两处使用**（`DecisionFeed.tsx` 的两处决策卡片）。
 * 其余位置一个都没有：
 *
 * | 位置 | 有边界吗 |
 * | --- | --- |
 * | `App.tsx` 的 `Lazy` | ❌ 只有 `Suspense`（它捕挂起，不捕抛错） |
 * | `Layout.tsx` | ❌ |
 * | `main.tsx` | ❌ 直接 `createRoot().render()`，无顶层边界 |
 * | `OverviewPage` / `TradersPage` / `MarketPage` / `TraderTables` | ❌ |
 *
 * React 的行为是：渲染期抛错若无边界，**卸载整棵树** → 白屏。
 *
 * 而这个仓库**自己记录过这次事故**：
 * `docs/archive/REPORT-TRIAGE-20260926.md:98` 把
 * 「前端缺 ErrorBoundary（渲染期抛错会白屏）」列在"已确认但仍未修"里；
 * `FeedErrorBoundary.tsx` 的头部注释也记了一次真实白屏
 *（一条字段不全的决策记录 → `Cannot read properties of undefined (reading 'length')`）。
 *
 * 所以这不是"新发现的风险"，而是**一笔记了账却没还的债**。
 *
 * ## 为什么风险面比"决策 feed 之外"更大
 *
 * 那些没有边界的页面消费的**同样是"模型输出解析而来"的不可信数据**
 *（持仓、订单、成交、权益曲线都来自交易循环落库，而落库内容一部分源自模型输出）。
 * 按 `docs/AGENTS.md` §2.4「模型的输出是不可信输入」——
 * 不可信输入的展示路径上应当有兜底，而当时只有一条路径有。
 *
 * ## 这个测试钉什么
 *
 * `App.tsx` 的 `Lazy` 是**每个路由元素都经过**的那一层（20+ 处使用），
 * 所以在那里加边界能一次覆盖所有页面。而"切路由时边界必须 reset"
 * 是这类修复最常见的坑（一次崩溃粘住、切页也不恢复）。
 *
 * 由于 web 侧没有 jsdom/RTL，这里断言的是**源码结构与接线**，
 * 加上 `shouldResetBoundary()` 这个纯判据的行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { boundaryKeyFor } from './routeBoundary';

const APP_SRC = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('★★★ 每个路由元素都必须经过错误边界 —— 否则一条坏数据白屏整页', () => {
  /*
   * `Lazy` 是"每个路由元素 + 它自己的 Suspense 边界"那一层（20+ 处使用）。
   * 断言它内部包了 `FeedErrorBoundary`。
   */
  const lazyStart = APP_SRC.indexOf('function Lazy(');
  assert.ok(lazyStart > 0, '找不到 `Lazy` —— 结构变了，请更新本测试');

  const lazyBody = APP_SRC.slice(lazyStart, APP_SRC.indexOf('\n}', lazyStart));

  assert.match(
    lazyBody,
    /FeedErrorBoundary/,
    '★★★ `Lazy` 必须包一层 `FeedErrorBoundary` —— 它是每个路由元素都经过的那一层。\n' +
      '    React 在渲染期抛错且无边界时会卸载整棵树（白屏），\n' +
      '    而本仓库自己把这条记在 docs/archive/REPORT-TRIAGE-20260926.md:98（"已确认但仍未修"）。',
  );

  /* 而且 `Suspense` 必须还在 —— 边界不能取代它（两者捕的是不同东西）。 */
  assert.match(lazyBody, /Suspense/, '★ `Suspense` 必须保留（它捕挂起，错误边界捕抛错，两者不互相替代）');
});

test('★★★ 切路由时边界必须 reset —— 否则一次崩溃会粘住', () => {
  /*
   * React 的错误边界一旦进入 error 状态就**不会自己恢复**：
   * 除非 key 变了（或组件重新挂载），否则切到别的页面仍然显示 fallback。
   *
   * 所以 `Lazy` 里的边界必须带一个随路由变化的 `key`。
   */
  const lazyStart = APP_SRC.indexOf('function Lazy(');
  const lazyBody = APP_SRC.slice(lazyStart, APP_SRC.indexOf('\n}', lazyStart));

  assert.match(
    lazyBody,
    /key=\{/,
    '★★★ 边界必须带随路由变化的 `key` —— 否则一次渲染崩溃会粘住，切页也不恢复。\n' +
      '    React 的错误边界进入 error 状态后不会自己恢复。',
  );

  /* 而且那个 key 必须来自路由（`boundaryKeyFor` 或 `useLocation`）。 */
  assert.ok(
    /boundaryKeyFor|useLocation/.test(lazyBody) || /boundaryKeyFor/.test(APP_SRC),
    '★★★ key 必须来自当前路由（`boundaryKeyFor(useLocation().pathname)`）',
  );
});

test('★ boundaryKeyFor 对每个不同的路径给出不同的 key（切换即重置）', () => {
  assert.notEqual(boundaryKeyFor('/'), boundaryKeyFor('/traders'));
  assert.notEqual(boundaryKeyFor('/traders'), boundaryKeyFor('/market'));
  assert.equal(boundaryKeyFor('/traders'), boundaryKeyFor('/traders'), '同一路径必须稳定');
});

test('★ 带查询串/哈希时也按路径分组 —— 否则每次轮询都会重置边界', () => {
  /*
   * ⚠️ 这一条是**必要的谨慎**：如果 key 直接取 `location.key`（react-router 每次
   * 导航都换一个新值），那么同一页内的 `?tab=2` 变化都会重置边界 ——
   * 看起来无害，但那意味着"用户在崩溃页面上点了一个筛选，边界就被重置、
   * 于是又崩一次"。按 pathname 分组更稳。
   */
  assert.equal(boundaryKeyFor('/traders?tab=positions'), boundaryKeyFor('/traders'));
  assert.equal(boundaryKeyFor('/traders#top'), boundaryKeyFor('/traders'));
  assert.equal(boundaryKeyFor('/'), '/');
  assert.equal(boundaryKeyFor(''), '/', '空路径按根处理');
  assert.equal(boundaryKeyFor(undefined), '/', '拿不到 location 时按根处理（不抛）');
});
