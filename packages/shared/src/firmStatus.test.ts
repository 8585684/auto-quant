/**
 * **`firm.ts` 的岗位状态必须与真实接线一致**（2026-10-13 用户截图抓到的 BUG）。
 *
 * ## 事故：汇报员显示"规划中"，但它已在岗
 *
 * 用户截图（`#11` 的「其余岗位」面板）：
 * ```
 *   汇报员  规划中  ← ❌ 它 13:52 有真实运行日志（完成 1906ms）
 * ```
 * 根因：`tradingDesk.ts` 接线了 `reporter`，但 `firm.ts` 的 `status`
 * 没跟着改 —— 状态与实现脱节，而**界面上看不出任何异常**。
 *
 * ## 为什么"状态漂移"在这类项目里特别危险
 *
 * `planned` 的语义是"**还没实现，不会出现在任何编排里**"（firm.ts 自己的注释）。
 * 它是给操作员看的一份**诚实清单** —— 标错了等于让操作员
 * 对"团队里谁在干活"建立错误的心智模型。
 *
 * ## 判据：`staffed` ⟺ 生产代码里真的有调用点
 *
 * ⚠️ **调用点不只在一个文件里**（第一版只查 tradingDesk.ts，被三个"假阳性"打脸）：
 * ```
 *   risk_officer   → routedModel.ts（团队会议之外的风控路径）
 *   memory_curator → runtime.ts / orchestrator.ts（平仓后的复盘）
 *   execution      → autoTrader.ts（executeOpen/executeClose，纯代码）
 * ```
 * 所以判据是【整个 trader/ 目录】的 `role: '<id>'` 字面量调用点。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { FIRM_ROLES } from './firm.js';

/** 递归收集 trader/ 下全部非测试 .ts 源码（剥注释后的"纯代码"）。 */
function collectCode(dir: string): string {
  const parts: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      parts.push(collectCode(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      /*
       * ⚠️ **`agent/roles.ts` 是角色【定义表】，不是调用点** ——
       * 它里面每个角色都有 `role: 'xxx'` 字面量，把定义算成"接线"
       * 会把所有 planned 岗位误报成"接线后忘了改状态"。
       */
      if (full.endsWith(path.join('agent', 'roles.ts'))) continue;
      const raw = readFileSync(full, 'utf8');
      parts.push(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    }
  }
  return parts.join('\n');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRADER_CODE = collectCode(path.join(HERE, '..', '..', 'server', 'src', 'trader'));

function isWired(roleId: string): boolean {
  /*
   * ⚠️ 三个岗位的"承担方式"不是 `role: '<id>'` 字面量 —— 它们各有各的形态：
   * ```
   *   memory_curator  → 实际调用 id 是 'reviewer'（orchestrator.ts 的复盘，
   *                     firm.ts 的岗位名与角色名是两个体系）
   *   execution       → autoTrader.ts 的 executeOpen/executeClose —— 纯代码，
   *                     从不调 LLM（tier: T0_code 的本意）
   *   system_engineer → manager.ts 的 selfCheck 系（每 30 分钟自检）
   * ```
   * 硬编码这三个映射不优雅，但**诚实**：它们的承担方式本来就不是
   * "问一次模型"，硬套 `role: 'xxx'` 判据反而会把"在岗"误报成"漂移"。
   */
  const BEARERS: Record<string, RegExp> = {
    memory_curator: /role: 'reviewer'/,
    execution: /executeOpen\(/,
    system_engineer: /runSelfCheck\(/,
  };
  const bearer = BEARERS[roleId];
  if (bearer !== undefined) return bearer.test(TRADER_CODE);
  return TRADER_CODE.includes(`role: '${roleId}'`);
}

test('★★★ 标了 staffed 的角色必须真的有调用点（防"装饰性在岗"）', () => {
  const liars = FIRM_ROLES.filter((r) => r.status === 'staffed' && !isWired(r.id)).map(
    (r) => `${r.label}(${r.id})`,
  );
  assert.deepEqual(
    liars,
    [],
    `★ 这些角色标了 staffed 但 trader/ 下没有任何调用点（状态漂移）：${liars.join('、')}`,
  );
});

test('★★★ 接了线的角色不能再标 planned（用户截图抓到的那类漂移）', () => {
  const drifted = FIRM_ROLES.filter((r) => r.status === 'planned' && isWired(r.id)).map(
    (r) => `${r.label}(${r.id})`,
  );
  assert.deepEqual(
    drifted,
    [],
    `★ 这些角色标了 planned 但生产代码里有调用点（接线后忘了改状态）：${drifted.join('、')}`,
  );
});

test('★ reporter 必须是 staffed（2026-10-13 接线，线上有运行日志）', () => {
  const reporter = FIRM_ROLES.find((r) => r.id === 'reporter');
  assert.ok(reporter !== undefined, '★ firm.ts 里必须有 reporter 这个岗位');
  assert.equal(reporter.status, 'staffed', '★ reporter 已接线（13:52 运行日志），不能标 planned');
});

test('★ planned 的岗位清单（新增/接线岗位时同步更新这条期望）', () => {
  const planned = FIRM_ROLES.filter((r) => r.status === 'planned').map((r) => r.id).sort();
  assert.deepEqual(
    planned,
    ['clerk', 'community_monitor', 'data_sentinel', 'onchain_analyst', 'ops_watchdog', 'portfolio_manager', 'red_team'].sort(),
    '★ planned 清单变了 —— 若有岗位接线了，记得同步 firm.ts 的状态与这条期望',
  );
});
