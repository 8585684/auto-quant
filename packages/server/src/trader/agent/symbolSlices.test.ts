/**
 * `symbolSlices` 的测试 —— 重点钉住**"切不出来时必须退回原文"**这条安全性质。
 *
 * 因为一旦切错，agent 会拿到"没有材料"的输入 → 它只能编 ——
 * 而那是本项目反复强调的"看不出异常的失败"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactMarketContext, compactSeriesLines, compactUniverseOverview, composeSliceContext, splitMarketContext } from './symbolSlices.js';

/** 一份贴近真实渲染结果的样本（格式抄自线上 `user_prompt`）。 */
const SAMPLE = [
  '# 全市场概览（币安 525 个 USDT 永续，按 24h 成交额降序）',
  'BTCUSDT 82687 +0.42% ...',
  '',
  '# 你的账户',
  '权益 20.75 USDT',
  '',
  '### 1. STRKUSDT（ai_requested + coinpool — 多来源共振）',
  'current_price = 0.093868, current_ema20 = 0.096878',
  '=== 5M 周期（由旧到新）===',
  '价格: [0.104560, 0.104520]',
  '',
  '### 2. WUSDT（ai_requested）',
  'current_price = 0.0123',
  '价格: [1, 2]',
  '',
  '### 3. BTCUSDT（coinpool + reference — 多来源共振）',
  'current_price = 82687',
  '价格: [1, 2]',
].join('\n');

test('★ 按标的切分：每段只含自己的材料', () => {
  const r = splitMarketContext(SAMPLE);
  assert.ok(r !== null, '★ 样本应当能切出来');
  assert.equal(r!.slices.length, 3);
  assert.deepEqual(r!.slices.map((s) => s.symbol), ['STRKUSDT', 'WUSDT', 'BTCUSDT']);
  /* 每段只含自己的指标。 */
  assert.ok(r!.slices[0]!.text.includes('0.093868'));
  assert.ok(!r!.slices[0]!.text.includes('0.0123'), '★ 第一段不该含第二段的材料');
  assert.ok(!r!.slices[1]!.text.includes('0.093868'), '★ 第二段不该含第一段的材料');
});

test('★ 共享部分（账户/概览）必须与标的段分开 —— 但拼回去要完整', () => {
  const r = splitMarketContext(SAMPLE);
  assert.ok(r!.shared.includes('全市场概览'), '★ 概览属于共享部分');
  assert.ok(r!.shared.includes('权益 20.75'), '★ 账户属于共享部分');
  assert.ok(!r!.shared.includes('STRKUSDT（'), '★ 共享部分不该含候选段');
  /*
   * ⚠️ 这条最重要：**拼回去必须与原文完全一致**（不丢字符）。
   * 否则切片会静默丢掉材料（例如某个标的的尾部）。
   */
  const rebuilt = [r!.shared, ...r!.slices.map((s) => s.text)].join('\n');
  assert.equal(rebuilt, SAMPLE, '★ 切分必须无损（拼回原文）');
});

test('★★★ 切不出来时返回 null（调用方必须退回原文，而不是拿空材料去问）', () => {
  /*
   * ⚠️ 这是本文件最重要的安全性质。
   *
   * 若切分失败却返回"一个空切片"，agent 会**在没有材料的情况下作答** ——
   * 它只能编，而操作员看到的是一个"正常完成"的角色。
   * **那比超时更糟**：超时是看得见的失败，编造是看不见的。
   */
  assert.equal(splitMarketContext('完全不符合格式的材料'), null);
  assert.equal(splitMarketContext(''), null);
  /* 只有一个候选：拆了也不会更小，且容易出边界错误。 */
  assert.equal(splitMarketContext('### 1. BTCUSDT（coinpool）\n价格: [1]'), null);
});

