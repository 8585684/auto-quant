import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * **调研提示词必须产出 `freshness.ts` 能用的字段**（防漂移）。
 *
 * ## 2026-10-13 重写：断言点从 `manager.ts` 移到 `hunters.ts`
 *
 * 原来这些断言读的是 `manager.ts` 里那段**内联的调研提示词**。
 * 而 2026-10-13 把调研拆成了**四个猎手**（`intel/hunters.ts`），
 * 提示词由 `buildHunterTask()` 生成 —— 于是断言点跟着搬家。
 *
 * ⚠️ **这个测试当场抓到了一个真回归**：我第一版的新提示词里
 * **丢了"多来源"那条要求** —— 而它是 `freshness.ts` 交叉验证的输入。
 * 若没有这条测试，那个回归会静默上线。
 *
 * ## 同时纠正了一个**过去的误解**
 *
 * 旧提示词写着「同一件事若有多家媒体报道，列在同一条下面（各自带链接）」，
 * 而我以为那就是交叉验证的输入。**实际上不是** ——
 * `parseIntel` 每条情报**只读一个 `sourceUrl`**，
 * 而 `freshness.ts` 的 `independentSources` 是**代码算出来的**：
 * ```
 *   把【同方向 + 同标的】的情报归为一组，数其中不同域名的个数
 *   ≥ 2 → confirmed（真交叉验证）
 * ```
 * 所以"列在同一条下面"那条要求**解析器根本用不上**。
 *
 * **而多猎手设计反而让交叉验证真正生效**：四个猎手来自不同信息源，
 * 同一件事可能被各自独立报道 → 落到**不同情报条目、不同域名** →
 * `independentSources ≥ 2`。那才是真的交叉验证。
 *
 * 所以这一条现在断言的是**机制**（四个猎手 = 四个独立来源），
 * 而不是一句解析器读不到的提示词。
 *
 * 与 `ROLE_TIERS` 的防漂移测试同一性质：**要求可以被改，但不能被悄悄删掉。**
 */
const HUNTERS_SRC = readFileSync(new URL('./intel/hunters.ts', import.meta.url), 'utf8');

test('★★★ 猎手提示词要求"发布时刻"（freshness 衰减的输入）', () => {
  /*
   * 用户原话：
   * > 「消息面的东西**常常有时效性**，如果消息面的策略失效后，应当会及时修正、调整」
   *
   * 而 `intel/freshness.ts` 的衰减需要 `publishedAt` —— 它只能来自模型产出。
   *
   * ⚠️ 现在的形状是**相对小时数** `hoursAgo`（不是日期字符串）——
   * 那是刻意的：散文里的"3 小时前"/"昨天"/"最近"**无法机械转成时间戳**，
   * 而猜错的代价是静默的（3 天前的消息被当成"现在"进入决策）。
   */
  assert.ok(HUNTERS_SRC.includes('hoursAgo'), '★ 缺了它 → 衰减逻辑会空转（publishedAt 只能填"现在"）');
  /*
   * ── 2026-10-13 加强（实测后改）────────────────────────────────────────
   *
   * 旧的断言是 `includes('多久之前发布')` —— 一句**散文要求**。
   * 实测发现它**不够**：
   * ```
   *   · coinstats.app · 72.0h前 · weight=0.00 · confirmed=false
   *   · www.forbes.com · 72.0h前 · weight=0.00 · confirmed=false
   *   · pluang.com    · 24.0h前 · weight=0.33 · confirmed=false
   * ```
   * 猎手**照做了**（给了 `hoursAgo`），但它给的是**几天前的旧闻** ——
   * 而 `freshness` 的 TTL 把 >48h 的判为 `weight=0` 直接丢弃。
   * 也就是说：模型不知道"我报的东西会被怎么用"，于是把**不会被采用的**也报了。
   *
   * 所以提示词要**说清后果与边界**：
   *   ① 48 小时之外会被丢弃 → 只报最近 48 小时内的；
   *   ② `hoursAgo` 必须是**数字**（类型不对整条被丢）。
   */
  assert.ok(
    HUNTERS_SRC.includes('48 小时'),
    '★ 必须告诉模型时效边界（否则它会把几天前的旧闻报上来，然后被静默丢弃）',
  );
  assert.ok(
    HUNTERS_SRC.includes('**`hoursAgo` 必须是数字**'),
    '★ 必须强调类型（写成字符串会让那一条整条被丢弃）',
  );
});

test('★★★ 四个猎手 = 四个独立来源（交叉验证的真正输入）', () => {
  /*
   * ⚠️ 这条**替换了**旧测试「同一件事的多家报道列在一起」。
   *
   * 理由见文件头：那条要求**解析器读不到**（`parseIntel` 每条只读一个 `sourceUrl`），
   * 而真正的交叉验证靠"**同一事件被不同来源各自报道**"。
   *
   * 多猎手设计让这件事自然发生：新闻猎手看财经媒体、社区猎手看推特/广场、
   * 资金猎手看链上与资金数据 —— **它们的域名天然不同**。
   */
  assert.ok(
    HUNTERS_SRC.includes('news_hunter') &&
      HUNTERS_SRC.includes('community_hunter') &&
      HUNTERS_SRC.includes('flow_hunter'),
    '★ 至少要有新闻/社区/资金三类猎手 —— 否则"交叉验证"只是同一来源自说自话',
  );
  assert.ok(
    HUNTERS_SRC.includes('交叉验证'),
    '★ 源码里应当写明"为什么多猎手能支撑交叉验证"（防后来者以为它只是并行加速）',
  );
});

test('★ 提示词仍要求"带来源链接"与"查不到就明说"（原有要求不能被覆盖掉）', () => {
  assert.ok(HUNTERS_SRC.includes('sourceUrl'), '来源链接是防幻觉的第一道闸');
  assert.ok(HUNTERS_SRC.includes('不要用常识'), '防"用常识填充成新闻"');
  assert.ok(HUNTERS_SRC.includes('空数组'), '查不到时输出空数组 —— 那是正确答案，不是失败');
});

test('★ `manager.ts` 必须真的用猎手（否则提示词只是个没人用的模块）', () => {
  /*
   * ⚠️ 本项目反复踩过"**实现了逻辑 ≠ 逻辑在生效**"：
   * `freshness` 曾在跑但输入字段不存在；`signalHealth` 因链断而永远
   * 返回 `insufficient_data`；四个 magpie 路由组建了 30 轮却从未接线。
   *
   * 所以这一条钉住"接线本身"。
   */
  const manager = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');
  assert.ok(manager.includes('buildHunterTask'), '★ manager 必须调用 buildHunterTask');
  assert.ok(manager.includes('mergeHunterReports'), '★ 必须合并各猎手产出');
  assert.ok(manager.includes('summariseHunters'), '★ 必须把"哪几个来源缺"写进日志');
});
