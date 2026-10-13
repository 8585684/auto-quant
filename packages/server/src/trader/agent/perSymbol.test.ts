import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePerSymbol, renderPerSymbolOutcome, type SymbolTask } from './perSymbol.js';

const tasks = (...symbols: string[]): SymbolTask[] =>
  symbols.map((s) => ({ symbol: s, context: `${s} 的行情数据` }));

/** 造一份合法的摘要 JSON。 */
const digestJson = (symbol: string, score = 60): string => JSON.stringify({
  symbol, direction: 'bullish', score, confidence: 70,
  evidence: '结构完好', invalidates: '跌破支撑失效',
});

test('★★★ N 个标的一人一个，结果按强度排序', async () => {
  const r = await analyzePerSymbol({
    tasks: tasks('A', 'B', 'C'),
    ask: async (t) => ({ ok: true, text: digestJson(t.symbol, t.symbol === 'B' ? 90 : 50) }),
  });
  assert.deepEqual(r.digests.map((d) => d.symbol), ['B', 'A', 'C'], '★ 应按 score 降序');
  assert.equal(r.failed.length, 0);
});

test('★★★ 并发峰值受闸门限制（不能 20 个一起起）', async () => {
  /*
   * 实测约束：claude code 单进程约 250MB，20 个并行 ≈ 5GB。
   * 用户说的"不限制并发"是 magpie 侧；服务器侧是真约束。
   */
  const r = await analyzePerSymbol({
    tasks: tasks(...Array.from({ length: 12 }, (_, i) => `S${i}`)),
    concurrency: 3,
    ask: async (t) => {
      await new Promise((res) => setTimeout(res, 20));
      return { ok: true, text: digestJson(t.symbol) };
    },
  });
  assert.equal(r.digests.length, 12);
  assert.ok(r.peakConcurrency <= 3, `★ 峰值应 ≤3（实际 ${r.peakConcurrency}）`);
  assert.ok(r.peakConcurrency >= 2, `★ 但要真的并发（峰值 ${r.peakConcurrency} 说明退化成串行）`);
});

test('★★★ 单个失败【不拖垮整批】，且失败项被明确回传', async () => {
  /*
   * "20 个标的里 1 个的数据源抽了"是常态。
   * 若它让整批失败，现象会是"这一轮整个分析层没产出"——
   * 而真相只是 1 个标的的问题。
   */
  const r = await analyzePerSymbol({
    tasks: tasks('A', 'B', 'C'),
    ask: async (t) => (t.symbol === 'B'
      ? { ok: false, text: '', error: '数据源超时' }
      : { ok: true, text: digestJson(t.symbol) }),
  });
  assert.equal(r.digests.length, 2, '★ 其余两个要照常产出');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.symbol, 'B');
  assert.ok(r.failed[0]!.reason.includes('数据源超时'), '要保留原始原因');
});

test('★★★ 模型答了【另一个币】→ 记为失败（不能静默记到错的名下）', async () => {
  /*
   * 这是按币并行最阴险的失败：数字都在、格式都对，
   * 但**结果属于另一个标的**。靠 `parseDigest` 的 `expectedSymbol` 拦。
   */
  const r = await analyzePerSymbol({
    tasks: tasks('A', 'B'),
    ask: async () => ({ ok: true, text: digestJson('WRONGUSDT') }),
  });
  assert.equal(r.digests.length, 0, '★ 标的不对的不能被当成成功');
  assert.equal(r.failed.length, 2);
  assert.ok(r.failed[0]!.reason.includes('标的对不上'), r.failed[0]!.reason);
});

test('★★ 摘要格式坏掉 → 记为失败并说明是【解析】问题（而不是模型问题）', async () => {
  const r = await analyzePerSymbol({
    tasks: tasks('A'),
    ask: async () => ({ ok: true, text: '我觉得这个币挺好的' }),
  });
  assert.equal(r.digests.length, 0);
  assert.ok(r.failed[0]!.reason.includes('摘要解析失败'), r.failed[0]!.reason);
});

test('★★★ 渲染时【必须】写出失败的标的（不是"被排除"，是没分析成）', async () => {
  /*
   * 若只渲染成功的，下游会以为"这些币不在考虑范围"，
   * 而真相是"没分析成" —— 两者在决策上含义完全不同。
   */
  const r = await analyzePerSymbol({
    tasks: tasks('A', 'B'),
    ask: async (t) => (t.symbol === 'B'
      ? { ok: false, text: '', error: '超时' }
      : { ok: true, text: digestJson(t.symbol) }),
  });
  const text = renderPerSymbolOutcome(r);
  assert.ok(text.includes('A'), '成功的要写');
  assert.ok(text.includes('B'), '★ 失败的也要写');
  assert.ok(text.includes('不是"被排除"'), '★ 要明确区分"失败"与"被排除"');
});

test('★ 全失败时也给出明确说明（不是空文本）', async () => {
  const r = await analyzePerSymbol({
    tasks: tasks('A'),
    ask: async () => ({ ok: false, text: '', error: '挂了' }),
  });
  const text = renderPerSymbolOutcome(r);
  assert.ok(text.includes('没有任何标的分析成功'), '要明说全军覆没');
  assert.ok(text.includes('A'), '失败的标的仍要列出');
});

test('★ `ask` 抛错 → 记为失败（不冒泡）', async () => {
  const r = await analyzePerSymbol({
    tasks: tasks('A', 'B'),
    ask: async (t) => {
      if (t.symbol === 'A') throw new Error('网络炸了');
      return { ok: true, text: digestJson(t.symbol) };
    },
  });
  assert.equal(r.digests.length, 1);
  assert.equal(r.failed.length, 1);
  assert.ok(r.failed[0]!.reason.includes('网络炸了'));
});

test('★ 空任务 → 空结果（不起工人、不崩）', async () => {
  const r = await analyzePerSymbol({ tasks: [], ask: async () => ({ ok: true, text: '' }) });
  assert.deepEqual(r.digests, []);
  assert.deepEqual(r.failed, []);
  assert.equal(r.peakConcurrency, 0);
});

test('★ 渲染保留 dataGaps（下游要能看到"结论基于不完整数据"）', async () => {
  const r = await analyzePerSymbol({
    tasks: tasks('A'),
    ask: async () => ({
      ok: true,
      text: JSON.stringify({
        symbol: 'A', direction: 'neutral', score: 50, confidence: 50,
        evidence: '区间震荡', invalidates: '突破区间则失效', dataGaps: ['缺资金费率'],
      }),
    }),
  });
  assert.ok(renderPerSymbolOutcome(r).includes('缺资金费率'));
});
