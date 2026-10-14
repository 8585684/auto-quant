/**
 * **裁决官的输出必须完整、且不能只给空数组**（2026-10-13）。
 *
 * ## 一、审计块里的截断制造过一个假结论
 *
 * `deskOutput.ts` 原来把裁决官的产出截到 **800 字**。
 * 而它的输出通常是 **1,500–3,000 字**（结论 + 置信度 + 依据 +
 * "不同意哪一方" + 不确定性 + 失效条件 + **JSON 数组**）。
 *
 * 后果（我自己踩的）：看到 800 字里没有 JSON，就断定
 * **"裁决官从未输出 JSON 数组"** —— 而核实后发现**它输出了**，
 * 只是数组是 `[]`（`extracted.status === 'ok'`，所以那条告警没出现）。
 *
 * **一个为了省几百字而做的截断，制造了一个假结论。**
 *
 * ## 二、"只给空数组"丢掉了整轮的评估信息
 *
 * 实测近 12 轮：
 * ```
 *   格式失败（模型没给 JSON）  2 轮（17%）
 *   给了但只输出 `[]`          **9 轮（75%）**
 *   逐候选给出（12 条 skip）   1 轮
 * ```
 * 那 9 轮的 `[]` 把"8 个角色讨论 3 分钟"落地成两个字符。
 *
 * ⚠️ 而要求"逐候选 skip"**不会**逼它开仓 —— `skip` 与"不行动"在
 * 交易语义上**完全等价**（都是不开仓），只是前者留下了推理痕迹。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const DESK_OUTPUT = readFileSync(
  new URL('./deskOutput.ts', import.meta.url),
  'utf8',
);
const TRADING_DESK = readFileSync(
  new URL('./tradingDesk.ts', import.meta.url),
  'utf8',
);

test('★★★ 裁决官的产出不能被截到看不出结论的长度', () => {
  /*
   * ⚠️ 这是那个假结论的直接来源：`verdict.raw.slice(0, 800)`。
   * 800 字**不够**装下它的推理 + JSON 数组。
   *
   * ⚠️ 2026-10-14：渲染从 `verdict.raw.slice(0, N)` 改成了 `clip(verdict.raw, N)`
   *（`clip` = 剥标签 + 压单行 + **截断留痕**）。截断长度**没有变**（仍是 4,000），
   * 所以这条测试的意图不变，只改判据形态。
   */
  assert.ok(
    !/verdict\.raw\.slice\(0,\s*800\)/.test(DESK_OUTPUT),
    '★ 裁决官不能再截到 800 字（实测它的输出 1,500–3,000 字）',
  );
  const m = /clip\(verdict\.raw,\s*([\d_]+)\)/.exec(DESK_OUTPUT);
  assert.ok(m !== null, '★ 应当有裁决官的截断长度（形态：clip(verdict.raw, N)）');
  const len = Number((m[1] ?? '0').replace(/_/g, ''));
  assert.ok(len >= 3_000, `★ 至少要 3,000 字才装得下它的推理与数组（实际 ${len}）`);
  /* ⚠️ 且必须走 clip（不能退回裸 slice —— 那会让多行正文污染解析）。 */
  assert.ok(
    !/verdict\.raw\.slice\(0,\s*4_000\)/.test(DESK_OUTPUT),
    '★ 必须走 clip（剥标签 + 压单行 + 留痕），不能用裸 slice —— 多行会破坏前端解析',
  );
});

test('★★★ 提示词必须明确"不许只给空数组"', () => {
  /*
   * 实测 75% 的轮次输出 `[]` —— 那丢掉了每个标的为什么不做的理由。
   */
  assert.ok(
    TRADING_DESK.includes('不要只给空数组'),
    '★ 必须明确禁止"只给空数组"',
  );
  assert.ok(
    TRADING_DESK.includes('即使结论是"全部不行动"，也必须逐个候选给出一条 `skip`'),
    '★ 必须要求逐候选 skip（它留下了推理痕迹）',
  );
});

test('★ 要求"逐候选 skip"不能被误读成"必须开仓"', () => {
  /*
   * ⚠️ 这是**重要的安全边界**：`skip` 与"不行动"在交易语义上等价。
   * 若提示词写得像"必须给出动作"，模型可能为了满足格式而开仓 ——
   * 那是我不想要的（用户要的是"更聪明"，不是"更激进"）。
   */
  assert.ok(
    /空数组只在\*\*真的没有任何候选可评估\*\*时才用/.test(TRADING_DESK) ||
      TRADING_DESK.includes('真的没有任何候选可评估'),
    '★ 必须说清 `[]` 何时仍然合法（否则模型会以为空数组被禁止而硬凑动作）',
  );
});
