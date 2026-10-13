import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess, decay, rankIntel, INTEL_TTL, type Intel } from './freshness.js';

const H = 3_600_000;
const now = 1_000_000_000_000;

const intel = (over: Partial<Intel> = {}): Intel => ({
  summary: '某交易所宣布上线某币种合约',
  sourceUrl: 'https://a.example.com/x',
  sourceHost: 'a.example.com',
  publishedAt: now - 10 * 60_000, /* 10 分钟前 */
  direction: 'bullish',
  symbols: ['BTCUSDT'],
  by: 'news_hunter',
  ...over,
});

test('★★★ 时效分档：新鲜 1.0 → 衰减 → 过期 0（不是一刀切）', () => {
  /*
   * 用户主动点出了时效性：
   * > 「消息面的东西**常常有时效性**，如果消息面的策略失效后，应当会及时修正、调整」
   *
   * ⚠️ 为什么分档而不是一刀切：消息价值**随时间连续衰减**。
   * 一刀切（"2 小时后完全不用"）会在边界产生突变 ——
   * 1h59m 有用、2h01m 完全没用，那不合理。
   */
  assert.equal(decay(now - 1 * H, now).freshness, 'fresh');
  assert.equal(decay(now - 1 * H, now).weight, 1, '2 小时内满权重');

  const aging = decay(now - 7 * H, now);
  assert.equal(aging.freshness, 'aging');
  assert.ok(aging.weight > 0.5 && aging.weight < 1, `2~12h 应在 0.5~1 之间（实际 ${aging.weight}）`);

  const stale = decay(now - 30 * H, now);
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.weight > 0 && stale.weight < 0.5, `12~48h 应在 0~0.5 之间（实际 ${stale.weight}）`);

  assert.equal(decay(now - 60 * H, now).freshness, 'expired');
  assert.equal(decay(now - 60 * H, now).weight, 0, '★ 过期必须归零 —— 否则旧消息会永久污染决策');
});

test('★ 权重随时间是【单调递减】的（不能有反直觉的回升）', () => {
  let prev = Infinity;
  for (const h of [0, 1, 2, 3, 6, 12, 18, 24, 36, 48, 60]) {
    const w = decay(now - h * H, now).weight;
    assert.ok(w <= prev + 1e-12, `★ ${h} 小时的权重 ${w} 不该高于更早的 ${prev}`);
    prev = w;
  }
});

test('★★★ 交叉验证按【域名】去重 —— 转载不能算多个来源', () => {
  /*
   * ⚠️ 这是防幻觉的关键：
   * 同一个消息被 5 家媒体转载，**仍然只有一个信息源**。
   * 按条数算会把"转载"误判成"5 个来源确认" —— 那是典型的假确认。
   */
  const original = intel({ sourceHost: 'a.example.com' });
  const reposts: Intel[] = [
    intel({ sourceHost: 'b.example.com' }),
    intel({ sourceHost: 'c.example.com' }),
    /* 同域名的重复报道 —— 不该增加"独立来源"数。 */
    intel({ sourceHost: 'a.example.com', sourceUrl: 'https://a.example.com/y' }),
  ];
  const a = assess(original, now, [original, ...reposts]);
  assert.equal(a.independentSources, 3, `★ 独立来源应为 3（a/b/c），而不是 4 条（实际 ${a.independentSources}）`);
  assert.equal(a.confirmed, true);
});

test('★★★ 单一来源 → 【未确认】，默认不进决策', () => {
  /*
   * 一条只有单一来源的消息可能是错的、也可能是谣言。
   * 两个独立来源同时报道才达到"已确认"（新闻业的基本标准）。
   */
  const lone = intel();
  const a = assess(lone, now, [lone]);
  assert.equal(a.independentSources, 1);
  assert.equal(a.confirmed, false, '★ 单一来源不能算已确认');
  assert.ok(a.verdict.includes('未确认'), '结论要明说未确认');

  const ranked = rankIntel([lone], now);
  assert.equal(ranked.length, 0, '★ 未确认的默认被剔除');
  /* 但可以显式要求"带上未确认的"（给人工复核用）。 */
  assert.equal(rankIntel([lone], now, { requireConfirmed: false }).length, 1);
});

test('★★ 不同方向 / 不同标的的报道【不算】同一件事', () => {
  const a = intel({ direction: 'bullish', symbols: ['BTCUSDT'] });
  const diffDir = intel({ sourceHost: 'b.example.com', direction: 'bearish' });
  const diffSym = intel({ sourceHost: 'c.example.com', symbols: ['ETHUSDT'] });
  const r = assess(a, now, [a, diffDir, diffSym]);
  assert.equal(r.independentSources, 1, '★ 方向不同/标的不同的报道不能互相"确认"');
});

test('★ 排序：权重降序，同权重时新的优先', () => {
  const mk = (host: string, hoursAgo: number): Intel =>
    intel({ sourceHost: host, publishedAt: now - hoursAgo * H });
  /* 两条都已确认（各自有 peer），但一新一旧。 */
  const fresh1 = mk('a.example.com', 0.5);
  const fresh2 = mk('b.example.com', 0.5);
  const old1 = mk('c.example.com', 10);
  const old2 = mk('d.example.com', 10);
  const ranked = rankIntel([old1, old2, fresh1, fresh2], now);
  assert.equal(ranked.length, 4);
  assert.ok(
    ranked[0]!.assessment.weight >= ranked[3]!.assessment.weight,
    '★ 权重高的排前面',
  );
  assert.ok(
    ranked[0]!.intel.publishedAt > ranked[3]!.intel.publishedAt,
    '★ 同权重时新的优先',
  );
});

test('★ 过期的即使"已确认"也不进决策', () => {
  const old1 = intel({ sourceHost: 'a.example.com', publishedAt: now - 100 * H });
  const old2 = intel({ sourceHost: 'b.example.com', publishedAt: now - 100 * H });
  assert.equal(rankIntel([old1, old2], now).length, 0, '★ 过期就是过期');
});

test('★ 未来时间戳（时钟偏差）不产生超过 1 的权重', () => {
  const future = intel({ publishedAt: now + 5 * H });
  const d = decay(future.publishedAt, now);
  assert.equal(d.weight, 1, '★ 时钟偏差不该让权重超过 1（上限必须是 1）');
  assert.equal(d.ageMs, 0, '负的 age 应被夹到 0');
});

test('★ TTL 分档自洽（新鲜 < 衰减结束 < 过期）', () => {
  assert.ok(INTEL_TTL.FRESH_MS < INTEL_TTL.DECAY_END_MS);
  assert.ok(INTEL_TTL.DECAY_END_MS < INTEL_TTL.EXPIRE_MS);
});
