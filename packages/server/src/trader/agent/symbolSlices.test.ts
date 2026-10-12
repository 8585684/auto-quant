/**
 * `symbolSlices` 的测试 —— 重点钉住**"切不出来时必须退回原文"**这条安全性质。
 *
 * 因为一旦切错，agent 会拿到"没有材料"的输入 → 它只能编 ——
 * 而那是本项目反复强调的"看不出异常的失败"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSliceContext, splitMarketContext } from './symbolSlices.js';

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
