/**
 * **版本识别与过时淘汰**的测试（2026-10-13）。
 *
 * ⚠️ 这些用例里的模型名**全部来自 magpie 网关的真实清单**（我实测拉下来的），
 * 不是编的 —— 因为这套逻辑的全部价值就在于"对真实命名有效"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSuperseded, findSuperseded, parseModelId } from './modelFamilies.js';

test('★★★ 解析：把"家族 / 型号 / 版本"分开', () => {
  /* 基本形状 */
  assert.deepEqual(parseModelId('trae-cn/glm-5.3'), {
    family: 'glm',
    variant: '',
    version: [5, 3],
  });
  /* 带型号后缀 */
  assert.deepEqual(parseModelId('trae-cn/glm-5.3-flash'), {
    family: 'glm',
    variant: 'flash',
    version: [5, 3],
  });
  /* `v` 前缀 */
  assert.deepEqual(parseModelId('workbuddy-ai/deepseek-v4.1-flash'), {
    family: 'deepseek',
    variant: 'flash',
    version: [4, 1],
  });
  /* 无版本号的别名 */
  assert.deepEqual(parseModelId('opencode-go/deepseek-flash'), {
    family: 'deepseek',
    variant: 'flash',
    version: null,
  });
  /* 多段型号（`official-max`）*/
  assert.deepEqual(parseModelId('trae-cn/DeepSeek-V4-Flash-Official-max'), {
    family: 'deepseek',
    variant: 'flash-official-max',
    version: [4],
  });
});

test('★★★ 规则①：同家族同型号 → 只留最高版本（glm 5.1/5.2/5.3）', () => {
  /*
   * 用户原话：
   * > 「可以使用最新的版本模型不同型号（例如 glm5.3、glm5.3 flash、glm5.3 flashx），
   * >  但不能使用过时淘汰的模型」
   */
  const ids = [
    'trae-cn/glm-5.1',
    'trae-cn/glm-5.2',
    'trae-cn/glm-5.3',
    'trae-cn/glm-5.3-flash',
  ];
  const { kept, removed } = filterSuperseded(ids);
  assert.deepEqual(kept, ['trae-cn/glm-5.3', 'trae-cn/glm-5.3-flash']);
  assert.equal(removed.length, 2);
  assert.ok(removed.every((r) => r.by === 'trae-cn/glm-5.3'));
});

test('★★★ 型号不同则互不淘汰（glm-5.3 与 glm-5.3-flash 并存）', () => {
  /* 用户明确要求"不同型号可以用" —— 型号是**用途区分**，不是版本。 */
  const { removed } = filterSuperseded(['trae-cn/glm-5.3', 'trae-cn/glm-5.3-flash']);
  assert.equal(removed.length, 0, '★ flash 是型号不是旧版本');
});

test('★★★ 规则②：同供应商的无版本别名要剔除（用户亲自提醒过）', () => {
  /*
   * 用户原话：
   * > 「deepseek-v4.1-flash 有 2 个名字（实际都是一个模型，不同厂商会不一样\\混用，
   * >  你得知道）：deepseek-v4.1-flash 和 deepseek flash」
   *
   * ⚠️ 若两个名字都留在候选链里，就是**同一个模型白试两次**。
   */
  const ids = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-flash'];
  const { kept, removed } = filterSuperseded(ids);
  assert.deepEqual(kept, ['opencode-go/deepseek-v4.1-flash']);
  assert.equal(removed.length, 1);
  assert.match(removed[0]!.reason, /别名/);
});

test('★★★ 跨供应商的"同一模型"不算重复 —— 那是冗余，要保留', () => {
  /*
   * ⚠️ 这是本规则最容易搞错的地方：
   * `workbuddy-ai/deepseek-v4.1-flash` 与 `opencode-go/deepseek-v4.1-flash`
   * 是**不同供应商**，各有各的额度 —— 它们是"多路冗余"，**必须都留**。
   * 用户说的"只有 opencode-go 花钱、其他免费"，正说明这些是不同的资源。
   */
  const ids = [
    'workbuddy-ai/deepseek-v4.1-flash',
    'workbuddy/deepseek-v4.1-flash',
    'trae-cn/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
  ];
  const { removed } = filterSuperseded(ids);
  assert.equal(removed.length, 0, '★ 跨供应商是冗余，不是重复');
});

test('★★★ 别名只在【同供应商内】才剔除', () => {
  /* `workbuddy-ai/deepseek-flash` 是别名 → 剔除；
     但 `opencode-go/deepseek-flash` 与 `workbuddy-ai/deepseek-v4.1-flash`
     之间没有"同供应商"关系 → 都不动。 */
  const ids = [
    'workbuddy-ai/deepseek-v4.1-flash',
    'workbuddy-ai/deepseek-flash',
    'opencode-go/deepseek-flash',
  ];
  const { removed } = filterSuperseded(ids);
  assert.deepEqual(
    removed.map((r) => r.id),
    ['workbuddy-ai/deepseek-flash'],
    '★ 只有同供应商的那个别名该剔除',
  );
});

test('★★★ 真实清单：trae-cn 的 V4-Flash 被 V4.1 取代', () => {
  /*
   * 实测（2026-10-13）：magpie 上 trae-cn 同时有
   * `DeepSeek-V4-Flash` 与 `deepseek-v4.1-flash` —— 前者是**淘汰版本**。
   */
  const ids = [
    'trae-cn/deepseek-v4.1-flash',
    'trae-cn/DeepSeek-V4-Flash',
    'trae-cn/deepseek-v4.1-flash-max',
    'trae-cn/DeepSeek-V4-Flash-max',
  ];
  const { kept, removed } = filterSuperseded(ids);
  assert.deepEqual(kept, ['trae-cn/deepseek-v4.1-flash', 'trae-cn/deepseek-v4.1-flash-max']);
  assert.equal(removed.length, 2);
  /* 两条都以 4.1 版本为替代。 */
  assert.ok(removed.every((r) => r.by.includes('v4.1')));
});

test('★ 没有版本号且无同供应商兄弟 → 保留（不能因为"没版本"就删）', () => {
  /*
   * ⚠️ 若把"无版本"一律当重复删掉，会删掉真模型
   *（例如某供应商只提供一个不带版本号的名字）。
   */
  const ids = ['kiro/deepseek-3.2', 'someprovider/mystery-model'];
  const { kept } = filterSuperseded(ids);
  assert.deepEqual(kept, ids);
});

test('★ 空清单与单元素清单不出错', () => {
  assert.deepEqual(filterSuperseded([]).kept, []);
  assert.deepEqual(filterSuperseded(['a/b']).removed, []);
});

test('★ 理由可追溯 —— 每条剔除都要说明"被谁取代"', () => {
  const { removed } = filterSuperseded(['trae-cn/glm-5.1', 'trae-cn/glm-5.3']);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.by, 'trae-cn/glm-5.3');
  assert.ok(removed[0]!.reason.length > 0);
});
