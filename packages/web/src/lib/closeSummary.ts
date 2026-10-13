/**
 * 「平仓结果」的**唯一口径** —— 界面靠它说话，不靠调用点各自拼句子。
 *
 * ## 为什么单独抽出来
 *
 * 平仓（尤其「全部平仓」）是**避险动作**：操作员按下去，是想立刻退出风险。
 * 而服务端是**逐个**平的，任何一个标的失败都会被放进 `failed`。
 *
 * 原来的实现把成功横幅**无条件**渲染出来（绿色、写着"已平仓：…"），
 * 而 `failed` 在类型里根本不存在、消费点也没拷它 ——
 * 于是**部分标的根本没平掉，界面却说成功了**，操作员以为清仓完成就离开页面，
 * 而敞口仍在裸奔（外部 issue #144）。
 *
 * 这类缺陷的根子是「**同一件事在多个地方各拼一次说法**」。
 * 所以这里把它收成一个纯函数：文案与语气只在一处决定，调用点只负责渲染。
 *
 * 纯函数也让它可被直接单测 —— 而 `packages/web` 没有组件级测试，
 * 这是本仓库「导出的纯函数优先于需要打桩的对象」那条约定在这里的用法。
 */

/** 一次平仓请求的结果（`closeAllPositions` / `closePosition` 的共同形状）。 */
export interface CloseResult {
  /** 实际平掉的标的。 */
  closed: string[];
  /** 「全部平仓」时顺带撤掉的待成交挂单张数。 */
  cancelledPending?: number;
  /** 平仓失败的标的与原因。**非空时绝不能报成功。** */
  failed?: Array<{ symbol: string; error: string }>;
  /** 机器人是否仍在运行（它下一个周期可能重新开仓）。 */
  stillRunning: boolean;
}

/**
 * 结果横幅的语气。
 *
 * `'danger'` 只在**有标的没平掉**时出现 —— 那是"我以为清仓了、其实没有"，
 * 是这三种里唯一需要操作员立刻动手的状态。
 */
export type CloseTone = 'success' | 'danger' | 'neutral';

export interface CloseSummary {
  tone: CloseTone;
  /** 横幅主句（不含失败明细，明细由调用点逐条渲染以便排版）。 */
  headline: string;
  /** 失败项；非空时调用点必须逐条显示 symbol 与 error。 */
  failed: Array<{ symbol: string; error: string }>;
}

/**
 * 把一次平仓结果翻译成「语气 + 主句 + 失败明细」。
 *
 * ## 三条规则
 *
 * 1. **有失败 → 一律 danger，且主句必须数得出来**
 *    （`N 个已平，M 个平仓失败`）。绝不出现"已全部平仓"这种话 ——
 *    那是本节要消灭的那种自相矛盾。
 * 2. **没有失败、也没平掉任何东西** → neutral，说"没有需要平掉的持仓"。
 *    这不是成功，也不是失败。
 * 3. **平掉了但没失败** → success。
 *
 * 挂单张数单独拼进主句：撤挂单是"把敞口收回来"的一部分，
 * 操作员看不到它就会以为没生效（2026-10-02 用户报告过）。
 */
export function summarizeClose(result: CloseResult): CloseSummary {
  const failed = result.failed ?? [];
  const cancelled = result.cancelledPending ?? 0;
  const closedCount = result.closed.length;

  /*
   * ⚠️ **失败优先**：只要有标的没平掉，语气就必须是 danger，
   * 而且主句里要同时出现"平掉了几个"与"失败几个"——
   * 只说其中一个都会误导（只说失败会让操作员以为全没平，
   * 只说成功就是本 issue 要消灭的那个谎）。
   */
  if (failed.length > 0) {
    const parts = [`${closedCount} 个已平`, `${failed.length} 个平仓失败`];
    if (cancelled > 0) parts.push(`已撤 ${cancelled} 张挂单`);
    return {
      tone: 'danger',
      headline: `${parts.join('，')}。失败的标的仍未平掉，敞口还在，请立即处理：`,
      failed,
    };
  }

  const nothingToDo = closedCount === 0 && cancelled === 0;
  if (nothingToDo) {
    return {
      tone: 'neutral',
      headline: '没有需要平掉的持仓，也没有等待成交的挂单。',
      failed,
    };
  }

  const parts: string[] = [];
  parts.push(closedCount === 0 ? '没有持仓。' : `已平仓：${result.closed.join('、')}。`);
  if (cancelled > 0) parts.push(`已撤掉 ${cancelled} 张等待成交的挂单。`);
  return { tone: 'success', headline: parts.join(''), failed };
}
