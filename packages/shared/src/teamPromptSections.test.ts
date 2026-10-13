/**
 * **团队模式必须给"职责与流程"，但不给"门槛"**（2026-10-13）。
 *
 * ## 这个区分是本文件的核心
 *
 * ```
 *   ✗ 边界（不该有）：「单笔风险 ≤ 权益 2%」「最少 75 分置信度」
 *                     —— 那是系统替它决定"多保守"
 *   ✓ 指引（该有）  ：「你是谁」「你的决策流程是什么」
 *                     —— 那是【工作说明书】，不是策略偏好
 * ```
 * 一个公司不会规定交易员"必须多保守"，但**会告诉他岗位职责**。
 * 没有后者，他不是"自由"，而是**茫然**。
 *
 * ## 事故（实测 `#11`）
 *
 * `defaultAiTeamConfig()` 原来**没有设 `promptSections`** ——
 * 于是它走 schema 的 `.default({})`，四个字段**全是空串**：
 * ```
 *   roleDefinition    0 字
 *   tradingFrequency  0 字
 *   entryStandards    0 字
 *   decisionProcess   0 字
 *   customPrompt      0 字
 * ```
 *
 * ## 而这是策略师**自己诊断出来的**（`agent_experiments #81` 原文）
 *
 * > 「All promptSections are **empty strings** — the decision agent has
 * >  **no behavioral guidance**, so it **defaults to inaction**.」
 *
 * **它的诊断是对的**：一个没有被告知"什么时候该出手"的交易员，
 * 最自然的默认行为就是**什么都不做**（那永远不会有亏损）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAiTeamConfig, defaultStrategyConfig } from './strategy.js';

test('★★★ 团队模式必须给"职责"与"流程"（不能全空）', () => {
  const cfg = defaultAiTeamConfig();
  const ps = cfg.promptSections;
  assert.ok(
    ps.roleDefinition.trim().length > 0,
    '★ `roleDefinition` 不能空 —— 否则它不知道"我是谁"',
  );
  assert.ok(
    ps.decisionProcess.trim().length > 0,
    '★ `decisionProcess` 不能空 —— 否则它不知道"按什么步骤做决定"',
  );
  assert.ok(
    ps.tradingFrequency.trim().length > 0,
    '★ `tradingFrequency` 不能空',
  );
});

test('★★★ `entryStandards` 必须【留空】—— 那是"风格由智能体负责"的落点', () => {
  /*
   * ⚠️ 这条是**刻意的设计**，不是遗漏：
   * 实测策略师自己写了 **941 字**的入场标准，而且写得很好
   *（"opportunity cost of zero trades is the dominant risk"）。
   *
   * 若系统预设了入场标准，就等于**替它回答了"多挑"这个问题** ——
   * 而那正是用户明确要拿掉的东西（需求 ③）。
   */
  const cfg = defaultAiTeamConfig();
  assert.equal(
    cfg.promptSections.entryStandards.trim(),
    '',
    '★ `entryStandards` 必须留空 —— 入场标准是智能体自己的判断',
  );
});

test('★★★ 指引里不能夹带"门槛"（那是内置风控）', () => {
  /*
   * ⚠️ 这是**最重要的边界**：`promptSections` 是"工作说明书"，
   * 不是"策略偏好"。若里面出现"必须 X 分置信度""风险不超过 Y%"，
   * 那就变成了系统替它设的门槛 —— 与需求 ③ 直接冲突。
   */
  const cfg = defaultAiTeamConfig();
  const all = Object.values(cfg.promptSections).join('\n');
  for (const forbidden of ['置信度必须', '风险不超过', '最多开', '禁止开仓', '必须达到']) {
    assert.ok(
      !all.includes(forbidden),
      `★ 指引里不该出现门槛式措辞「${forbidden}」`,
    );
  }
  /* 而"节奏由你自己决定"这类**授权**措辞应当在。 */
  assert.ok(
    all.includes('由你自己决定') || all.includes('由你决定'),
    '★ 必须明确授权（"节奏由你自己决定"），否则模型会假设有隐含限制',
  );
});

test('★ `strategy` 预设的 promptSections 不受影响（旧模式必须保留）', () => {
  /*
   * ⚠️ 用户硬约束："这次大更新做增量，现阶段得也得保留"。
   * `defaultStrategyConfig()` 与 `conservative` 预设是**旧模式**的起点，
   * 它们的内容不该被这次改动碰到。
   */
  const base = defaultStrategyConfig();
  assert.ok(base.promptSections !== undefined, '★ 基础配置的 promptSections 结构不变');
  /* 基础配置的四个字段本来就是空串（那是 `strategy` 模式的默认行为）。 */
  assert.equal(base.promptSections.entryStandards, '');
});
