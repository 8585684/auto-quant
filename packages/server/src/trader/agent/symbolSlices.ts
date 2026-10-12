/**
 * **把"全市场材料"按标的切成 N 份**（2026-10-12）。
 *
 * ## 为什么需要它（实测数据逼出来的）
 *
 * `#11` 实测，四个分析师里**只有拿大材料的两个超时**：
 *
 * | 角色 | 材料 | 结果 |
 * |---|---|---|
 * | `market_analyst` | `marketContext`（**130,917 字符 ≈ 3.7 万 token**）| ❌ 超时 180s |
 * | `technical` | `marketContext`（同上）| ❌ 超时 140s |
 * | `newscaster` | `newsContext`（小）| ✅ 55s |
 * | `sentiment` | `newsContext`（小）| ✅ 12s |
 *
 * 而**模型本身不慢** —— 实测同一个路由组在小输入下：
 * ```
 *   group/team-grunt   2.2 秒
 *   group/team-analyst 5.2 秒
 * ```
 *
 * **所以"慢"来自输入规模**。而材料 88% 是"每个候选标的 10–12k 字符"：
 * ```
 *   15k  # 全市场概览（525 个 USDT 永续）
 *   12k  ### 1. STRKUSDT
 *   12k  ### 2. WUSDT
 *   ...  （9 个候选）
 * ```
 *
 * ## 这就是用户早就建议的方向
 *
 * > 「以前的做法好像是**全部放到一个上下文一次性分析**，貌似会导致
 * > **模型思考很长，浪费实际**，这个团队模式下是否能改成**拆分**」
 *
 * 切成 N 份后，每个 agent 只读**自己那一个标的**（约 11k 字符），
 * 而不是全市场 13 万字符 —— **输入降 11 倍**。
 *
 * ## ⚠️ 为什么用"切已渲染好的字符串"而不是"重新渲染"
 *
 * 重新渲染需要在 `prompt.ts` 里再造一条渲染路径 —— 而那个文件已经明确
 * 写过"两处各算一遍"的教训（`quantity` 曾由两条路径各算一次导致真实拒单）。
 *
 * 切分**不改渲染**，只是把同一份材料分组。风险是"依赖格式"——
 * 所以下面有两条防线：
 *   ① `splitMarketContext` 切不出来时**返回 null**（调用方退回原文，而不是拿到空材料）；
 *   ② 测试钉住真实的格式（`### 1. SYMBOL（来源）`）。
 *
 * ⚠️ **绝不返回"空切片"** —— 那会让 agent 在"没有材料"的情况下编造，
 * 而这正是本项目反复强调的"看不出异常的失败"。
 */

/** 一段"属于某个标的"的材料。 */
export interface SymbolSlice {
  /** 从标题里解析出的标的代码（`STRKUSDT`）。解析不出时为 `null` —— 调用方应当退回原文。 */
  symbol: string | null;
  /** 该标的的完整材料（含标题行）。 */
  text: string;
}

export interface SplitResult {
  /**
   * **所有标的共享的部分**（全市场概览、账户、绩效、规则提示……）——
   * 它在第一个 `### N. ` 之前。
   */
  shared: string;
  /** 每个标的一段，**按原顺序**。 */
  slices: SymbolSlice[];
}

/**
 * 匹配候选标题：`### 1. STRKUSDT（ai_requested + coinpool — 多来源共振）`。
 *
 * ⚠️ 只认**行首**的 `### <数字>. ` —— 材料里可能有别的 `###`（例如事件卡），
 * 不加这个约束会把它们误切成标的。
 */
const HEADING = /^### (\d+)\. (\S+?)(?:（|\s*$)/;

/**
 * 把渲染好的 `marketContext` 按候选标的切成 N 份。
 *
 * @returns 切不出来（没有候选标题 / 只有 1 段）时 **`null`** ——
 *          调用方**必须退回原文**，而不是用空材料去问。
 */
export function splitMarketContext(marketContext: string): SplitResult | null {
  const lines = marketContext.split('\n');
  const heads: Array<{ line: number; symbol: string | null }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]!);
    if (m !== null) heads.push({ line: i, symbol: m[2] ?? null });
  }
  /* 少于 2 个标的没有拆分的意义（拆了也不会更小）。 */
  if (heads.length < 2) return null;

  const shared = lines.slice(0, heads[0]!.line).join('\n');
  const slices: SymbolSlice[] = [];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i]!.line;
    const to = i + 1 < heads.length ? heads[i + 1]!.line : lines.length;
    slices.push({ symbol: heads[i]!.symbol, text: lines.slice(from, to).join('\n') });
  }
  return { shared, slices };
}

/**
 * 把共享部分与一个标的的切片拼成**给某个 agent 的完整材料**。
 *
 * ⚠️ 共享部分必须带上：账户权益、绩效、规则提示都在那里 ——
 * 少了它，agent 会不知道"这个账户有多大"，而那正是它算风险预算的依据。
 */
export function composeSliceContext(shared: string, slice: SymbolSlice): string {
  return shared.length > 0 ? `${shared}\n\n${slice.text}` : slice.text;
}
