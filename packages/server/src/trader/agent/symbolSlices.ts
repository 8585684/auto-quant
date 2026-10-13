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
  /**
   * **这个候选是从哪个来源进来的**（`ai_requested` / `coinpool` / `static` …）。
   *
   * ## ⚠️ 为什么要在切分时顺手解析，而不是让消费者再从文本猜一次
   *
   * 2026-10-13 的实测教训：`tradingDesk` 需要"按来源分层取样"（否则
   * `ai_requested` 会占满前 N 个名额、把整个 `coinpool` 挤掉）——
   * 而第一版我把来源解析写在了**消费者**里（`analystSampling.parseSliceSources`），
   * 它用正则从 `text` 里再抠一次标题。
   *
   * 结果：**测试里的最小材料没写序号**（`### GTCUSDT（…）` 而不是
   * `### 1. GTCUSDT（…）`）→ 解析失败 → 分层退化成"按顺序取"
   * → 正是要避免的那个 BUG 原地复活，而且**只在特定格式下复活**。
   *
   * **根因是"同一件事算两遍"** —— 而本项目对这件事有明确的教训
   *（`prompt.ts` 里 `quantity` 曾由两条路径各算一次导致真实拒单）。
   * 所以：**在唯一解析标题的地方（`splitMarketContext`）一次算出**，
   * 消费者直接用字段，不再解析文本。
   *
   * ⚠️ 解析不出时是**空数组**（而不是 `['unknown']`）——
   * 让消费者能区分"没有来源信息"与"来源就是 unknown"。
   */
  sources: string[];
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
 * 从标题行里解析**来源**（括号里 `+` 分隔的那些）。
 *
 * ```
 *   ### 1. GTCUSDT（ai_requested）                        → ['ai_requested']
 *   ### 7. BTCUSDT（coinpool + reference — 多来源共振）    → ['coinpool', 'reference']
 * ```
 * ⚠️ 只认**行首**的 `###`（与 `HEADING` 同一约束），避免把正文里的
 * `###` 或括号内容误当标题。
 */
const HEADING_SOURCES = /^### \d+\. \S+?（([^）]*)）/;

