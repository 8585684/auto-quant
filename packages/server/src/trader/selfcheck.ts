/**
 * **自检** —— 让系统自己发现问题（用户需求 #6）。
 *
 * ## 用户的原始要求（这是本文件存在的理由）
 *
 * > 「你迭代更新系统得搞智能体团队**持续观察、测试**，然后反馈给你做相应得处理，
 * >  **不要有任何 BUG，也不要老让我来测试和发现问题，你要自己发现问题自己解决**」
 *
 * > 「本地开发 + 服务器运行都要有 **AI 自检、问题留痕**，下次我唤醒你的时候
 * >  你就能直接查看快速定位、迭代」
 *
 * ## 为什么分两层（确定性 + AI）
 *
 * | 层 | 抓什么 | 需要模型吗 |
 * |---|---|---|
 * | **确定性** | 失败轮次、错误日志、数据断流、额度耗尽 | **不需要** |
 * | **AI** | "这些现象连起来意味着什么"、"下一步该查哪" | 需要 |
 *
 * 第一层必须**不依赖模型**：模型本身出问题时（额度尽、网关挂），
 * 恰恰是最需要自检的时候 —— 如果自检也要模型，那它在那时**正好失效**。
 *
 * ## 留痕的形态
 *
 * 发现写进 `runtime_logs`，`scope` 用 `selfcheck` —— 于是：
 *   · 界面上能按 scope 过滤看到（用户要"看得见"）；
 *   · 我（开发侧）下次被唤醒时能直接查（用户要"下次你就能快速定位"）。
 *
 * ## 刻意不做的事
 *
 * **不自动改代码、不自动改参数。** 自检的输出是**发现**，不是**修复**。
 * 自动修复是另一件事（见设计文档 §S6 的分期），而它需要更硬的护栏 ——
 * 一个能自己改代码的系统在无人值守时是**不可控**的。
 */

/** 自检收集到的**事实**（都是可数的，不是判断）。 */
export interface SelfCheckEvidence {
  /** 统计窗口（小时）。 */
  windowHours: number;
  /** 窗口内的失败决策轮次（含错误摘要）。 */
  failedCycles: Array<{ cycleNumber: number; error: string; at: string }>;
  /** 窗口内的错误级日志（按 scope 归类后的计数）。 */
  errorLogsByScope: Array<{ scope: string; count: number; sample: string }>;
  /** 窗口内的警告级日志（按 scope 归类后的计数）。 */
  warnLogsByScope: Array<{ scope: string; count: number; sample: string }>;
  /** 连续失败次数（决策循环的熔断计数）。 */
  consecutiveFailures: number;
  /** 距上一次成功决策过了多少分钟（`null` = 从来没有成功过）。 */
  minutesSinceLastSuccess: number | null;
  /** 该机器人配置的决策周期（分钟）—— 用来判断"多久算不正常"。 */
  cycleIntervalMinutes: number;
  /** 待结算的参数实验数（长期不结算 = 自我迭代那一环卡住了）。 */
  pendingExperiments: number;
  /** 累计角色运行次数（判断"这个机器人到底跑过没有"）。 */
  totalRuns: number;
}

/**
 * **从证据里直接得出的发现**（不需要模型）。
 *
 * ## 为什么这一层是主力
 *
 * 用户要的是"自己发现问题"，而**大部分真实故障是确定性的**：
 * 连着失败、错误日志刷屏、数据断流、实验长期不结算 —— 这些不需要判断力，
 * 只需要**有人去数**。而"有人去数"正是原来自检缺的那一环。
 *
 * 模型层（`runSelfCheck`）的价值在于**把几条线索连起来**
 *（"模型降级次数高 + 延迟高 → 首选额度可能尽了"），而不是数数。
 */
export interface DeterministicFinding {
  /** 严重程度（界面按这个排序）。 */
  severity: 'critical' | 'warning' | 'info';
  /** 一句话结论。 */
  title: string;
  /** 证据（具体数字，便于核对 —— 用户要求"快速定位"）。 */
  detail: string;
  /** 建议下一步查什么。 */
  nextStep: string;
}

