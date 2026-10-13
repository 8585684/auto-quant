/**
 * **消息面猎手**（2026-10-13）—— 用户需求 ①②⑤ 的落地。
 *
 * ## 用户的要求
 *
 * > 「总管委派子代理去做市场调研（查**新闻、各大交易所社区、社交媒体、
 * >  **新闻源**等等）根据资料反馈给相应的智能体做处理」
 * > 「有**调查新闻的**、有**监控社区的**、有**查市场情绪的**」
 *
 * ## 之前是什么样
 *
 * `manager.ts` 里是**一段提示词 + 一次 agent 调用**，任务是
 * "联网查这几个标的今天的新闻与市场情绪"。
 *
 * **一个 agent 覆盖不了多个信息源** —— 它一次只能沿一个方向查，
 * 而"新闻"与"社区情绪"与"资金流向"是**三种不同的证据**：
 * ```
 *   新闻   ：权威媒体、公告 —— 事实性强、更新慢、已定价
 *   社区   ：推特/交易所广场 —— 情绪强、噪音大、可能领先
 *   资金面 ：资金费率/持仓量/ETF 流向 —— 硬数据、无叙事
 * ```
 * 把它们交给一个人，结果必然是"**查了新闻就没查社区**"。
 *
 * ## 本文件做什么
 *
 * 把调研拆成**几个各有侧重的猎手**（并行跑），再把结果**按来源合并**。
 *
 * ⚠️ **合并时保留"这是谁说的"** —— 那是 `intel/freshness.ts` 的
 * 交叉验证要用的：它的判据是"**按域名去重、单一来源不进决策**"，
 * 而"域名"来自每条情报的 `sourceUrl`。若合并时把来源抹掉，
 * 交叉验证就退化成"看起来有多个来源"（而它们可能是同一条转发）。
 */

/** 一个猎手（= 一个侧重某个信息源的调研员）。 */
export interface HunterRole {
  /** 角色 id（用于日志与"谁没产出"的标注）。 */
  id: string;
  /** 中文名（给操作员看）。 */
  label: string;
  /** 它专查什么（写进提示词）。 */
  focus: string;
  /** 它应当优先使用的信息源。 */
  sources: readonly string[];
}

/**
 * **四个猎手** —— 覆盖用户点名的那些来源。
 *
 * ⚠️ 为什么是四个而不是更多：
 * · 每一个都要跑一次 harness agent（实测一次约 197 秒）；
 * · 它们**并行**跑，所以墙钟时间不叠加，但**并发数会叠加**；
 * · 而"再多一个'综合猎手'"没有独立的信息源 —— 那只是重复前四个。
 *
 * ⚠️ 顺序有意义：按"证据强度"从高到低。日志里谁先回来不重要，
 * 但合并时**硬数据排在叙事前面**（见 `mergeHunterReports`）。
 */
export const HUNTERS: readonly HunterRole[] = [
  {
    id: 'news_hunter',
    label: '新闻猎手',
    focus: '权威媒体的**已发生事实**：公告、监管、交易所动态、重大合作/事故',
    sources: ['路透/彭博/CoinDesk/TheBlock 等财经媒体', '交易所官方公告', '项目方官方渠道'],
  },
  {
    id: 'flow_hunter',
    label: '资金猎手',
    focus: '**硬数据**：资金费率、持仓量变化、ETF 净流入流出、大额转账/鲸鱼动向',
    sources: ['交易所资金费率与持仓量', 'ETF 资金流数据', '链上大额转账'],
  },
  {
    id: 'community_hunter',
    label: '社区猎手',
    focus: '**社区与社交**上的讨论热度与情绪倾向（注意区分"真实讨论"与"喊单"）',
    sources: ['X/Twitter', '交易所广场/评论区', 'Reddit、Telegram 公开频道'],
  },
  {
    id: 'macro_hunter',
    label: '宏观猎手',
    focus: '**影响风险偏好的宏观事件**：利率、通胀数据、股市、地缘',
    sources: ['宏观日历与经济数据', '美股/美债走势', '主流财经媒体宏观版'],
  },
];

/**
 * 给**一个猎手**写任务提示词（2026-10-13）。
 *
 * ⚠️ 四条共同纪律**每个猎手都要有**（它们都是实测踩出来的）：
 * ```
 *   ① 必须带来源链接 —— 没有链接的情报会被 `parseIntel` 丢掉（它要求 http(s)）
 *   ② 必须给发布时刻（`hoursAgo`）—— 时效衰减与 TTL 判据靠它
 *   ③ 查不到就说查不到 —— 不许用常识填充成"新闻"（那是本项目最忌讳的失败）
 *   ④ 输出 JSON（便于 `parseIntelReport` 解析；解析失败会退回原文）
 * ```
 */