function parseSourcesOf(line: string): string[] {
  const m = HEADING_SOURCES.exec(line);
  if (m === null) return [];
  return String(m[1])
    .split('+')
    .map((s) => (s.split('—')[0] ?? '').replace(/多来源共振.*$/, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * 把渲染好的 `marketContext` 按候选标的切成 N 份。
 *
 * @returns 切不出来（没有候选标题 / 只有 1 段）时 **`null`** ——
 *          调用方**必须退回原文**，而不是用空材料去问。
 */
export function splitMarketContext(marketContext: string): SplitResult | null {
  const lines = marketContext.split('\n');
  const heads: Array<{ line: number; symbol: string | null; sources: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]!);
    if (m !== null) {
      heads.push({ line: i, symbol: m[2] ?? null, sources: parseSourcesOf(lines[i]!) });
    }
  }
  /* 少于 2 个标的没有拆分的意义（拆了也不会更小）。 */
  if (heads.length < 2) return null;

  const shared = lines.slice(0, heads[0]!.line).join('\n');
  const slices: SymbolSlice[] = [];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i]!.line;
    const to = i + 1 < heads.length ? heads[i + 1]!.line : lines.length;
    slices.push({
      symbol: heads[i]!.symbol,
      text: lines.slice(from, to).join('\n'),
      /* ⚠️ 来源在**这里**一次算出（见 `SymbolSlice.sources` 的说明）。 */
      sources: heads[i]!.sources,
    });
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

/**
 * **把"标签: [一长串数字]"的行裁成只留最后几个点**（2026-10-12）。
 *
 * ## 为什么需要它（实测数据）
 *
 * 单个标的的材料 **11,983 字符**，而其中绝大部分是原始 K 线数组：
 * ```
 *   === 5M 周期（由旧到新）===
 *   价格: [0.104560, 0.104520, 0.104670, ... 共 30 个]
 *   成交量: [1, 2, 3, ... 共 30 个]
 *   （还有 15M / 1H / 4H，各若干序列）
 * ```
 * 而**每个标的的 headline 已经给了所有关键指标的最新值**
 *（`current_ema20` / `current_macd` / `current_rsi7` / `current_atr14` / `24h_change`）。
 *
 * ## 为什么是"保留最后 N 个"而不是"整行删掉"
 *
 * 形态判断（`technical` 的任务）需要**最近几根的走向** ——
 * 整行删掉会让它只能看最新值，看不出"正在往上还是往下"。
 * 而 30 个点里真正被用来判形态的是**最后几根**。
 *
 * ## ⚠️ 安全性：只动"短标签 + 数字列表"这一种行
 *
 * 正则要求**行首（可缩进）+ 短标签（≤20 字符，不含 `:` 与 `[`）+ `: [` … `]` + 行尾**。
 * 正文段落、事件卡、表格都不会匹配 —— 所以它**不会误伤散文**。
 *
 * ⚠️ 点数不足 `keepLast` 时**原样返回**（不做无意义改写）。
 *
 * @param keepLast 每个序列保留最后几个点（默认 5）
 */
export function compactSeriesLines(text: string, keepLast = 5): string {
  return text.replace(
    /^([ \t]*)([^:[\n]{1,20}): \[([^\]]*)\][ \t]*$/gm,
    (full: string, indent: string, label: string, body: string) => {
      const nums = body.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (nums.length <= keepLast) return full;
      const omitted = nums.length - keepLast;
      return `${indent}${label}: […省略前 ${omitted} 个…, ${nums.slice(-keepLast).join(', ')}]`;
    },
  );
}

/**
 * **把"全市场概览"那一段裁短**（2026-10-12）。
 *
 * ## 为什么它值 15k 字符
 *
 * 实测共享部分 18,690 字符，其中 **15k 是这一段**：
 * ```
 *   全市场概览（币安 525 个 USDT 永续，按 24h 成交额降序）
 *   **这不是候选池** —— 每条只有符号、价格、24h 涨跌、24h 成交额……
 *   BTCUSDT 82969.80 -0.07% 10.8B
 *   ETHUSDT 2533.62 +1.21% 8.8B
 *   ...（525 行）
 * ```
 *
 * ## 为什么"分析师"不需要它全部
 *
 * 它的用途是"**看见整个市场，发现值得深看的标的**" —— 那是**选币阶段**的活。
 * 而团队模式里，**候选池已经由代码筛好了**（漏斗 → 候选），
 * 分析师的任务是"分析给它的这些标的"。
 *
 * ⚠️ 而**保留前 N 行**是有意义的：成交额降序 → 前 N 行就是"市场头部在动什么"，
 * 那是分析师判断"大盘状态"（`market_analyst` 的任务）真正需要的部分。
 *
 * ⚠️ **必须显式写出"省略了多少行"** —— 否则模型会以为市场只有这 N 个标的，
 * 那是**制造一个假事实**（本项目明确禁止：宁可说"截断了"，不能让它误以为完整）。
 *
 * @param keepRows 保留前多少行（默认 60）
 */
export function compactUniverseOverview(text: string, keepRows = 60): string {
  /*
   * 概览行的形状：`SYMBOL 价格 涨跌% 成交额`（四段、空格分隔）。
   *
   * ⚠️⚠️ **这里连踩两个坑，都值得写下来**（2026-10-12）：
   *
   * ### 坑 1：币名最短 1 个字符
   *
   * 我第一版写 `[A-Z0-9]{2,20}`，而实测币安有 `WUSDT`（币名 `W`）——
   * 它不匹配 → **扫描循环在那里 break** → 整个裁剪静默失效（15k 没省）。
   *
   * ### 坑 2：**币安有中文币名**
   *
   * 改成 `{1,20}` 之后仍然只裁到 90 行（应裁 525）。真凶在这一行：
   * ```
   *   币安人生USDT 0.589600 -4.36% 27M
   * ```
   * **`币安人生` 是中文** —— 而 `[A-Z0-9]` 永远匹配不到它。
   *
   * ### 结论：**不要假设符号是 ASCII**
   *
   * 现在用"**以 `USDT` 结尾、且不含空格**的符号段"，配合后面的
   * "价格 + 涨跌% + 成交额"三段 —— 形状足够特异，不会误伤散文。
   */
  const isRow = (line: string): boolean =>
    /^\S{1,30}USDT\s+\S+\s+[+-]?\d+(?:\.\d+)?%\s+\S+$/.test(line.trim());
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes('全市场概览'));
  if (idx < 0) return text;
  /* 从标题往下找连续的数据行。 */
  let start = -1;
  let end = -1;
  for (let i = idx; i < lines.length; i++) {
    if (isRow(lines[i]!)) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0 && lines[i]!.trim().length > 0) {
      break;
    }
  }
  if (start < 0 || end - start + 1 <= keepRows) return text;
  const total = end - start + 1;
  const kept = lines.slice(start, start + keepRows);
  const omitted = total - keepRows;
  return [
    ...lines.slice(0, start),
    ...kept,
    `…（省略其余 ${omitted} 个标的 —— 完整的 ${total} 个见"全市场概览"原始列表。` +
      `需要看某个没列出来的标的，就用它的完整序列去分析。）`,
    ...lines.slice(end + 1),
  ].join('\n');
}

