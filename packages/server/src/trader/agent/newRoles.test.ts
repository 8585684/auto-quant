/**
 * **用户需求 ⑤ 点名的三个岗位必须真的存在**（2026-10-13）。
 *
 * ## 用户的原话
 *
 * > 「有主管、分析账户的，有调查新闻的、有监控社区的、有查市场情绪的、
 * >  **有维护系统的程序员、有汇报工作的、有文员**、有交易员、有风控员等等
 * >  一切专业交易所量化机构有的我们都要有」
 *
 * ## 实测对照（缺三个）
 *
 * ```
 *   ✅ 主管          → supervisor
 *   ✅ 分析账户      → market_analyst / performance_analyst
 *   ✅ 调查新闻      → newscaster + 新闻猎手
 *   ✅ 监控社区      → 社区猎手（调研层）
 *   ✅ 查市场情绪    → sentiment
 *   ❌ 维护系统的程序员 → **缺**（本轮加 `engineer`）
 *   ❌ 汇报工作      → **缺**（本轮加 `reporter`）
 *   ❌ 文员          → **缺**（本轮加 `clerk`）
 *   ✅ 交易员        → trader
 *   ✅ 风控员        → risk_officer
 * ```
 *
 * ⚠️ 而 `ROLE_MAX_TOKENS` 里**早就有 `clerk` / `reporter` 的预算** ——
 * 也就是说"打算加"过，但 `AgentRole` 类型里没有它们 →
 * **那两条预算是死配置**（永远不会被读到）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLES, contextFor, type AgentRole } from './roles.js';

const NEW_ROLES = ['engineer', 'reporter', 'clerk'] as const;

test('★★★ 用户点名的三个岗位必须存在于 ROLES 表里', () => {
  for (const role of NEW_ROLES) {
    assert.ok(
      (role as AgentRole) in ROLES,
      `★ \`${role}\` 必须在 ROLES 里（用户需求 ⑤ 点名要有）`,
    );
    assert.ok(
      ROLES[role].system.trim().length > 100,
      `★ \`${role}\` 的系统提示词不能是占位符（实测 ${ROLES[role].system.length} 字）`,
    );
    assert.ok(ROLES[role].label.trim().length > 0, `★ \`${role}\` 要有中文名`);
  }
});

test('★★★ 三个岗位的【专属职责】必须互不重叠', () => {
  /*
   * ⚠️ 这是**本设计的核心**：三个角色都在"整理信息"，但读者与产物不同：
   * ```
   *   工程师（engineer）：找"哪里在坏"        → 面向【系统健康】
   *   汇报员（reporter）：讲"发生了什么"      → 面向【人】（5 行以内）
   *   文员  （clerk）   ：整理"散落的事实"    → 面向【下游程序】
   * ```
   * 若三者的提示词讲的是同一件事，那就该合并成一个 ——
   * 而"三个角色做同一件事"正是多智能体系统最常见的浪费。
   *
   * ⚠️ **必须排除共用的 `COMMON` 头部** —— 那一段是所有角色共享的铁律
   *（"你是自动交易系统的其中一个角色……"），
   * 它的重复是**刻意的**（统一纪律），不是"职责重叠"。
   * 第一版没有排除它 → 假失败（命中的正是那 40 字）。
   */
  const COMMON_HEAD = '你是自动交易系统的其中一个角色';
  const stripCommon = (s: string): string => {
    const i = s.indexOf('3. 你的输出必须是一个 JSON 对象');
    return i >= 0 ? s.slice(i + 25) : s;
  };
  const texts = NEW_ROLES.map((r) => stripCommon(ROLES[r].system));
  assert.ok(
    ROLES.engineer.system.includes(COMMON_HEAD),
    '★ 前提校验：它们确实共享 COMMON 头部（否则这个 strip 是白做的）',
  );
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i] ?? '';
      const b = texts[j] ?? '';
      /* 用"最长公共子串的粗略代理"：比较 40 字以上的公共片段。 */
      let longest = 0;
      for (let k = 0; k + 40 <= a.length; k += 1) {
        if (b.includes(a.slice(k, k + 40))) longest = Math.max(longest, 40);
      }
      assert.equal(
        longest,
        0,
        `★ ${NEW_ROLES[i]} 与 ${NEW_ROLES[j]} 的【专属】提示词有 40+ 字重复 —— 职责可能重叠`,
      );
    }
  }
});

test('★★★ 工程师必须【只能报告，不能改代码】（安全边界）', () => {
  /*
   * ⚠️ 这是**刻意的边界**：一个能自己改代码的智能体在交易系统里是不可审计的。
   * 它的价值在于"把看不出异常的失败变成一条写清楚的告警"。
   */
  const sys = ROLES.engineer.system;
  assert.ok(
    sys.includes('只能报告') || sys.includes('不能改代码'),
    '★ 必须明确写清它不能改代码',
  );
  /* 而它要重点找的"静默失败"必须在提示词里（那是它存在的理由）。 */
  assert.ok(
    sys.includes('静默失败'),
    '★ 必须点名"静默失败"—— 那是它存在的全部理由',
  );
  /* 并且要求区分"偶发"与"系统性"（同一个失败出现 N 次 vs 1 次）。 */
  assert.ok(
    sys.includes('系统性') && sys.includes('网络抖动'),
    '★ 必须要求区分"系统性失败"与"一次网络抖动"（前者要修，后者可以忽略）',
  );
  /* 还要求它说清"我没查什么"。 */
  assert.ok(
    sys.includes('notChecked'),
    '★ 输出里必须含 `notChecked` —— "我没查"比"看起来正常"诚实得多',
  );
});

test('★★★ 汇报员必须面向人（长度限制 + 不许美化）', () => {
  const sys = ROLES.reporter.system;
  assert.ok(sys.includes('5 行'), '★ 必须限制长度（操作员不会读完 1000 字）');
  assert.ok(sys.includes('不许美化'), '★ 必须禁止美化（亏了就说亏了多少）');
  /* ⚠️ 它必须报告"失败的角色" —— 否则失败会被"信息有限"掩盖。 */
  assert.ok(
    sys.includes('failures'),
    '★ 输出里必须含 `failures` —— 否则失败会被掩盖',
  );
});

test('★★★ 文员必须面向系统（ISO 时间 + 不合并 + 不下结论）', () => {
  const sys = ROLES.clerk.system;
  assert.ok(sys.includes('ISO 8601'), '★ 时间必须 ISO 8601（下游要排序与算间隔）');
  assert.ok(
    sys.includes('不要合并'),
    '★ 必须禁止合并"看起来一样"的条目（合并会让"重复发生"看不出来）',
  );
  assert.ok(sys.includes('不下结论'), '★ 必须明确它不做判断');
});

test('★ 新角色的 contextFor 必须是已知值', () => {
  for (const role of NEW_ROLES) {
    const c = contextFor(role);
    assert.ok(
      ['strategy_review', 'decision_review', 'market', 'proposal_only', 'outcome', 'system_health'].includes(c),
      `★ ${role} 的 contextFor 是未知值：${c}`,
    );
  }
  /* 工程师拿的是"系统健康"上下文 —— 与交易判断的上下文不同。 */
  assert.equal(
    contextFor('engineer'),
    'system_health',
    '★ 工程师要看的是系统健康数据，不是行情',
  );
});
