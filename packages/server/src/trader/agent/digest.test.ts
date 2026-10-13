import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDigest, rankDigests, renderDigests, type SymbolDigest } from './digest.js';

const good = (over: Partial<SymbolDigest> = {}): SymbolDigest => ({
  symbol: 'BTCUSDT', direction: 'bullish', score: 70, confidence: 80,
  evidence: '4h 结构完好，量能配合', invalidates: '跌破 78000 则失效',
  ...over,
});

test('★★★ 正常 JSON → 解析成功', () => {
  const r = parseDigest(JSON.stringify(good()), 'BTCUSDT');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.digest.symbol, 'BTCUSDT');
    assert.equal(r.digest.score, 70);
    assert.equal(r.digest.invalidates.length > 0, true);
  }
});

test('★ 容忍 ```json 包裹与前后废话', () => {
  const r = parseDigest('分析如下：\n```json\n' + JSON.stringify(good()) + '\n```\n以上。', 'BTCUSDT');
  assert.equal(r.ok, true);
});

test('★★★ 容忍 <digest> 标签包裹（线上 20 个里 19 个失败的那次教训）', () => {
  /*
   * ## 事故（2026-10-13，`#11` 按币并行）
   *
   * flash 档模型对"裸输出 JSON"的服从性差，19/20 失败于
   * "没有找到 JSON 对象"（输出散文或带解释的结构）。
   * 而同一批模型在 `<team>` / `<decision>` 标签里能稳定输出 JSON。
   *
   * 所以 task 现在要求"放在 <digest> 标签里"，extractJson 必须能认它。
   */
  const r = parseDigest(
    '先说两句废话。\n<digest>\n' + JSON.stringify(good()) + '\n</digest>\n再补一句。',
    'BTCUSDT',
  );
  assert.equal(r.ok, true, '★ <digest> 标签里的 JSON 必须能解析');
});

test('★★★ 标签里的 JSON 优先于正文里的杂散花括号', () => {
  /*
   * 模型喜欢在标签外写解释 —— 解释文字里偶发的 `{` 会污染"全文扫第一个 {"。
   * 顺序必须是 标签 > 围栏 > 全文。
   */
  const decoy = '我的判断是 {可能} 偏空。';
  const r = parseDigest(decoy + '\n<digest>\n' + JSON.stringify(good()) + '\n</digest>', 'BTCUSDT');
  assert.equal(r.ok, true, '★ 标签优先 —— 正文杂散花括号不该干扰');
});

test('★ 标签里嵌围栏也能解析（模型两种包裹叠着用）', () => {
  const r = parseDigest(
    '<digest>\n```json\n' + JSON.stringify(good()) + '\n```\n</digest>',
    'BTCUSDT',
  );
  assert.equal(r.ok, true);
});

test('★★★ 标的对不上 → 失败（不能静默记到错的标的名下）', () => {
  /*
   * ⚠️ 按币并行时，每份摘要会被放回**它自己的槽位**。
   * 若模型答的是另一个币而这里放行，结果会被记到错误的标的名下 ——
   * 而且**完全静默**（数字都在、格式都对）。
   */
  const r = parseDigest(JSON.stringify(good({ symbol: 'ETHUSDT' })), 'BTCUSDT');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes('标的对不上'), r.error);
});

test('★★★ 缺 invalidates → 失败（失效条件必填，防谄媚）', () => {
  /*
   * 调研 [arXiv:2509.23055](https://arxiv.org/html/2509.23055v1) 的结论之一：
   * 要求模型写出"我什么时候是错的"，能显著降低"永远看多"的倾向。
   *
   * ⚠️ 缺它就**失败**，而不是补一句"无" ——
   * 补出来的"无"会让下游以为"这个判断没有失效条件"，
   * 而真相是**模型没回答那个问题**。
   */
  const { invalidates, ...rest } = good();
  void invalidates;
  const r = parseDigest(JSON.stringify(rest), 'BTCUSDT');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes('invalidates'), r.error);
});

test('★★★ 缺 evidence → 失败（结论必须有依据）', () => {
  const { evidence, ...rest } = good();
  void evidence;
  const r = parseDigest(JSON.stringify(rest), 'BTCUSDT');
  assert.equal(r.ok, false);
});

test('★★★ score / confidence 越界或缺失 → 失败（不静默补 0）', () => {
  /*
   * 若 `score` 缺失被补成 0，汇总时会把它排在最后 ——
   * 而真相是"这个标的根本没被分析成功"。**保留原文 + 明确失败**才对。
   */
  for (const bad of [{ score: 150 }, { score: '70' }, { confidence: -5 }]) {
    const r = parseDigest(JSON.stringify({ ...good(), ...bad }), 'BTCUSDT');
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应当失败`);
  }
});

test('★ direction 非法 → 失败；但 unclear 是合法结论', () => {
  assert.equal(parseDigest(JSON.stringify({ ...good(), direction: 'maybe' }), 'BTCUSDT').ok, false);
  assert.equal(parseDigest(JSON.stringify({ ...good(), direction: 'unclear' }), 'BTCUSDT').ok, true);
});

test('★ 非 JSON → 失败但保留原文（便于排查）', () => {
  const r = parseDigest('我觉得这个币不错', 'BTCUSDT');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.raw.includes('我觉得'), '要保留原文');
});

test('★★★ 排序用【代码】做：score 降序，unclear 排最后', () => {
  /*
   * "从 20 个里选 3 个"本质是**比较**，而 LLM 做排序有已知偏差：
   * **偏好写得长的、以及排在上下文前面的**（位置偏差）。
   * 用代码排之后，AI 只需回答"为什么这几个更好"。
   */
  const list = [
    good({ symbol: 'A', score: 50 }),
    good({ symbol: 'B', score: 90 }),
    good({ symbol: 'C', direction: 'unclear', score: 95 }),
    good({ symbol: 'D', score: 50, confidence: 95 }),
  ];
  const ranked = rankDigests(list).map((d) => d.symbol);
  assert.deepEqual(ranked, ['B', 'D', 'A', 'C'], `实际 ${ranked.join(',')}`);
});

test('★★★ 方向【不参与】排序（粗筛不该预判多空）', () => {
  /*
   * 若按方向排序，会**系统性偏向某一方向**。
   * 方向由下游裁决，粗筛只看信号强度。
   */
  const list = [
    good({ symbol: 'BULL', direction: 'bullish', score: 60 }),
    good({ symbol: 'BEAR', direction: 'bearish', score: 60 }),
  ];
  const ranked = rankDigests(list);
  assert.equal(ranked[0]!.score, ranked[1]!.score, '同强度同置信时不该因方向而分先后');
});

test('★★ 渲染保留 dataGaps（下游要能看到"结论基于不完整数据"）', () => {
  const text = renderDigests([good({ dataGaps: ['缺资金费率', '无链上数据'] })]);
  assert.ok(text.includes('数据缺口'), '★ 必须保留，否则缺失被静默');
  assert.ok(text.includes('缺资金费率'));
});

test('★ 渲染是紧凑的（同构短摘要的意义就在这里）', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    good({ symbol: `SYM${i}USDT`, evidence: '结构完好，量能配合', invalidates: '跌破支撑失效' }));
  const text = renderDigests(many);
  /* 20 份 × ~150 字 ≈ 3000 字 —— 而自由发挥会是 4 万字。 */
  assert.ok(text.length < 8000, `20 份摘要应紧凑（实际 ${text.length} 字）`);
});

test('★ 空输入 → 明确说"没有可用分析"（不是空字符串）', () => {
  assert.ok(renderDigests([]).includes('没有可用'));
});
