/**
 * 团队输出适配器的测试。
 *
 * 这个适配器是 S3 **能不能真正跑起来**的关键：团队跑完一轮，如果翻译不对，
 * 交易循环解析不到决策 —— **整轮白跑，而且不报错**（只表现为"没有动作"）。
 * 那是最难发现的一种失败，所以这里要把边界钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractFirstJsonArray, renderDeskOutcome } from './deskOutput.js';
import type { DeskOutcome, DeskRoleOutput } from './tradingDesk.js';

function role(name: string, raw: string, ok = true): DeskRoleOutput {
  return { role: name, modelId: `stub/${name}`, data: null, raw, latencyMs: 10, ok, ...(ok ? {} : { error: '模拟失败' }) };
}

function outcome(patch: Partial<DeskOutcome> = {}): DeskOutcome {
  return {
    analyses: [],
    bull: null,
    bear: null,
    verdict: null,
    callsUsed: 7,
    truncatedByBudget: false,
    summary: '测试用',
    ...patch,
  };
}

/* -------------------------------------------------------------------------- */
/*  JSON 数组抽取（易错点集中在这里）                                          */
/* -------------------------------------------------------------------------- */

test('★ 能抽出嵌在散文里的决策数组', () => {
  const text = '我的结论如下：\n[{"symbol":"BTCUSDT","action":"open_long"}]\n以上。';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok');
  assert.equal(r.decisions?.length, 1);
});

test('★ 嵌套数组不会被贪婪匹配吃掉（正则写法就会错）', () => {
  /*
   * `\[[\s\S]*\]` 会一路匹配到**最后一个** `]`，于是尾巴被吃进来变成非法 JSON。
   * 而模型的输出里嵌套数组很常见。
   */
  const text = '[{"symbol":"BTCUSDT","levels":[1,2,3]},{"symbol":"ETHUSDT","levels":[4]}] 结尾说明';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok', '★ 嵌套数组必须能正确闭合');
  assert.equal(r.decisions?.length, 2);
  assert.deepEqual((r.decisions?.[0] as Record<string, unknown>).levels, [1, 2, 3]);
});

test('★ 字符串内部的方括号不参与计数（否则括号会错位）', () => {
  const text = '[{"symbol":"BTCUSDT","reasoning":"买入[区间]是 0.5-0.6"}]';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok', '★ 字符串里的方括号不能让计数错位');
  assert.equal(r.decisions?.length, 1);
});

test('★ 字符串里的转义引号不破坏解析', () => {
  const text = '[{"symbol":"BTCUSDT","reasoning":"他说\\"买\\"我就买"}]';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok');
});

test('★ 被截断的输出 → bad-json（不是静默当成空）', () => {
  /*
   * 实测：token 上限截断是真实故障形态。截断的输出**必须与"模型说空数组"区分**，
   * 否则运维会以为"模型决定不行动"，而不是"输出被截断了"。
   */
  const text = '[{"symbol":"BTCUSDT","action":"open_long","reasoning":"因';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'bad-json', '★ 截断必须被识别为解析失败');
  assert.ok(r.snippet && r.snippet.length > 0, '要保留片段供排查');
});

test('★ 没有数组 → no-block（与 bad-json 区分）', () => {
  const r = extractFirstJsonArray('我认为现在不宜交易，建议观望。');
  assert.equal(r.status, 'no-block');
  assert.equal(r.decisions, null);
});

test('空数组是合法结论（"不行动"）', () => {
  const r = extractFirstJsonArray('[]');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.decisions, []);
});

test('导出的不是数组（是对象）→ bad-json', () => {
  const r = extractFirstJsonArray('{"symbol":"BTCUSDT"}');
  assert.equal(r.status, 'no-block', '没有 `[` 就是 no-block');
  const r2 = extractFirstJsonArray('[{"a":1},"多余的"] 后面还有 [1,2]');
  assert.equal(r2.status, 'ok', '第一个完整数组能被解析即可');
});

/* -------------------------------------------------------------------------- */
/*  渲染成 autoTrader 认的格式                                                */
/* -------------------------------------------------------------------------- */

test('★★ 裁决里的决策必须原样进入 <decision> 块（交易循环唯一认的东西）', () => {
  const out = outcome({
    verdict: role('judge', '结论：\n[{"symbol":"BTCUSDT","action":"open_long","stopLoss":60000}]'),
    analyses: [role('market_analyst', '市场偏多')],
  });
  const text = renderDeskOutcome(out);

  assert.ok(text.includes('<decision>'), '必须有 decision 块');
  assert.ok(text.includes('</decision>'), '必须有闭合');
  assert.ok(text.includes('"action":"open_long"'), '★ 决策内容要原样保留');
  assert.ok(text.includes('BTCUSDT'));
  /* 团队审计信息也要在（用户要求看得见） */
  assert.ok(text.includes('<team>'), '要有团队审计块');
  assert.ok(text.includes('市场偏多'), '各角色产出要附上');
});

test('★ 裁决解析失败时【返回空决策 + 说明原因】，绝不编造动作', () => {
  /*
   * 这条是安全底线：解析不出来时**宁可不行动**，也不能猜一个动作去下单。
   */
  const out = outcome({ verdict: role('judge', '我建议买入，但没写 JSON 数组。') });
  const text = renderDeskOutcome(out);

  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 必须是空决策数组');
  assert.ok(text.includes('没有找到 JSON 数组'), '要说清是哪一种失败');
  assert.ok(!text.includes('open_long'), '★ 绝不能凭空造出开仓动作');
});

test('★ 截断的裁决也按"不行动"处理并说清是截断', () => {
  const out = outcome({ verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_lo') });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 截断必须保守处理');
  assert.ok(text.includes('解析失败'), '要说清是解析失败（可能是截断）');
});

test('★ 裁决缺失（judge 没跑）→ 空决策，而不是崩溃', () => {
  const out = outcome({ verdict: null, truncatedByBudget: true });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('<decision>\n[]\n</decision>'));
  assert.ok(text.includes('提前收尾'), '★ 受限要如实说明 —— 否则看起来像"模型决定不行动"');
});

test('角色失败时审计块要如实标注，不掩盖', () => {
  const out = outcome({
    verdict: role('judge', '[]'),
    analyses: [role('newscaster', '', false)],
  });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('失败'), '★ 失败的角色要在审计块里标明');
  assert.ok(text.includes('newscaster'));
});
