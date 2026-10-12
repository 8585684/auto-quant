/**
 * `hunters` 的测试 —— 重点钉住**"失败必须可见"**这条性质。
 *
 * 因为把失败静默丢掉会让下游以为"那个来源上什么都没有" ——
 * 而那是两件完全不同的事：
 * ```
 *   社区上没有讨论        → 一个事实，可以据此判断（无舆情炒作）
 *   社区猎手没跑成        → 一个缺陷，不能据此判断任何事
 * ```
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HUNTERS,
  buildHunterTask,
  mergeHunterReports,
  summariseHunters,
  type HunterReport,
} from './hunters.js';

test('★★★ 四个猎手覆盖用户点名的来源（新闻/社区/社交/资金/宏观）', () => {
  /*
   * 用户原话：
   * > 「查新闻、**各大交易所社区**、**社交媒体**、新闻源等等」
   * > 「有调查新闻的、**有监控社区的**、**有查市场情绪的**」
   *
   * ⚠️ 若某个来源没有对应的猎手，那个来源就**永远没人查** ——
   * 而系统不会报错，只是那类证据一直缺席。
   */
  const ids = HUNTERS.map((h) => h.id);
  assert.ok(ids.includes('news_hunter'), '★ 必须有新闻猎手');
  assert.ok(ids.includes('community_hunter'), '★ 必须有社区猎手（用户点名"监控社区"）');
  assert.ok(ids.includes('flow_hunter'), '★ 必须有资金猎手（软数据之外的硬证据）');
  assert.ok(ids.includes('macro_hunter'), '★ 必须有宏观猎手');
  /* 每个猎手必须有非空的侧重与来源 —— 空的 focus 会让它"什么都查一点"。 */
  for (const h of HUNTERS) {
    assert.ok(h.focus.length > 5, `★ ${h.id} 的 focus 不能为空`);
    assert.ok(h.sources.length > 0, `★ ${h.id} 必须列出信息源`);
    assert.ok(h.label.length > 0, `★ ${h.id} 必须有中文名（给操作员看）`);
  }
});

test('★★★ 任务提示词必须含四条共同纪律（缺一条就会出问题）', () => {
  /*
   * 四条都对应实测踩过的坑：
   * ```
   *   ① 必须带来源链接 —— 没有链接会被 `parseIntel` 丢掉（它要求 http(s)）
   *   ② 必须给 hoursAgo —— 时效衰减与 TTL 判据靠它
   *   ③ 查不到就说查不到 —— 不许用常识填充（本项目最忌讳的失败）
   *   ④ 输出 JSON —— 便于 `parseIntelReport` 解析
   * ```
   */
  const t = buildHunterTask(HUNTERS[0]!, ['BTCUSDT']);
  assert.ok(t.includes('BTCUSDT'), '★ 必须带上要查的标的');
  assert.ok(t.includes('http'), '★ 必须要求来源链接');
  assert.ok(t.includes('hoursAgo'), '★ 必须要求发布时刻');
  assert.ok(t.includes('不要用常识'), '★ 必须禁止编造');
  assert.ok(t.includes('空数组'), '★ 必须说明"查不到就输出空数组"（那是正确答案）');
  assert.ok(t.includes(HUNTERS[0]!.focus), '★ 必须写清这个猎手专查什么');
});

test('★★★ 合并：失败者必须出现，且写明原因（不能静默丢掉）', () => {
  const reports: HunterReport[] = [
    { hunterId: 'news_hunter', label: '新闻猎手', ok: true, text: '查到 2 条新闻', latencyMs: 100 },
    { hunterId: 'community_hunter', label: '社区猎手', ok: false, text: '', error: '超时 180 秒', latencyMs: 180_000 },
  ];
  const merged = mergeHunterReports(reports);
  assert.ok(merged.includes('新闻猎手'), '★ 成功的要在');
  assert.ok(merged.includes('社区猎手'), '★ **失败者也必须在**（否则下游以为那边没消息）');
  assert.ok(merged.includes('未产出'), '★ 必须显式写出"未产出"');
  assert.ok(merged.includes('超时 180 秒'), '★ 必须写明原因');
  assert.ok(merged.includes('1/2'), '★ 概览要给出"几个有产出"');
});

test('★★★ 小结必须说清"哪几个来源是缺的"', () => {
  /*
   * ⚠️ "社区上没有讨论"与"社区猎手挂了"是两件完全不同的事 ——
   * 而正文很长，模型可能看不到那两行"未产出"。
   */
  const reports: HunterReport[] = [
    { hunterId: 'a', label: '新闻猎手', ok: true, text: 'x', latencyMs: 1 },
    { hunterId: 'b', label: '社区猎手', ok: false, text: '', error: 'x', latencyMs: 1 },
    { hunterId: 'c', label: '资金猎手', ok: false, text: '', error: 'x', latencyMs: 1 },
  ];
  const s = summariseHunters(reports);
  assert.ok(s.includes('2 个未产出'), `★ 实际：${s}`);
  assert.ok(s.includes('社区猎手') && s.includes('资金猎手'), '★ 必须点名');
  assert.ok(s.includes('不等于'), '★ 必须明确"空白≠没有消息"');
  /* 全部成功时不该出现"未产出"。 */
  assert.ok(
    !summariseHunters(reports.slice(0, 1)).includes('未产出'),
    '★ 全部成功时不该说"未产出"',
  );
});

test('★ 成功但内容为空 → 写"未查到"（与"失败"是两件不同的事）', () => {
  const reports: HunterReport[] = [
    { hunterId: 'a', label: '新闻猎手', ok: true, text: '   ', latencyMs: 1 },
  ];
  const merged = mergeHunterReports(reports);
  assert.ok(merged.includes('未查到相关消息'), '★ 成功但空 → "未查到"');
  assert.ok(!merged.includes('未产出'), '★ 不该说它"未产出"（它跑了，只是没查到）');
});

test('★ 空列表 → 空字符串（调用方据此退回旧路径）', () => {
  assert.equal(mergeHunterReports([]), '');
});