/**
 * 数出确定性的问题。
 *
 * ⚠️ **阈值都是"相对"的，不是拍脑袋的绝对数**：
 * 例如"多久没成功算异常"用**配置的周期**去比（`minutesSinceLastSuccess`
 * 是周期的几倍），而不是写死"30 分钟"—— 因为周期本身可以由 AI 调整
 *（1–120 分钟），写死会让长周期的机器人**一直被误报**。
 */
export function findDeterministicProblems(e: SelfCheckEvidence): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];

  /* ① 连续失败 —— 最严重的（决策循环已经熔断了）。 */
  if (e.consecutiveFailures >= 3) {
    out.push({
      severity: 'critical',
      title: `决策连续失败 ${e.consecutiveFailures} 次`,
      detail:
        `最近 ${e.windowHours} 小时内有 ${e.failedCycles.length} 轮失败。` +
        (e.failedCycles[0] ? `最近一次：${e.failedCycles[0].error}` : ''),
      nextStep: '查模型网关额度与连通性（`/v1/magpie/quotas`），再看是否有单模型被限流',
    });
  }

  /* ② 长时间没有成功决策 —— 用**周期倍数**判断，避免长周期机器人被误报。 */
  if (e.minutesSinceLastSuccess !== null && e.cycleIntervalMinutes > 0) {
    const ratio = e.minutesSinceLastSuccess / e.cycleIntervalMinutes;
    if (ratio >= 3) {
      out.push({
        severity: 'critical',
        title: `已 ${Math.round(e.minutesSinceLastSuccess)} 分钟没有成功决策（约 ${ratio.toFixed(1)} 个周期）`,
        detail: `配置周期 ${e.cycleIntervalMinutes} 分钟。超过 3 个周期没成功说明循环可能卡住了。`,
        nextStep: '看 `runtime_logs` 里 `trader` scope 的最后几条，确认是卡住还是被跳过',
      });
    } else if (ratio >= 2) {
      out.push({
        severity: 'warning',
        title: `已 ${Math.round(e.minutesSinceLastSuccess)} 分钟没有成功决策（约 ${ratio.toFixed(1)} 个周期）`,
        detail: `配置周期 ${e.cycleIntervalMinutes} 分钟。`,
        nextStep: '观察下一轮是否恢复；连续两轮不恢复再查',
      });
    }
  }

  /* ③ 从来没成功过 —— 新机器人配置错的典型形状。 */
  if (e.minutesSinceLastSuccess === null && e.totalRuns === 0 && e.failedCycles.length > 0) {
    out.push({
      severity: 'warning',
      title: '这个机器人从来没有成功决策过',
      detail: `${e.windowHours} 小时内有 ${e.failedCycles.length} 轮失败、0 轮成功。`,
      nextStep: '优先查配置（候选标的、策略）与模型可用性 —— 这类问题通常是"一出生就坏"',
    });
  }

  /* ④ 错误日志刷屏（按 scope 归类，避免同一问题重复报几十条）。 */
  for (const s of e.errorLogsByScope) {
    if (s.count >= 3) {
      out.push({
        severity: 'warning',
        title: `${s.scope} 有 ${s.count} 条错误日志`,
        detail: `最近一条：${s.sample}`,
        nextStep: `按 scope \`${s.scope}\` 过滤日志看完整上下文`,
      });
    }
  }

  /* ⑤ 参数实验长期不结算 —— "自我迭代"那一环卡住了（用户需求 #F）。 */
  if (e.pendingExperiments >= 5) {
    out.push({
      severity: 'warning',
      title: `${e.pendingExperiments} 个参数实验还没结算`,
      detail: '实验要靠后续成交回填结果；长期不结算说明"改了参数却不知道有没有用"。',
      nextStep: '确认回填逻辑是否还在跑（`agent_experiments.outcome_*` 是否在更新）',
    });
  }

  /*
   * ⑥ 什么都没发现 —— **也要给一条 info**。
   *
   * 静默返回空数组会让"自检跑了但没发现"与"自检根本没跑"长得一模一样。
   * 那正是本项目反复踩的"看不出异常的失败"。
   */
  if (out.length === 0) {
    out.push({
      severity: 'info',
      title: '未发现确定性问题',
      detail: `窗口 ${e.windowHours} 小时：失败 ${e.failedCycles.length} 轮、错误日志 ${e.errorLogsByScope.reduce((a, b) => a + b.count, 0)} 条、连续失败 ${e.consecutiveFailures} 次。`,
      nextStep: '无需处理',
    });
  }

  return out;
}

