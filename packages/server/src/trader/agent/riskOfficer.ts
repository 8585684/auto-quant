/**
 * **风控官关卡** —— 团队模式里"谁来负责风格"（用户需求 #3）。
 *
 * ## 用户的原始要求（这是本文件存在的理由）
 *
 * > 「**系统不再设置内置风控**（我的想法是既然都要做这么智能了，那么**风格也应该由
 * >  一个智能体来负责**，而不是系统内置简单风控规则）」
 *
 * ## 我必须说清的取舍：**不能全部交给智能体**
 *
 * 调研有硬证据反对"把风控完全交给 LLM"：
 *
 * | 证据 | 出处 |
 * |---|---|
 * | 让"最终决定权由代码强制"比交给 LLM 高 **+9.4%** 任务成功率 | MAST 分类法实测（arXiv:2503.13657）|
 * | 真实机构的风控是**硬性否决**，不是建议 | Millennium 的中央风控设硬停 |
 * | TradingAgents 的风控**只输出建议** —— 那等于没有风控 | 该项目自身的拓扑 |
 *
 * 把"保证金够不够"交给一个**会幻觉**的东西判断，等于把爆仓风险交给运气。
 *
 * ## 所以做成**两层**（这是用户意图与技术现实的交集）
 *
 * ```
 *   ① 裁决官给出提案（团队讨论的结论）
 *        ↓
 *   ② 【智能体层】风控官审阅 —— 仓位大小、集中度、回撤容忍、"现在该不该收手"
 *        ↓  它可以否决、削减、或放行
 *   ③ 【代码层】RiskEngine 物理底线 —— 保证金足够、数量可交易、止损存在
 *        ↓  它**不可被绕过**
 *   ④ 执行
 * ```
 *
 * **用户要的"智能风格"由第 ② 层给**（那是真正需要判断力的部分），
 * 而第 ③ 层只挡**物理与合规的底线**（那部分交给 LLM 是拿爆仓换"智能"）。
 *
 * ## 为什么两层而不是只留智能体层
 *
 * 智能体层的输出**也是文本**，可能解析失败、可能被幻觉影响。
 * 代码层是**兜底**：即使风控官说"重仓没问题"，交易所也只会按保证金拒绝 ——
 * 但那时已经是"下单失败"而不是"被拦下"，体验与安全都更差。
 */

import { isCloseAction, type Decision, type DecisionAction } from '@aq/shared';

/** 风控官的裁决。 */
export interface RiskOfficerVerdict {
  /** 它是否放行。 */
  approved: boolean;
  /** 它是否想削减（而不是全盘否决）。 */
  reduced: boolean;
  /** 削减后的决策（`reduced` 为真时有值）。 */
  adjusted: Decision[] | null;
  /** 它给的理由（**必须落到日志** —— 用户要求看得见"为什么"）。 */
  reason: string;
  /** 它担心的主要风险（可空）。 */
  concern: string | null;
}

/**
 * **解析风控官的输出**。
 *
 * ## 为什么必须容错
 *
 * 风控官的输出是模型文本，**可能不合格式**。而"解析失败"在这一层是**安全攸关**的：
 *
 * · 失败时**不能当成"它批准了"** —— 那等于没有风控；
 * · 失败时也**不能直接全部否决** —— 那会让一次格式抖动变成"机器人停止交易"。
 *
 * 所以采用**保守但不停摆**的策略：解析失败 → **只放行"降低风险"的动作**
 *（平仓、减仓、调保护位），**拦住"增加风险"的动作**（开仓、加仓）。
 *
 * 这个方向是明确的：**看不清楚的时候，宁可少冒险。**
 */