export function buildHunterTask(hunter: HunterRole, symbols: readonly string[]): string {
  return (
    `你是量化机构的「${hunter.label}」。请联网调研这几个标的**今天**的情况：${symbols.join('、')}。\n\n` +
    `## 你专查什么\n${hunter.focus}\n\n` +
    `## 优先看这些来源\n${hunter.sources.map((s) => `- ${s}`).join('\n')}\n\n` +
    '## 纪律（必须遵守）\n' +
    '1. **只写你真实查到的**。查不到就明确说"本次没有查到相关消息" —— ' +
    '**不要用常识或推测填充成"新闻"**（那会让下游把它当成事实）。\n' +
    '2. 每条消息都要给**来源链接**（http/https 完整地址）。\n' +
    '3. **`hoursAgo` 必须是数字**（不是字符串、不写"约"字）。它决定这条消息还算不算数：\n' +
    '   · **超过 48 小时的消息会被系统判为过期并丢弃** —— 所以只报**最近 48 小时内**的；\n' +
    '   · 你查到的多数东西可能是几天前的旧闻，**那些不要报**（报了也不会被采用）；\n' +
    '   · 如果最近 48 小时内确实没有任何消息，就输出空数组 `[]` —— **那是正确答案**。\n' +
    '4. 说明它对价格的方向含义：利多 / 利空 / 中性。\n\n' +
    '## 输出格式（严格 JSON 数组，不要写别的）\n' +
    '```json\n' +
    '[\n' +
    '  {\n' +
    '    "summary": "一句话说清发生了什么",\n' +
    '    "sourceUrl": "https://…（真实链接，不要编）",\n' +
    '    "direction": "bullish | bearish | neutral",\n' +
    '    "symbols": ["BTCUSDT"],\n' +
    '    "hoursAgo": 3\n' +
    '  }\n' +
    ']\n' +
    '```\n' +
    '⚠️ `hoursAgo` 是**数字**（`3` 而不是 `"3"`、不是 `"约3小时"`）——\n' +
    '类型不对那一条会被整条丢弃。\n' +
    '**查不到任何东西时输出空数组 `[]`** —— 那是正确答案，不是失败。'
  );
}

/** 一个猎手的产出（含"它是否成功"）。 */
export interface HunterReport {
  hunterId: string;
  label: string;
  ok: boolean;
  text: string;
  error?: string;
  latencyMs: number;
}

/**
 * **合并各猎手的产出**（2026-10-13）。
 *
 * ## 三条设计约束
 *
 * ### ① **每个猎手都要出现**，包括失败的
 *
 * ⚠️ 若把失败者静默丢掉，`newscaster` 会以为"社区上没有任何讨论"——
 * 而事实是"**社区猎手没跑成**"。**那是看不见的失败**（本项目反复强调）。
 *
 * ### ② 失败时**不能假装成功**
 *
 * 产出里写的是"（本次未产出：<原因>）"而不是空字符串 ——
 * 空字符串在下游看起来与"查了但没查到"一模一样。
 *
 * ### ③ **保留来源块**
 *
 * 每条情报的原始 `sourceUrl` 必须原样带过去 ——
 * `intel/freshness.ts` 的交叉验证是**按域名去重**的。
 */
export function mergeHunterReports(reports: readonly HunterReport[]): string {
  if (reports.length === 0) return '';
  const okCount = reports.filter((r) => r.ok).length;
  const lines: string[] = [
    `## 消息面调研（${okCount}/${reports.length} 个猎手有产出）`,
    '',
  ];
  for (const r of reports) {
    lines.push(`### ${r.label}（${r.hunterId}）`);
    if (r.ok) {
      lines.push(r.text.trim().length > 0 ? r.text.trim() : '（本次未查到相关消息）');
    } else {
      /*
       * ⚠️ 必须**显式写出失败** —— 那是"这个来源本轮缺失"的唯一证据。
       */
      lines.push(`（本次**未产出**：${r.error ?? '未知原因'}）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * **给下游的一句话小结** —— 让 `newscaster` 一眼看到"哪几个来源是缺的"。
 *
 * ⚠️ 为什么单独给这一句：`mergeHunterReports` 的正文很长，
 * 而"有几个来源没产出"是**决策时必须知道的前提**
 *（"社区上没有讨论"与"社区猎手挂了"是两件完全不同的事）。
 */
export function summariseHunters(reports: readonly HunterReport[]): string {
  const failed = reports.filter((r) => !r.ok);
  if (failed.length === 0) {
    return `${reports.length} 个来源全部有产出。`;
  }
  return (
    `${reports.length} 个来源中 **${failed.length} 个未产出**：` +
    `${failed.map((r) => r.label).join('、')} —— ` +
    '**它们的空白不等于"那边没有任何消息"**，请勿据此推断。'
  );
}