test('★ 只认行首的 `### <数字>. ` —— 不误切其它 `###` 标题', () => {
  /*
   * 材料里会有别的三级标题（例如事件卡、段落标题）。
   * 不加"行首 + 数字 + 点"这个约束会把它们误切成标的。
   */
  const messy = [
    '### 事件卡（新闻）',
    '一些新闻内容',
    '### 1. AAAUSDT（coinpool）',
    '价格: [1]',
    '### 2. BBBUSDT（coinpool）',
    '价格: [2]',
  ].join('\n');
  const r = splitMarketContext(messy);
  assert.ok(r !== null);
  assert.deepEqual(r!.slices.map((s) => s.symbol), ['AAAUSDT', 'BBBUSDT'], '★ 不该把"事件卡"当成标的');
  assert.ok(r!.shared.includes('事件卡'), '★ "事件卡"应当留在共享部分');
});

test('★ 拼给 agent 的材料必须含共享部分（否则它不知道账户多大）', () => {
  /*
   * ⚠️ 账户权益是 agent 算"单笔风险预算"的依据 —— 少了它，
   * 它会给出一个与账户规模无关的仓位建议。
   */
  const r = splitMarketContext(SAMPLE)!;
  const ctx = composeSliceContext(r.shared, r.slices[0]!);
  assert.ok(ctx.includes('权益 20.75'), '★ 必须带上账户信息');
  assert.ok(ctx.includes('STRKUSDT'), '★ 也要带上自己的标的');
  assert.ok(!ctx.includes('WUSDT'), '★ 但不该带别的标的');
});

test('★ 切片规模确实变小了（这是它存在的唯一理由）', () => {
  const r = splitMarketContext(SAMPLE)!;
  const one = composeSliceContext(r.shared, r.slices[0]!);
  assert.ok(
    one.length < SAMPLE.length,
    `★ 单片（${one.length}）必须小于原文（${SAMPLE.length}）—— 否则接线没有意义`,
  );
});

test('★★★ 压缩序列行：只留最后 5 个点，且【不误伤散文】', () => {
  /*
   * ## 为什么需要它（实测数据）
   *
   * 单个标的材料 11,983 字符，绝大部分是原始 K 线数组：
   * ```
   *   价格: [0.104560, 0.104520, ... 共 30 个]
   *   成交量: [1, 2, 3, ... 共 30 个]
   * ```
   * 而 headline 已经给了所有关键指标的最新值。
   *
   * ## 为什么保留最后 5 个而不是整行删掉
   *
   * 形态判断需要"最近几根的走向" —— 整行删掉就只剩最新值，
   * 看不出"正在往上还是往下"。
   */
  const text = [
    '价格: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
    '成交量: [1, 2, 3]',
    '这是一段散文，里面有 [方括号] 但不是序列行',
    '## 某个标题: [不是序列]',
  ].join('\n');
  const out = compactSeriesLines(text, 5);
  assert.ok(out.includes('…省略前 5 个…, 6, 7, 8, 9, 10'), '★ 长序列应保留最后 5 个');
  assert.ok(out.includes('成交量: [1, 2, 3]'), '★ 短序列（≤5）原样保留');
  assert.ok(out.includes('这是一段散文，里面有 [方括号] 但不是序列行'), '★ 不误伤散文');
});

test('★★★ 压缩后必须仍然更小（否则接线没意义）', () => {
  const long = Array.from({ length: 40 }, (_, i) => i).join(', ');
  const text = `价格: [${long}]\n成交量: [${long}]\n指标: [${long}]`;
  const out = compactSeriesLines(text, 5);
  assert.ok(out.length < text.length / 3, `★ 压缩后应显著变小（${text.length} → ${out.length}）`);
});

test('★ 压缩不改变【非序列】内容（账户、评分口径、约束说明都在散文里）', () => {
  /*
   * ⚠️ 材料里最有价值的部分恰恰是散文：账户权益、评分口径、
   * 交易所最小名义额 —— 压坏它们比不压缩更糟。
   */
  const important = [
    '权益 20.75 USDT',
    '约束：这个标的在交易所的**最小名义价值是 $5**',
    '候选评分 39.11／100（趋势 40.0／40 · 突破量能 29.1／35）',
  ].join('\n');
  assert.equal(compactSeriesLines(important, 5), important, '★ 散文必须一字不改');
});