export function parseRiskOfficerVerdict(text: string, decisions: readonly Decision[]): RiskOfficerVerdict {
  /*
   * ⚠️ **`同意` 必须用否定前瞻** —— 否则「不**同意**」会被当成批准（实测踩到）。
   *
   * 这是**安全攸关**的误判：风控官说"我不同意这个仓位"，
   * 而代码读成"同意" → **照单放行** → 等于这一层根本不存在。
   *
   * 第一版就是这个 bug：`/批准|放行|同意/` 匹配了"不同意"里的"同意"，
   * 于是 `approve` 与 `reject` **同时为真**，而分支顺序让 approve 先赢。
   *
   * 修法两处一起：
   *   ① `同意` 前面加 `(?<!不)` —— 不让"不同意"贡献 approve；
   *   ② **否决优先**（见下面的分支顺序）—— 双真时以否决为准。
   *      对风控来说"宁可拦下"是正确方向。
   */
  const approve = /批准|放行|(?<!不)同意|approved|approve/i.test(text);
  /* ⚠️ 必须包含「不同意」—— 实测模型常用这个词，而它不含「否决」也不含「拒绝」。 */
  const reject = /否决|拒绝|不同意|不批准|rejected|reject|denied/i.test(text);
  const reduce = /削减|减半|降低仓位|reduce/i.test(text);

  /* 理由：取第一行非空文本（模型的结论通常在开头）。 */
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['));
  const reason = (firstLine ?? '（风控官未给出理由）').slice(0, 300);

  /* 担心点：找含"风险/担心/不确定"的那一句。 */
  const concernLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /风险|担心|不确定|隐患/.test(l));
  const concern = concernLine === undefined ? null : concernLine.slice(0, 300);

  /*
   * ⚠️ **否决优先**（`reject` 为真就拦，不管 `approve` 是否也为真）。
   *
   * 第一版写的是 `reject && !approve` —— 那让"同时出现批准与否决"时**放行**。
   * 而风控的方向应该是**宁可拦下**：双真意味着模型的表态自相矛盾
   *（或者我的正则又误判了），那种情况下放行是最坏的选择。
   *
   * 纵深防御：正则已经修好了（`(?<!不)同意`），但**判断顺序也要对** ——
   * 两个都修，任一个出问题都还有另一个兜着。
   */
  if (reject) {
    return { approved: false, reduced: false, adjusted: null, reason, concern };
  }
  if (approve || reduce) {
    return { approved: true, reduced: reduce, adjusted: reduce ? reduceDecisions(decisions) : null, reason, concern };
  }

  /*
   * **既没说批准也没说否决**（格式不合）→ 保守策略。
   *
   * 只放行"降低风险"的动作，拦住"增加风险"的。
   * 这样一次格式抖动不会让机器人停摆（平仓照常能做），
   * 也不会让它在这种情况下加仓。
   */
  const safe = decisions.filter((d) => isRiskReducing(d.action));
  return {
    approved: safe.length > 0,
    reduced: safe.length !== decisions.length,
    adjusted: safe.length === decisions.length ? null : safe,
    reason: `${reason}（未能识别风控官的表态，按保守策略只放行降低风险的动作）`,
    concern,
  };
}

/**
 * 这个动作是"降低风险"的吗。
 *
 * ## ⚠️ 为什么必须用共享包的判定，而不是自己写字符串列表
 *
 * 第一版我手写了 `action === 'close_position'` —— **而那个动作名根本不存在**
 *（真实值是 `close_long` / `close_short`）。后果很严重且很隐蔽：
 *
 * · `isRiskReducing` 对**所有真实平仓动作都返回 false**；
 * · 于是"表态不明时的保守策略"会把**平仓也拦住** ——
 *   而那是风控官最不该拦的东西（看不清楚时该允许降低风险，不是禁止）。
 *
 * 类型检查抓到了它（`'close_position'` 与联合类型无交集），
 * 但**只因为共享包里已经有 `DecisionAction` 联合类型**。
 * 用现成的谓词（`isCloseAction`）就不可能有这个错。
 *
 * 这就是"不重复造轮子"在**类型安全**上的具体价值。
 */
function isRiskReducing(action: DecisionAction): boolean {
  return isCloseAction(action) || action === 'reduce_position' || action === 'adjust_protection';
}

/**
 * 削减决策的仓位 —— **只动"规模"，不动方向**。
 *
 * ## 为什么只削规模
 *
 * 风控官说"仓位太大"时，它表达的是**规模**问题，不是方向问题。
 * 去改方向（把 `open_long` 改成 `open_short`）是**越权** ——
 * 那推翻了裁决官的结论，而裁决官才是做方向判断的那个人。
 *
 * ## 削减比例固定 50%（而不是让模型给一个数）
 *
 * "减半"是**可审计的、确定的**规则；让模型给数字会引入
 * "它说减到 30% 但我解析错了"的风险。要更精细就多削一次，而不是让它写小数。
 *
 * ## 削哪些
 *
 * **只削"增加风险"的动作**（开仓 / 加仓）—— 那才是"仓位太大"指的东西。
 * 平仓、减仓、调保护位是**降低风险**的，削它们等于让风控官帮倒忙
 *（把"该减的仓"减得更少）。
 */
function reduceDecisions(decisions: readonly Decision[]): Decision[] {
  return decisions.map((d) => {
    /* 降低风险的动作原样保留 —— 削减它们等于让仓位更危险。 */
    if (isRiskReducing(d.action)) return d;

    const next: Decision = { ...d };
    if (typeof next.positionSizeUsd === 'number') {
      next.positionSizeUsd = next.positionSizeUsd / 2;
    }
    if (typeof next.riskUsd === 'number') {
      next.riskUsd = next.riskUsd / 2;
    }
    /*
     * 在理由里**标明这是被削减过的** —— 否则事后看记录会以为
     * "AI 当时就想开这么小的仓"，而真相是风控官削了一半。
     * 审计的可信度靠这种痕迹。
     */
    next.reasoning = `[风控官削减 50%] ${next.reasoning ?? ''}`.trim();
    return next;
  });
}
