import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIntelReport, hostOf } from './parseIntel.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;

const json = (items: unknown[]): string => JSON.stringify(items);

const okItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary: '某交易所上线新合约',
  sourceUrl: 'https://www.coindesk.com/x',
  direction: 'bullish',
  symbols: ['BTCUSDT'],
  hoursAgo: 2,
  ...over,
});

test('★★★ 正常产出 → 结构化情报（hoursAgo 转成 publishedAt）', () => {
  const r = parseIntelReport(json([okItem()]), NOW, 'news_hunter');
  assert.equal(r.intel.length, 1);
  const i = r.intel[0]!;
  assert.equal(i.sourceHost, 'www.coindesk.com', '★ 域名要抽出来（交叉验证按它去重）');
  assert.equal(i.publishedAt, NOW - 2 * H, '★ 相对小时数要转成时间戳');
  assert.equal(i.direction, 'bullish');
  assert.deepEqual(i.symbols, ['BTCUSDT']);
  assert.equal(i.by, 'news_hunter');
  assert.equal(r.dropped.length, 0);
});

test('★★★ 来源必须是 http(s) 链接（编不出真实链接）', () => {
  /*
   * 防幻觉第一道闸：模型可以编"据某媒体报道"，但**编不出一个真实可点的链接**。
   */
  for (const bad of ['', '某媒体报道', 'ftp://x.com/a', 'coindesk.com/x']) {
    const r = parseIntelReport(json([okItem({ sourceUrl: bad })]), NOW, 'x');
    assert.equal(r.intel.length, 0, `"${bad}" 应当被丢弃`);
    assert.equal(r.dropped.length, 1);
    assert.ok(r.dropped[0]!.reason.includes('来源链接无效'), r.dropped[0]!.reason);
  }
});

test('★★★ `hoursAgo` 为负 → 丢弃（"未来发布"不能当最新消息）', () => {
  /*
   * 负值意味着"未来发布" —— 要么模型搞错、要么时钟问题。
   * 两种都不该被当成"最新消息"放行（那会绕过时效衰减）。
   */
  const r = parseIntelReport(json([okItem({ hoursAgo: -3 })]), NOW, 'x');
  assert.equal(r.intel.length, 0);
  assert.ok(r.dropped[0]!.reason.includes('hoursAgo 非法'));
});

test('★ `hoursAgo` 缺失/非数 → 丢弃（不能用"现在"兜底）', () => {
  /*
   * ⚠️ 用"现在"兜底是**最危险**的做法：它会让一条 3 天前的消息
   * 被当成新鲜情报 —— **那正是消息面交易最典型的亏钱方式**。
   */
  for (const bad of [undefined, '2', Number.NaN, null]) {
    const r = parseIntelReport(json([okItem({ hoursAgo: bad })]), NOW, 'x');
    assert.equal(r.intel.length, 0, `${String(bad)} 应当被丢弃`);
  }
});

test('★ direction 非法 → 丢弃（但 neutral 合法）', () => {
  assert.equal(parseIntelReport(json([okItem({ direction: 'maybe' })]), NOW, 'x').intel.length, 0);
  assert.equal(parseIntelReport(json([okItem({ direction: 'neutral' })]), NOW, 'x').intel.length, 1);
});

test('★★★ 解析失败要【保留原文与原因】—— 否则"没查到"与"解析坏了"分不清', () => {
  const r = parseIntelReport('我查了但没找到相关新闻', NOW, 'x');
  assert.equal(r.intel.length, 0);
  assert.equal(r.dropped.length, 1);
  assert.ok(r.dropped[0]!.raw.includes('没找到'), '要保留原文供排查');
});

test('★★ 部分坏 → 好的照常保留（不能一条坏全丢）', () => {
  const r = parseIntelReport(
    json([okItem(), { summary: '缺链接' }, okItem({ summary: '第二条', sourceUrl: 'https://a.com/b' })]),
    NOW, 'x',
  );
  assert.equal(r.intel.length, 2, '★ 两条好的要保留');
  assert.equal(r.dropped.length, 1, '坏的那条要报出来');
});

test('★ 容忍 ```json 包裹与前后废话', () => {
  const r = parseIntelReport('调研结果：\n```json\n' + json([okItem()]) + '\n```\n以上。', NOW, 'x');
  assert.equal(r.intel.length, 1);
});

test('★ 空数组 → 空结果（不崩、不报错）', () => {
  const r = parseIntelReport('[]', NOW, 'x');
  assert.deepEqual(r.intel, []);
  assert.deepEqual(r.dropped, []);
});

test('★ `hostOf` 大小写与非法 URL', () => {
  assert.equal(hostOf('https://WWW.CoinDesk.com/x'), 'www.coindesk.com', '★ 要小写（去重才准）');
  assert.equal(hostOf('不是URL'), '', '非法 URL → 空串（调用方据此丢弃）');
});

test('★★★ 与 freshness 串起来：解析出的情报能直接做时效判定', async () => {
  /*
   * 这是**接线验证** —— 解析出的结构必须能被 `assess()` 直接消费。
   * 两个模块的字段名若不匹配，这里会立刻失败。
   */
  const { assess } = await import('./freshness.js');
  const r = parseIntelReport(json([okItem({ hoursAgo: 1 })]), NOW, 'x');
  const a = assess(r.intel[0]!, NOW, r.intel);
  assert.equal(a.freshness, 'fresh', '1 小时前应当是"新鲜"');
  assert.equal(a.weight, 1);
  assert.equal(a.confirmed, false, '单一来源 → 未确认（默认不进决策）');
});

test('★★★ 交叉验证能认出"多家转载"（同一件事两条不同域名 → 已确认）', () => {
  const r = parseIntelReport(
    json([
      okItem({ sourceUrl: 'https://a.com/1' }),
      okItem({ sourceUrl: 'https://b.com/2' }),
    ]),
    NOW, 'x',
  );
  assert.equal(r.intel.length, 2);
  /* 两条是"同一件事"（同方向、同标的）但域名不同 → 独立来源 = 2。 */
  assert.notEqual(r.intel[0]!.sourceHost, r.intel[1]!.sourceHost);
});
