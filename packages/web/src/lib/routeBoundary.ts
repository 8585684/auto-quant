/**
 * 路由级错误边界的 key 计算 —— 外部 issue #169。
 *
 * ## 为什么 key 必须随路由变化
 *
 * React 的错误边界一旦进入 error 状态就**不会自己恢复**：除非它的 `key` 变了
 *（或组件被重新挂载），否则即使导航到另一个页面，它仍然渲染 fallback。
 *
 * 也就是说：**没有 key 的边界会让一次渲染崩溃粘住整个会话** ——
 * 用户切到别的页面看到的还是"这一块渲染失败"，而实际上那个页面是好的。
 *
 * ## 为什么按 `pathname` 而不是 `location.key`
 *
 * `react-router` 的 `location.key` 在**每次导航**时都会换一个新值 ——
 * 包括同一页内的查询串变化。那意味着用户在崩溃页面上点一个筛选（`?tab=2`）
 * 就会重置边界、于是又崩一次，形成"点了就崩、崩了就重置"的循环。
 *
 * 按 `pathname` 分组则只在**真的换页**时重置 —— 那是我们想要的语义。
 */
export function boundaryKeyFor(pathname: string | undefined): string {
  if (!pathname) return '/';
  /*
   * 剥掉查询串与哈希。`useLocation().pathname` 本来就不含它们，
   * 但这里接受任意字符串，所以自己剥一次 —— 免得调用方传错时
   * 悄悄退化成"每次查询变化都重置"。
   */
  const cut = Math.min(
    ...['?', '#']
      .map((c) => pathname.indexOf(c))
      .filter((i) => i >= 0)
      .concat([pathname.length]),
  );
  const path = pathname.slice(0, cut);
  return path.length > 0 ? path : '/';
}