test('★ compactMarketContext 端到端：切分 + 压缩，且切不出来时返回 null', () => {
  const sample = [
    '# 共享部分',
    '权益 20.75 USDT',
    '### 1. AAAUSDT（coinpool）',
    `价格: [${Array.from({ length: 30 }, (_, i) => i).join(', ')}]`,
    '### 2. BBBUSDT（coinpool）',
    `价格: [${Array.from({ length: 30 }, (_, i) => i).join(', ')}]`,
  ].join('\n');
  const r = compactMarketContext(sample, 5);
  assert.ok(r !== null);
  assert.equal(r!.slices.length, 2);
  assert.ok(r!.shared.includes('权益 20.75'), '★ 共享部分保留');
  assert.ok(r!.slices[0]!.text.includes('省略前 25 个'), '★ 序列被压缩');
  /* 切不出来时必须 null（调用方退回原文）。 */
  assert.equal(compactMarketContext('没有候选标题的材料'), null);
});
test('★★★ 全市场概览裁剪：保留前 N 行，并【显式写出省略了多少】', () => {
  /*
   * ## 为什么它值 15k 字符
   *
   * 实测共享部分 18,690 字符，其中 **15k 是"525 行全市场概览"**。
   *
   * ## 为什么必须写出"省略了多少"
   *
   * 否则模型会以为**市场只有这 N 个标的** —— 那是**制造一个假事实**，
   * 而本项目明确禁止这一点（宁可说"截断了"，也不能让它误以为完整）。
   */
  /*
   * ⚠️ 第 3 行故意用**单字符币名**（`WUSDT`）—— 实测币安真有这个标的，
   * 而我的正则第一版要求 `{2,20}` → 它不匹配 → 扫描循环在那里 break →
   * **整个裁剪静默失效**（15k 一个字符都没省，也不报错）。
   */
  const rows = Array.from({ length: 100 }, (_, i) =>
    i === 3 ? 'WUSDT 0.024054 +36.85% 677M'
      /* ⚠️ 第 4 行用**中文币名** —— 实测币安真有 `币安人生USDT`。 */
      : i === 4 ? '币安人生USDT 0.589600 -4.36% 27M'
        : `SYM${i}USDT 1.23 ${i % 2 ? '+' : '-'}1.00% ${i}B`);
  const text = [
    '# 全市场概览（币安 525 个 USDT 永续，按 24h 成交额降序）',
    '**这不是候选池**',
    '',
    ...rows,
    '',
    '# 你的账户',
    '权益 20.75 USDT',
  ].join('\n');
  const out = compactUniverseOverview(text, 60);
  assert.ok(out.includes('省略其余 40 个标的'), '★ 必须写出省略了多少');
  assert.ok(out.includes('SYM0USDT'), '★ 保留前 60 行（成交额降序 → 市场头部）');
  assert.ok(!out.includes('SYM99USDT'), '★ 第 100 行被省略');
  assert.ok(out.includes('权益 20.75 USDT'), '★ 后续段落不受影响');
});

test('★ 概览行数不足 keepRows 时原样返回（不做无意义改写）', () => {
  const text = ['# 全市场概览', 'AAAUSDT 1 +1.00% 1B', 'BBBUSDT 2 -1.00% 2B'].join('\n');
  assert.equal(compactUniverseOverview(text, 60), text);
});

test('★ 没有"全市场概览"段时原样返回（不误改）', () => {
  const text = '权益 20.75 USDT\n### 1. AAAUSDT（coinpool）\n价格: [1, 2]';
  assert.equal(compactUniverseOverview(text, 60), text);
});