/**
 * 把证据渲染成给模型看的文本。
 *
 * 只给**事实**，不给结论 —— 结论让模型自己下（否则就是"我把答案塞给它"，
 * 那不算自检）。但事实要**给全**，包括"看起来正常"的那些：
 * 模型需要基线才能判断"3 条错误日志算多吗"。
 */
export function renderEvidenceForModel(e: SelfCheckEvidence): string {
  const lines: string[] = [];
  lines.push(`# 自检窗口：最近 ${e.windowHours} 小时`);
  lines.push('');
  lines.push('## 决策循环');
  lines.push(`- 失败轮次：${e.failedCycles.length}`);
  for (const f of e.failedCycles.slice(0, 5)) {
    lines.push(`  - 周期 #${f.cycleNumber}（${f.at}）：${f.error}`);
  }
  lines.push(`- 连续失败计数：${e.consecutiveFailures}`);
  lines.push(
    `- 距上次成功：${e.minutesSinceLastSuccess === null ? '从未成功过' : `${Math.round(e.minutesSinceLastSuccess)} 分钟`}`,
  );
  lines.push(`- 配置周期：${e.cycleIntervalMinutes} 分钟`);
  lines.push('');
  lines.push('## 日志（按来源归类）');
  if (e.errorLogsByScope.length === 0) lines.push('- 没有错误级日志');
  for (const s of e.errorLogsByScope) {
    lines.push(`- [error] ${s.scope} × ${s.count}；最近：${s.sample}`);
  }
  for (const s of e.warnLogsByScope) {
    lines.push(`- [warn] ${s.scope} × ${s.count}；最近：${s.sample}`);
  }
  lines.push('');
  lines.push('## 智能体运行');
  lines.push(`- 累计运行次数：${e.totalRuns}`);
  lines.push(`- 待结算参数实验：${e.pendingExperiments}`);
  return lines.join('\n');
}

/** 模型给出的自检发现。 */
export interface AiFinding {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  nextStep: string;
}

/**
 * 解析模型的自检输出。
 *
 * ## 容错口径
 *
 * 模型的输出**可能不合格式**。而这里与风控官不同 —— 自检的输出是
 * **给人看的报告**，不是**要执行的动作**。所以解析失败时：
 *
 *   · **不编造发现**（返回空数组）；
 *   · 但**保留原文**（让上层把它当作"未结构化的观察"存下来）。
 *
 * 为什么保留原文：用户要的是"下次唤醒时能快速定位" ——
 * 一段没解析成功的原文仍然比"什么都没有"有用得多。
 */
export function parseAiFindings(text: string): { findings: AiFinding[]; raw: string } {
  const raw = text.slice(0, 4_000);
  const findings: AiFinding[] = [];

  /*
   * 期望格式（在提示词里写明）：每行一条
   *   `[严重度] 标题 :: 证据 :: 下一步`
   *
   * 用行解析而不是 JSON：自检报告天然是**散文**，
   * 强制 JSON 会让模型为了格式牺牲内容（而内容才是自检的价值）。
   */
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]?\s*\[(critical|warning|info|严重|警告|提示)\]\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const rawSeverity = m[1]!.toLowerCase();
    const severity: AiFinding['severity'] =
      rawSeverity === 'critical' || rawSeverity === '严重'
        ? 'critical'
        : rawSeverity === 'warning' || rawSeverity === '警告'
          ? 'warning'
          : 'info';
    const parts = m[2]!.split('::').map((p) => p.trim());
    findings.push({
      severity,
      title: (parts[0] ?? '').slice(0, 200),
      detail: (parts[1] ?? '').slice(0, 600),
      nextStep: (parts[2] ?? '').slice(0, 300),
    });
  }

  return { findings, raw };
}
