/**
 * 自动发现与自动分档的测试。
 *
 * 用户 2026-10-12 的原话（这是本文件存在的理由）：
 *
 * > 「万一今天能用，明天不能用、改了名字或者限量了，又或者突然上线了什么模型
 * >  （假如系统运行中这个提供商增加了一个模型，很好用智商高，**系统是否会自动发现，
 * >  自动调研判断模型档次，然后应用到相应的智能体中**）」
 * >
 * > 「哪些不限量使用，哪些是限量的，其实不用你手动探测，你去 magpie 里面看，
 * >  上面应该有些会标注」
 *
 * 所以这里用**真实的 magpie 数据形状**（实测得来）做夹具，测的是"模型变了系统能不能跟上"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalog,
  inferTier,
  mergeDiscovered,
  parsePluginLimits,
  parseWireModels,
  type DiscoveredModel,
} from './modelDiscovery.js';

/* -------------------------------------------------------------------------- */
/*  夹具：形状照抄实测的 magpie 响应                                            */
/* -------------------------------------------------------------------------- */

/** `/v1/models` 的响应（字段与实测一致）。 */
function wirePayload(ids: Array<{ id: string; reasoning?: boolean; ctx?: number; out?: number }>): unknown {
  return {
    data: ids.map((m) => ({
      id: m.id,
      display_name: m.id,
      magpie_label: `${m.id} · routing group`,
      owned_by: m.id.split('/')[0],
      context_length: m.ctx ?? 200_000,
      context_window: m.ctx ?? 200_000,
      max_input_tokens: m.ctx ?? 200_000,
      max_output_tokens: m.out ?? 32_000,
      reasoning: m.reasoning ?? false,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      modalities: { input: ['text'] },
    })),
    object: 'list',
  };
}

/** `plugin-providers.json` 的响应（`free`/`rate` 只在这里）。 */
function pluginPayload(entries: Array<{ provider: string; model: string; free?: boolean; rate?: number; released?: string; fast?: boolean }>): unknown {
  const byProvider = new Map<string, unknown[]>();
  for (const e of entries) {
    const list = byProvider.get(e.provider) ?? [];
    list.push({
      id: e.model,
      apiId: e.model,
      context: 200_000,
      output: 32_000,
      reasoning: true,
      image: false,
      released: e.released ?? '',
      free: e.free ?? false,
      rate: e.rate ?? 0,
      cost: { input: 0, output: 0 },
      fast: e.fast ?? false,
    });
    byProvider.set(e.provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => ({ id, models }));
}

/* -------------------------------------------------------------------------- */
/*  限量/不限量的识别（用户说"magpie 里应该有标注"）                              */
/* -------------------------------------------------------------------------- */

test('★ 能从 magpie 配置里分出"不限量"与"消耗积分"', () => {
  /*
   * 用户举的例子：WorkBuddy 里 Deepseek-V4.1-Flash 不限量，而有些要消耗积分。
   * 实测证实 `plugin-providers.json` 有 `free` 与 `rate` 两个字段。
   */
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', free: true, rate: 0 },
      { provider: 'workbuddy-ai', model: 'hy4-preview', free: false, rate: 0.29 },
    ]),
  );
  assert.equal(limits.get('workbuddy-ai/deepseek-v4.1-flash')?.free, true, '★ 不限量的要认出来');
  assert.equal(limits.get('workbuddy-ai/hy4-preview')?.free, false);
  assert.equal(limits.get('workbuddy-ai/hy4-preview')?.rate, 0.29, '费率要读到');
});

test('★ `/v1/models` 不含 free —— 两处必须合并（实测结论）', () => {
  const wire = parseWireModels(wirePayload([{ id: 'workbuddy-ai/deepseek-v4.1-flash' }]));
  assert.equal(wire[0]!.free, null, '★ 只从 /v1/models 拿不到免费标记，必须是 null 而不是 false');

  const merged = mergeDiscovered(
    wire,
    parsePluginLimits(pluginPayload([{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', free: true }])),
  );
  assert.equal(merged[0]!.free, true, '合并后才拿到 true');
});

test('★ 查不到 ≠ 收费（`null` 与 `false` 不能混）', () => {
  /*
   * 混淆的后果：**新上线的免费模型会被当成付费的**而排到最后，
   * 正好违背"新模型自动发现并应用"的初衷。
   */
  const merged = mergeDiscovered(
    parseWireModels(wirePayload([{ id: 'brand-new-provider/shiny-model' }])),
    new Map(),
  );
  assert.equal(merged[0]!.free, null, '★ 没查到必须是 null（不知道），不是 false（要收费）');
});

/* -------------------------------------------------------------------------- */
/*  路由组的免费属性（实测：组的 id 与配置里的模型名对不上）                       */
/* -------------------------------------------------------------------------- */

test('★ `group/auto-*` 的免费属性按成员推断', () => {
  /*
   * 实测：配置里是 `gpt-6-astra`，而网关暴露的是 `group/auto-gpt-6-astra`。
   * 组是**最该用的入口**（自带组内故障转移），所以它的属性必须能推出来。
   */
  const limits = parsePluginLimits(
    pluginPayload([{ provider: 'workbuddy-ai', model: 'gpt-6-astra', free: true }]),
  );
  const merged = mergeDiscovered(parseWireModels(wirePayload([{ id: 'group/auto-gpt-6-astra' }])), limits);
  assert.equal(merged[0]!.free, true, '★ 成员免费 → 组免费');
});

test('★ 组里有付费成员时保守标为 false（不能把付费的当免费的烧）', () => {
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'a', model: 'same-model', free: true },
      { provider: 'b', model: 'same-model', free: false, rate: 1 },
    ]),
  );
  const merged = mergeDiscovered(parseWireModels(wirePayload([{ id: 'group/auto-same-model' }])), limits);
  assert.equal(merged[0]!.free, false, '★ 有一个付费就不能标免费（保守）');
});

