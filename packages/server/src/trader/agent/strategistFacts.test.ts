/**
 * **同一个假约束的三个出口 —— 第三个必须堵上**（2026-10-13）。
 *
 * ## 事故链（三处，同一件事）
 *
 * ```
 *   ① `system_prompt` 里的 `MODE_GUIDANCE['conservative']`
 *      「保住本金压倒一切。宁可交易更少、质量更高。」
 *      → 裁决官引用它：「账户与模式不允许赌…**40轮空仓不是必须打破的错误**」
 *
 *   ② `user_prompt` 里的"交易模式：conservative"
 *      → 裁决官引用它：「conservative+15分钟一轮+20.75U权益，管不住本轮波动」
 *
 *   ③ **本处**：策略师的参数 dump 里的 `"tradingMode":"conservative"`
 *      → 策略师**把它写进了自己的规则**（`agent_experiments #81` 原文）：
 *        "For the **conservative mode** on this small account (~20 USDT equity):…"
 * ```
 *
 * ## 为什么 ③ 最严重
 *
 * ①② 是"每轮渲染一次"的文本，改掉就没了。
 * 而 ③ 的后果是**那个假约束被写进了 `entryStandards`** ——
 * 它会**一直生效**，而且从界面上看是"模型自己定的规则"（看起来完全正常）。
 *
 * **"同一个假约束的最后一个出口"** —— 而它最难发现，因为它不在提示词里，
 * 而在**喂给智能体的"事实"里**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ORCH = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

test('★★★ 策略师的参数 dump 里不能有 `tradingMode`', () => {
  /*
   * ⚠️ 这是 ③ 的直接形状：`JSON.stringify(input.ports.readConfig())`。
   */
  assert.ok(
    !/当前参数：\$\{JSON\.stringify\(input\.ports\.readConfig\(\)\)\}/.test(ORCH),
    '★ 不能把整份配置 dump 给策略师（里面有 tradingMode）',
  );
  assert.ok(
    /configForStrategist/.test(ORCH),
    '★ 应当有一层"只给它该管的字段"的过滤',
  );
});

test('★★★ 过滤必须真的去掉 tradingMode（不是只改个名字）', () => {
  const m = /const configForStrategist = \(\(\) => \{([\s\S]{0,700}?)\}\)\(\);/.exec(ORCH);
  assert.ok(m !== null, '★ 必须能定位那个过滤');
  const body = m[1] ?? '';
  assert.ok(
    /tradingMode:\s*_drop/.test(body),
    '★ 必须显式解构掉 `tradingMode`（那是最关键的假约束来源）',
  );
});

test('★★★ 但该给它的字段不能一起丢掉', () => {
  /*
   * ⚠️ 这是**反向保证**：过滤掉元数据是对的，
   * 但 `riskControl` / `coinSource` / `promptSections` 是它**真的能用
   * `set_params` 改**的东西 —— 丢了它们，策略师就瞎了。
   */
  const m = /const configForStrategist = \(\(\) => \{([\s\S]{0,700}?)\}\)\(\);/.exec(ORCH);
  const body = m?.[1] ?? '';
  assert.ok(
    /\.\.\.rest/.test(body),
    '★ 其余字段必须保留（只解构掉少数几个元数据）',
  );
  /* 被丢掉的必须只有少数几个（元数据），不能是"大部分"。 */
  const dropped = [...body.matchAll(/(\w+):\s*_[a-z]+/g)].map((x) => x[1]);
  assert.ok(
    dropped.length <= 4,
    `★ 只该丢掉少数几个元数据字段（实际丢了 ${dropped.length} 个：${dropped.join(', ')}）`,
  );
  assert.ok(
    dropped.includes('tradingMode'),
    '★ `tradingMode` 必须在被丢掉的名单里',
  );
});
