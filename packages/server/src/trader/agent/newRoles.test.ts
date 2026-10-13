/**
 * **用户需求 ⑤ 点名的岗位必须真的存在，而且不能重复实现**（2026-10-13）。
 *
 * ## 用户的原话
 *
 * > 「有主管、分析账户的，有调查新闻的、有监控社区的、有查市场情绪的、
 * >  **有维护系统的程序员、有汇报工作的、有文员**、有交易员、有风控员等等
 * >  一切专业交易所量化机构有的我们都要有」
 *
 * ## ⚠️ 这份文件记录的错误比它钉住的性质更值得读
 *
 * 我当初的对照表把「维护系统的程序员」记成**缺**，于是新增了 `engineer` ——
 * 而它**从来不缺**，只是**不在 `roles.ts` 里**：`firm.ts` 早就有一个
 * `system_engineer`（状态 `staffed`，由自检每 30 分钟在跑）。
 * 结果是同一个岗位有了两份定义，**两边的中文名还完全一样（「系统工程师」）**。
 *
 * ```
 *   ① 重复：engineer（roles.ts）与 system_engineer（firm.ts）是同一个岗位
 *   ② 孤儿：生产代码里 0 处 `role: 'engineer'`，它永远不会被调用
 *   ③ 死配置：engineer 没登记模型档位 → tierForRole() 静默回退 T2_mid
 *   ④ 已试过：提交 8a4ab1b 接过它，2fd25d7 又整体 revert（自检做得更完整）
 * ```
 *
 * 所以 `engineer` 已被删除（理由写在 `roles.ts` 里它原来的位置），
 * 而**本文件现在反过来钉"它不该再出现"** —— 因为"删掉的东西悄悄长回来"
 * 正是这类重复角色的复发方式。
 *
 * ## 另外两个岗位（`reporter` / `clerk`）的判据是干净的
 *
 * ⚠️ `ROLE_MAX_TOKENS` 里**早就有 `clerk` / `reporter` 的预算** ——
 * 也就是说"打算加"过，但 `AgentRole` 类型里没有它们 →
 * **那两条预算是死配置**（永远不会被读到）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ROLES, contextFor, type AgentRole } from './roles.js';

/** 本轮真正新增的两个角色（`engineer` 已删除，见文件头）。 */
const NEW_ROLES = ['reporter', 'clerk'] as const;