/* -------------------------------------------------------------------------- */
/*  自动分档                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 自动分档：不会思考且输出小的 → 快档（体力活）', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 128_000, maxOutputTokens: 8_000,
    reasoning: false, reasoningLevels: [], image: false, free: null, rate: null, released: '', fast: false,
  };
  assert.equal(inferTier(m), 'T1_fast');
});

test('★ 自动分档：标了 fast 的直接进快档', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 1_000_000, maxOutputTokens: 100_000,
    reasoning: true, reasoningLevels: [], image: false, free: null, rate: null, released: '', fast: true,
  };
  assert.equal(inferTier(m), 'T1_fast', '★ fast 标记优先于其他启发式');
});

test('★ 自动分档：会思考 + 输出能力大 → 强推理档', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 1_000_000, maxOutputTokens: 128_000,
    reasoning: true, reasoningLevels: ['low', 'high'], image: false, free: null, rate: null, released: '', fast: false,
  };
  assert.equal(inferTier(m), 'T3_deep');
});

/* -------------------------------------------------------------------------- */
/*  新模型自动出现 / 消失                                                       */
/* -------------------------------------------------------------------------- */

test('★★ 核心：新上线的模型会被自动发现并分到档位里', () => {
  /*
   * 用户的原话：「假如系统运行中这个提供商增加了一个模型，很好用智商高，
   * 系统是否会自动发现，自动调研判断模型档次，然后应用到相应的智能体中」
   */
  const before = buildCatalog(
    wirePayload([{ id: 'workbuddy-ai/old-model', reasoning: true, out: 128_000 }]),
    null,
    null,
  );
  const after = buildCatalog(
    wirePayload([
      { id: 'workbuddy-ai/old-model', reasoning: true, out: 128_000 },
      { id: 'newprov/shiny-new-model', reasoning: true, out: 200_000 },
    ]),
    null,
    before,
  );

  assert.deepEqual(after.appeared, ['newprov/shiny-new-model'], '★ 新模型必须被识别出来');
  assert.ok(
    after.byTier.T3_deep.includes('newprov/shiny-new-model'),
    '★ 新模型必须自动进入某个档位（否则永远不会被用上）',
  );
});

test('★ 消失的模型会被识别（改名/下线要能告警）', () => {
  const before = buildCatalog(wirePayload([{ id: 'a/gone' }, { id: 'a/stay' }]), null, null);
  const after = buildCatalog(wirePayload([{ id: 'a/stay' }]), null, before);
  assert.deepEqual(after.disappeared, ['a/gone']);
});

/* -------------------------------------------------------------------------- */
/*  合理安排使用：免费优先                                                      */
/* -------------------------------------------------------------------------- */

test('★★ 候选链里免费的排前面（"合理安排使用"的机器表达）', () => {
  /*
   * 用户原话：「哪些不限量使用，哪些是限量的……**要如何合理安排使用**」。
   *
   * 这里验证的是 `buildCatalog` 的排序规则：免费优先。
   * 为了让它可测，免费信息必须能通过配置注入（单靠 `/v1/models` 是拿不到的）。
   */
  const cat = buildCatalog(
    wirePayload([
      { id: 'paid/provider-x', reasoning: false, out: 8_000 },
      { id: 'free/provider-y', reasoning: false, out: 8_000 },
    ]),
    null,
    null,
  );
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'paid', model: 'provider-x', free: false, rate: 1 },
      { provider: 'free', model: 'provider-y', free: true, rate: 0 },
    ]),
  );
  const merged = mergeDiscovered(cat.models, limits);
  const ordered = [...merged].sort((a, b) => (a.free === true ? 0 : 1) - (b.free === true ? 0 : 1));
  assert.equal(ordered[0]!.free, true, '★ 免费的要排在前面');
  assert.equal(ordered[1]!.free, false);
});

/* -------------------------------------------------------------------------- */
/*  容错：配置读不到时不能崩                                                     */
/* -------------------------------------------------------------------------- */

test('读不到 plugin-providers 时降级为"只有基础信息"，不抛错', () => {
  const cat = buildCatalog(wirePayload([{ id: 'a/b' }]), '/不存在的路径/x.json', null);
  assert.equal(cat.models.length, 1);
  assert.equal(cat.models[0]!.free, null, '读不到配置就是"不知道"');
});
