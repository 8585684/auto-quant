/**
 * **规则段必须完整送到 —— 四条路径全都要覆盖**（2026-10-13）。
 *
 * ## 事故全貌（四个路径，逐一被线上证据确认）
 *
 * 策略师写的规则（`#11` 的 `system_prompt` 原文）：
 * ```
 *   「You MUST open at least one position per 6 cycles if any symbol showed a
 *     ≥2% move. …your entry standards are too strict by construction」
 * ```
 * 而实测 **95 轮 · 217 条决策 · 全部 skip · 0 成交** —— 规则从来没完整到过。
 *
 * ## 四条路径（前两条我修的，后两条是独立审计发现的）
 *
 * ```
 *   ① splitMarketContext  → 规则段被并进最后一个候选切片 → 只取前 6 片时丢掉
 *   ② headOfMarket 的 break → 规则段在最后一个 part → 进不了 picked
 *   ③ overviewCap 截断     → 规则段在 shared 里被 slice(0, 6000) 腰斩  ★每轮必触发
 *   ④ firstCand === null   → 无候选段时直接 slice(0, budgetChars) 砍尾巴
 * ```
 *
 * ## ⚠️ 路径 ③ 是"两个各自正确的修复合起来失效"
 *
 * ```
 *   修① 把规则段搬进 `shared`（正确）
 *   → 而 `shared` 正是 headOfMarket 眼里的"概览"
 *   → overviewCap = budgetChars/4 把它截断
 *   → 修② 的判据只看 `picked`、不看 `head` → 兜不住
 * ```
 * **线上证据**：
 * ```
 *   #2590 c97（修①之前）: MUST=false          default-to-action=false  ← 全丢
 *   #2592 c98（修①之后）: MUST=**true**        default-to-action=false  ← 只前半段到了
 * ```
 *
 * ⚠️ 这与本项目记录过的 `ai_requested` + "只取前 6 个"是**同一类组合性缺陷**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { headOfMarket } from './tradingDesk.js';

/** 规则段（含线上真实的多个小节 —— 用来验证"整段完整"，不是"只保前半"）。 */
const RULES =
  '\n---\n\n## 团队需要遵守的规则（来自交易循环）\n' +
  '# 入场标准\nYou MUST open at least one position per 6 cycles.\n' +
  'default-to-action: skipping requires a specific articulated reason.\n' +
  '# 输出格式\nJSON array first.\n' +
  '# 你自己写下的长期指示\n' +
  'opportunity cost of zero trades is the dominant risk.';

const body = (n: number): string => `current_price = 1.23\n${'x'.repeat(n)}`;

/** 路径③形状：`shared`（含规则段）在前 + 候选在后 —— 这是压缩后的真实形状。 */
function compactedShape(preRulesLen: number, candCount = 6): string {
  const shared = `# 全市场概览\n525 个标的…\n${'y'.repeat(preRulesLen)}${RULES}`;
  const cands = Array.from(
    { length: candCount },
    (_, i) => `### ${i + 1}. SYM${i}USDT（coinpool）\n${body(3000)}`,
  );
  return `${shared}\n\n${cands.join('\n\n')}`;
}

/** 路径②形状：候选在前 + 规则段在末尾（未压缩的真实形状）。 */
function rawShape(candCount = 12): string {
  const cands = Array.from(
    { length: candCount },
    (_, i) => `### ${i + 1}. SYM${i}USDT（coinpool）\n${body(9000)}`,
  );
  return `# 全市场概览\n525 个标的…\n\n${cands.join('\n\n')}${RULES}`;
}

/* -------------------------------------------------------------------------- */
/*  路径 ③（每轮必触发 —— 最重要）                                                */
/* -------------------------------------------------------------------------- */

test('★★★ 路径③：`shared` 里的规则段不能被 overviewCap 腰斩', () => {
  /*
   * ⚠️ `budgetChars = 24000` → `overviewCap = 6000`。
   * 而 `shared` 里"规则段之前"的部分故意给 4000（> 3502 的实测边界）
   * → 若不摘出规则段，连 `# 入场标准` 都会丢。
   */
  const r = headOfMarket(compactedShape(4000), 24_000);
  assert.ok(
    r.text.includes('MUST open at least one position'),
    '★ `# 入场标准` 必须完整保留（这是"必须开仓"那条规则）',
  );
  assert.ok(
    r.text.includes('default-to-action'),
    '★ 规则中段必须保留',
  );
  assert.ok(
    r.text.includes('opportunity cost'),
    '★ 规则**末段**也必须保留 —— 这正是线上 #2592 丢掉的那部分',
  );
});