test('★★★ 用户点名的两个岗位必须存在于 ROLES 表里', () => {
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

test('★★★ 两个岗位的【专属职责】必须互不重叠', () => {
  /*
   * ⚠️ 这是**本设计的核心**：两个角色都在"整理信息"，但读者与产物不同：
   * ```
   *   汇报员（reporter）：讲"发生了什么"      → 面向【人】（5 行以内）
   *   文员  （clerk）   ：整理"散落的事实"    → 面向【下游程序】
   * ```
   * 若两者的提示词讲的是同一件事，那就该合并成一个 ——
   * 而"多个角色做同一件事"正是多智能体系统最常见的浪费
   *（`engineer` 就是这样多出来的一个，见文件头）。
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
    ROLES.reporter.system.includes(COMMON_HEAD),
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
      ['strategy_review', 'decision_review', 'market', 'proposal_only', 'outcome'].includes(c),
      `★ ${role} 的 contextFor 是未知值：${c}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ⚠️ 防复发：`engineer` 与 `system_health` 都不该再出现                        */
/* -------------------------------------------------------------------------- */

test('★★★ `engineer` 必须不存在 —— 它与 `system_engineer` 重复且从未被调用', () => {
  /*
   * ## 这条测试防的是"删掉的东西悄悄长回来"
   *
   * 本文件**当初正是在断言 `engineer` 存在**（还断言了它的提示词细节），
   * 也就是说：当时的测试是**这个错误的共犯** —— 它让一个孤儿角色看起来
   * "有测试覆盖、一切正常"。所以现在把它反转过来钉住。
   *
   * ## 三条判据（缺一条都不足以删，合起来才成立）
   *
   * ```
   *   ① 重复：firm.ts 的 system_engineer 与它中文名完全相同（都是「系统工程师」）
   *   ② 孤儿：生产代码里 0 处 `role: 'engineer'`
   *   ③ 死档位：它没登记 ROLE_TIERS → tierForRole() 静默回退 T2_mid
   * ```
   *
   * ⚠️ 第 ② 条**没法用类型系统断言**（类型在、提示词在、就是没人调用），
   * 所以这里退一步断言**符号本身不存在** —— 只要有人想重新加它，
   * 这条用例立刻红，而那一刻正是应该先去查 `FIRM_ROLES` 的时机。
   */
  assert.ok(!('engineer' in ROLES), '★ `engineer` 已被删除（重复角色）—— 不要重新加它');

  const src = readFileSync(new URL('./roles.ts', import.meta.url), 'utf8');
  /*
   * ⚠️ `system_health` 是 `engineer` **唯一**的生产者，而它**没有任何消费者**。
   * 留着一个既无人产出、也无人读取的枚举值，就是留一条"看起来接了系统健康"
   * 的假线索。
   *
   * ⚠️ 断言必须落在**两个真正的位置**上，而不是"整个文件里不出现这个词" ——
   * 删除理由的注释里**应当**留着这个名字（否则下一个人不知道曾经有过它，
   * 也不知道为什么删）。第一版就是那么写的，于是这条用例被自己的注释弄红。
   *
   * 两个位置：
   *   ① 角色定义里的 `contextFor: 'system_health'`
   *   ② 联合类型里的 `| 'system_health'`
   *
   * 用源码正则而不是类型断言，是因为**联合类型的字面量在运行时被完全擦除** ——
   * 类型层面测不到"它被删掉了"。
   */
  assert.ok(
    !/contextFor:\s*'system_health'/.test(src),
    '★ 不该再有角色声明 `contextFor: \'system_health\'`（它从来没有消费者）',
  );
  assert.ok(
    !/\|\s*'system_health'/.test(src),
    "★ `'system_health'` 应当已从 contextFor 联合类型里删除（既无生产者也无消费者）",
  );
  /* 只允许出现在解释"为什么删"的注释里，不允许作为角色定义出现。 */
  assert.ok(
    !/^\s*engineer:\s*\{/m.test(src),
    '★ roles.ts 里不该再有 `engineer:` 这个角色定义',
  );
});

test('★★★ `ROLES` 里不能有两个角色共用同一个中文名', () => {
  /*
   * `engineer` 与 `system_engineer` 的重复**在类型层面完全合法**（id 不同），
   * 肉眼也很难发现 —— 因为它们分处两个文件、两个包。
   * 但界面上「系统工程师」出现两次，操作员就无从分辨哪个在干活。
   *
   * ⚠️ 所以这里钉住**同一个表内的**唯一性；跨表的重复由"这个岗位在
   * `firm.ts` 里已经有了"这条纪律防（`firmRoles.test.ts` 是那道闸门）。
   */
  const labels = Object.values(ROLES).map((r) => r.label);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `★ ROLES 里有重复的中文名：${labels.join(', ')}`,
  );
});

test('★★★ 「系统工程师」这个岗位只属于 firm.ts 的 `system_engineer`', () => {
  /*
   * ⚠️ 这是 `engineer` 被删的**直接判据**：同一个中文名不能对应两个 id。
   *
   * 真正在岗的实现是 `selfcheck.ts` + `selfcheckRunner.ts`（每 30 分钟一次），
   * 它用 `system_engineer` 这个角色（T3 档）。也就是说这个岗位
   * **早就有主了**，`roles.ts` 里再来一个只是重复。
   */
  const named = Object.values(ROLES).filter((r) => r.label === '系统工程师');
  assert.deepEqual(
    named.map((r) => r.role),
    [],
    '★ `roles.ts` 里不该有「系统工程师」—— 该岗位由 firm.ts 的 system_engineer 承担（自检）',
  );
});
