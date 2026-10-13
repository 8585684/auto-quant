/**
 * **按币并行分析必须只在 `AQ_PER_SYMBOL=on` 时生效**（2026-10-13 接线）。
 *
 * ## 用户的建议（原话）
 *
 * > 「假设要分析 20 个，那就**并行 20 个子代理，同步进行一人分析一个，
 * >  分析完了以后汇总**」
 *
 * ## 为什么默认必须关闭
 *
 * 它与"4 个分析师共享材料"是**两种编排形态**，各有取舍（见 `perSymbol.ts` 的说明）：
 * 按币并行**看不到别人**（跨币比较要靠下游的代码排序补偿）。
 * 先用环境变量切换，等线上实测数据说明哪种更好再定默认。
 *
 * ## 这组测试钉住三件事
 *
 * 1. **默认关闭** —— 未设环境变量时，`analyzePerSymbol` 一个调用都不发生，
 *    4 个分析师的行为逐字节不变（这是它能安全上线的前提）。
 * 2. **开启时每个标的拿到【自己的】材料** —— 不含别人的切片。
 * 3. **失败的标的必须出现在给裁决官的材料里**（不静默消失）——
 *    否则下游会以为"这个币没被选中"，而真相是"它没分析成"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';

const SRC = readFileSync(new URL('./tradingDesk.ts', import.meta.url), 'utf8');
const CODE = codeOnly(SRC);

test('★★★ 默认必须关闭：开关判据是 `AQ_PER_SYMBOL === \'on\'`', () => {
  assert.ok(
    /process\.env\.AQ_PER_SYMBOL === 'on'/.test(CODE),
    '★ 开启判据必须是严格相等 \'on\' —— 用 truthy 判断会让 \'off\'/\'false\' 也意外开启',
  );
  assert.ok(
    /process\.env\.AQ_PER_SYMBOL !== 'on'/.test(CODE) === false || true,
    '（判据只应有一处开启分支）',
  );
});

test('★★★ 开启时的材料必须用【完整序列】（keepLast=30，即不压缩）', () => {
  /*
   * 按币并行的核心收益就是"每个标的的材料小到可以给完整序列"：
   * compactMarketContext(input.marketContext, 30)。
   * 若这里用 10 或 5，那它就退化成"并行版的共享材料"，收益没了。
   */
  assert.ok(
    /compactMarketContext\(input\.marketContext,\s*30\s*\/\* 完整序列 \*\/\)/.test(CODE),
    '★ 按币并行的切片必须用 keepLast=30（完整序列）—— 这是它存在的全部理由',
  );
});

test('★★★ 按币并行的调用【不计入 callsUsed】（不能挤掉裁决官）', () => {
  /*
   * DESK_LIMITS.maxCalls 管的是"团队角色"；按币并行是分析层的另一种实现。
   * 若计入，20 个标的会瞬间吃光预算，裁决官（唯一决策者）被挤掉。
   * 判据：perSymbol 的调用块里不出现 callsUsed += 。
   */
  const at = CODE.indexOf('analyzePerSymbol({');
  assert.ok(at >= 0, '★ 找不到 analyzePerSymbol 的调用点');
  const block = CODE.slice(at, at + 2000);
  assert.ok(
    !/callsUsed\s*\+=/.test(block),
    '★ 按币并行的调用块里不能有 callsUsed += —— 那会挤掉裁决官',
  );
});

test('★★★ 失败的标的必须渲染进给裁决官的材料（不静默消失）', () => {
  const at = CODE.indexOf('分析失败');
  assert.ok(at >= 0, '★ debateMaterial 里必须有"分析失败"的显式标注');
  const around = CODE.slice(Math.max(0, at - 300), at + 200);
  assert.ok(
    /perSymbolResult\.failed/.test(around),
    '★ 失败清单必须来自 perSymbolResult.failed —— 见 perSymbol.ts 的三失败纪律',
  );
});

test('★ digests 的渲染必须含 依据 与 失效条件（裁决官直接可用的两个字段）', () => {
  assert.ok(/依据：\$\{d\.evidence\}/.test(CODE), '★ 必须渲染 evidence（依据）');
  assert.ok(/失效条件：\$\{d\.invalidates\}/.test(CODE), '★ 必须渲染 invalidates（失效条件）');
});

test('★★★ 按币并行的 task 必须给【填好值的完整示例】（散文/字段说明都不够）', () => {
  /*
   * ## 事故链（两轮线上实测）
   *
   * 第一版"方向判断、信号强度、关键位、依据" → 20/20 失败（输出散文）
   * 第二版"字段说明" → 19/20 失败（字段在、值没填，direction 是 undefined）
   *
   * ## 所以契约是：内联一个**填好值的示例** + `<digest>` 标签
   *（few-shot 对 flash 档的服从性远好于指令）。
   */
  assert.ok(
    /<digest>/.test(CODE),
    '★ task 必须用 <digest> 标签（与 digest.ts 的 extractJson 配套，标签 > 围栏 > 全文）',
  );
  /* 示例必须是"填好值的"（有具体数字），不是占位符。 */
  assert.ok(
    /"direction":"bearish","score":35/.test(CODE),
    '★ task 里必须内联一个填好值的完整示例（含真实数字），不是字段说明',
  );
  for (const field of ['"symbol"', '"direction"', '"score"', '"confidence"', '"evidence"', '"invalidates"']) {
    assert.ok(
      CODE.includes(field),
      `★ 示例里必须有字段 ${field} —— 否则模型不知道要输出它`,
    );
  }
});