test('★★★ 路径③边界：规则段之前的部分很长时也不能丢', () => {
  /* preRulesLen 越大，`slice(0, 6000)` 砍掉的越多 —— 极端值下必须仍完整。 */
  for (const pre of [0, 1000, 4000, 5900, 8000]) {
    const r = headOfMarket(compactedShape(pre), 24_000);
    assert.ok(
      r.text.includes('opportunity cost'),
      `★ preRulesLen=${pre} 时规则末段丢了`,
    );
  }
});

test('★★★ 规则段不能被复制两份（三处来源只取一份）', () => {
  /* 预算极大 → 所有 part 都在 picked 里（含规则段）→ 不能再追加。 */
  const r = headOfMarket(rawShape(2), 1_000_000);
  const n = (r.text.match(/MUST open at least one position/g) ?? []).length;
  assert.equal(n, 1, `★ 规则段应恰好出现 1 次（实际 ${n} 次）`);
  /* 压缩形状（规则在 shared 里）同样只能一份。 */
  const r2 = headOfMarket(compactedShape(100, 2), 1_000_000);
  const n2 = (r2.text.match(/MUST open at least one position/g) ?? []).length;
  assert.equal(n2, 1, `★ 压缩形状下规则段也应恰好 1 次（实际 ${n2} 次）`);
});

/* -------------------------------------------------------------------------- */
/*  路径 ②（未压缩路径）                                                          */
/* -------------------------------------------------------------------------- */

test('★★★ 路径②：预算 break 之后规则段仍要被接回', () => {
  /* 每候选 9000 字符、预算 24000 → 只放得下 2 个 → 规则段在 break 之后。 */
  const r = headOfMarket(rawShape(12), 24_000);
  assert.ok(
    r.text.includes('opportunity cost'),
    '★ 规则段必须被接回（它不在 picked 里）',
  );
});

/* -------------------------------------------------------------------------- */
/*  路径 ④（无候选段）                                                            */
/* -------------------------------------------------------------------------- */

test('★★★ 路径④：没有候选段时（持仓轮）规则段也要保住', () => {
  /*
   * 持仓轮材料 = 概览 + 持仓 + 绩效 + 规则段，实测 29612 字符，
   * 而预算 24000 → 直接 slice 会把规则段尾巴砍掉。
   */
  const noCand = `# 当前持仓\n无\n${'z'.repeat(20_000)}${RULES}`;
  const r = headOfMarket(noCand, 24_000);
  assert.ok(r.text.includes('opportunity cost'), '★ 规则末段必须保留');
  assert.ok(r.text.includes('# 当前持仓'), '★ 材料头部要留着');
  assert.equal(r.candidatesShown, 0, '★ 没有候选时不该虚报');
});

/* -------------------------------------------------------------------------- */
/*  没有规则段时不能弄坏材料                                                       */
/* -------------------------------------------------------------------------- */

test('★★★ 没有规则段时行为不变（不能凭空造、也不能多截）', () => {
  const noRules = `# 概览\n### 1. AAAUSDT（coinpool）\n${body(100)}`;
  const r = headOfMarket(noRules, 24_000);
  assert.ok(!r.text.includes('团队需要遵守的规则'), '★ 不该凭空造规则段');
  assert.ok(r.text.includes('AAAUSDT'), '★ 候选内容要留着');
  assert.equal(r.candidatesShown, 1, '★ 候选计数不能错');
});

test('★ 规则段必须出现在所有候选【之后】（它不属于任何候选）', () => {
  const r = headOfMarket(rawShape(3), 1_000_000);
  const rulesAt = r.text.indexOf('MUST open at least one position');
  const lastCandAt = r.text.lastIndexOf('### 3. SYM2USDT');
  assert.ok(rulesAt > lastCandAt, '★ 规则段位置必须在最后一个候选之后');
});