/**
 * **给"分析师"用的紧凑材料**（2026-10-12）—— 接线用的总入口。
 *
 * ## 与 `splitMarketContext` 的分工
 *
 * · `splitMarketContext` 回答"**这是哪个标的的材料**"；
 * · `compactSeriesLines` 回答"**K 线序列怎么变小**"；
 * · `compactUniverseOverview` 回答"**525 行概览怎么变小**"。
 *
 * 这个函数把三者串起来。**先切分再压缩** ——
 * 顺序很重要：先切分能让"共享部分"只压一次（而不是每个标的各压一遍）。
 *
 * ## 实测效果（真实材料）
 *
 * ```
 *   原文              130,917 字符
 *   切分 + 压缩序列   单片 22,458（小 5.8 倍）
 *   再压全市场概览    预计再省 ~13k
 * ```
 *
 * ⚠️ **切不出来时返回 `null`** —— 调用方必须退回原文（与 `splitMarketContext` 同一纪律）。
 */
export function compactMarketContext(
  marketContext: string,
  keepLast = 5,
  keepUniverseRows = 60,
): { shared: string; slices: SymbolSlice[] } | null {
  const split = splitMarketContext(marketContext);
  if (split === null) return null;
  return {
    shared: compactUniverseOverview(compactSeriesLines(split.shared, keepLast), keepUniverseRows),
    /*
     * ⚠️ **`sources` 必须原样带过来**（2026-10-13）。
     *
     * 它是"按来源分层取样"的唯一依据（见 `SymbolSlice.sources` 的说明）——
     * 在这里漏掉它，`pickForAnalysis` 就会把每个切片都当成"来源未知"，
     * 于是**退化成"按顺序取前 N 个"**：`ai_requested` 又会占满名额、
     * 把整个 `coinpool` 挤掉，也就是这个 BUG 原地复活。
     *
     * ⚠️ 而它**不会**被 `compactSeriesLines` 影响（那是逐行压 K 线，
     * 标题行原样保留）—— 所以带的是 `s.sources`，不是重新解析的结果。
     */
    slices: split.slices.map((s) => ({
      symbol: s.symbol,
      text: compactSeriesLines(s.text, keepLast),
      sources: s.sources,
    })),
  };
}
