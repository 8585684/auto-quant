/**
 * 团队审计解析的测试。
 *
 * 这个解析器让**历史决策区**能显示"谁参与了、各自说了什么"，
 * 而**不需要给数据库加列**（迁移要动挂着实盘的 `traders` 表，风险不值得）。
 * 它解析的是团队产出里本来就有、且已落库的 `<team>` 审计块。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTeamTrace } from './teamTrace.js';

/** 一段真实的团队产出（形状与 `renderDeskOutcome` 一致）。 */
const TEAM_RAW = `<decision>
[{"symbol":"BTCUSDT","action":"open_long"}]
</decision>

<team>
交易台：分析师 4/4 成功 · 已裁决 · 调用 7/8

## 各角色产出
- market_analyst（workbuddy-ai/glm-5.3）：市场偏多，1h 结构完好
- technical（opencode-zen-free/big-pickle）：RSI 58，金叉
- judge（workbuddy-ai/gpt-6-astra）：结论：偏多但仓位要小
</team>`;

test('★★ 能从团队决策里解析出摘要与各角色产出', () => {
  const trace = parseTeamTrace(TEAM_RAW);
  assert.ok(trace, '团队决策必须能解析出来');
  assert.equal(trace.summary, '分析师 4/4 成功 · 已裁决 · 调用 7/8');
  assert.equal(trace.members.length, 3);
  assert.equal(trace.members[0]!.role, 'market_analyst');
  assert.equal(trace.members[0]!.modelId, 'workbuddy-ai/glm-5.3', '★ 用了哪个模型是审计关键');
  assert.ok(trace.members[0]!.text.includes('市场偏多'));
});

test('★ 正文里的中文冒号不会切坏角色名（用第一个冒号分割）', () => {
  /*
   * 模型写的论证里经常有中文冒号。若用 `lastIndexOf('：')`，
   * 角色名会被切到最后一个冒号之前 —— 变成一长串垃圾。
   */
  const raw = `<team>
## 各角色产出
- judge（m1）：结论：偏多；理由：结构完好；风险：假突破
</team>`;
  const trace = parseTeamTrace(raw);
  assert.equal(trace?.members[0]!.role, 'judge', '★ 角色名必须是 judge');
  assert.ok(trace?.members[0]!.text.startsWith('结论：偏多'), '★ 正文要完整保留');
});

test('★ 普通/智能托管模式（没有 team 块）返回 null —— 那不是错误', () => {
  const raw = `<decision>[{"symbol":"BTCUSDT","action":"open_long"}]</decision>`;
  assert.equal(parseTeamTrace(raw), null, '★ 没有 team 块是正常情况');
});

test('★ 角色没有括号（没记模型）时也能解析', () => {
  const raw = `<team>
## 各角色产出
- technical：只描述指标
</team>`;
  const trace = parseTeamTrace(raw);
  assert.equal(trace?.members[0]!.role, 'technical');
  assert.equal(trace?.members[0]!.modelId, null);
});

test('★ team 块没闭合（输出被截断）时不崩', () => {
  /*
   * 实测确有截断（token 上限）。截断时应当解析出**已经写出来的那部分**，
   * 而不是整段丢掉 —— 那些信息仍然有价值。
   */
  const raw = `<team>
交易台：分析师 2/4 成功
## 各角色产出
- bull（m1）：做多论证…`;
  const trace = parseTeamTrace(raw);
  assert.equal(trace?.summary, '分析师 2/4 成功');
  assert.equal(trace?.members.length, 1);
});

test('摘要之外的额外行不会混进成员列表', () => {
  const raw = `<team>
交易台：ok
⚠️ 本轮因预算/轮次上限提前收尾 —— 结论是在受限条件下得出的。

## 各角色产出
- bull（m1）：论证
</team>`;
  const trace = parseTeamTrace(raw);
  assert.equal(trace?.members.length, 1, '★ 警告行不该被当成成员');
  assert.equal(trace?.members[0]!.role, 'bull');
});
