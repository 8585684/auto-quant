/**
 * **策略编辑器的「新建 vs 更新」判据必须处处一致**（外部 issue #164）。
 *
 * ## 这个测试防的是什么
 *
 * `save()` 原来只看 `isNew`，而按钮 label 看的是 `isNew && state.id === 0` ——
 * 同一件事在同一文件里有两个判据，于是它们分叉：
 *
 * ```
 *   isNew = params.id === 'new'          ← 由 URL 派生
 *   create 分支刻意不 navigate 改 URL     ← 体检需要那个服务端 id
 *   → 创建成功、state.id 变成 #12 之后，isNew 仍然为 true
 * ```
 *
 * 后果：用户点着「保存修改」（label 用正确判据），实际**又建了一条 #13**，
 * 而 #12 上的这次编辑被静默丢弃。每改一次就分裂出一条副本 ——
 * 而门控的是实盘交易配置页。
 *
 * ## 为什么用「源码结构断言」而不是行为测试
 *
 * 本仓库的 web 测试脚本是 `tsx --test "src/**\/*.test.ts"`，
 * **只收 `.test.ts`、没有 jsdom / React Testing Library** ——
 * 无法挂载组件、触发 `useEffect` 与 `onClick`。缺陷完全活在 `save()` 的闭包与
 * effect 里，所以行为测试在本仓库现有基建下写不出来。
 *
 * 但**本缺陷的根因是「判据分叉」**，而那件事在源码结构上完全可观测：
 * 只要断言"所有消费该判据的地方用的是同一个表达式"，
 * 将来有人把 `save()` 改回只看 `isNew` 时它就会红。
 * 这与 `trader/startCancellation.test.ts`、`trader/researchLifecycle.test.ts`
 * 是同一类判断：**接线一致性缺陷的可观测面就在源码结构上**。
 *
 * ⚠️ 它**不能**证明运行时行为 —— 那一半仍需人工在浏览器点一次
 *（本 PR 的作者也诚实标注了没点过）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('../pages/StrategyEditorPage.tsx', import.meta.url), 'utf8');

/** 1-based 行号，便于把断言失败直接对到源码。 */
function lineOf(index: number): number {
  return SRC.slice(0, index).split('\n').length;
}

test('★★★ save() 的 create 判据必须与按钮 label 一致（isNew && state.id === 0）', () => {
  /*
   * `save()` 里的 `if (isNew && state.id === 0)` —— 这是本修复的核心。
   * 断言**精确到这个表达式**，而不是"文件里某处有 state.id === 0"：
   * 后者在 label 与 SaveState 里早就成立，正是缺陷原状（判据分叉）。
   */
  const saveGuard = /if\s*\(\s*isNew\s*&&\s*state\.id\s*===\s*0\s*\)/.exec(SRC);
  assert.ok(
    saveGuard,
    '★★★ save() 的 create 分支必须用 `isNew && state.id === 0` —— ' +
      '只看 isNew 会让第二次保存再建一条策略，而用户看到的是「保存修改」',
  );

  /* 该判据必须出现在 create 调用之前（否则等于没拦）。 */
  const createIdx = SRC.indexOf('api.createStrategy(');
  assert.ok(createIdx > 0, '找不到 api.createStrategy 调用');
  assert.ok(
    saveGuard.index < createIdx,
    `判据必须在 createStrategy 调用之前。判据在第 ${lineOf(saveGuard.index)} 行，` +
      `createStrategy 在第 ${lineOf(createIdx)} 行`,
  );
});

test('★★★ 只看 isNew 的 create 分支不允许存在（那正是被修的写法）', () => {
  /*
   * `if (isNew) {` 这种裸判据**不能**再出现在 save 的 create 分流里。
   *
   * ⚠️ 但文件里**合法**地存在另一处 `if (isNew)`：初始化 effect
   *（`if (isNew) { if (!catalog) … }`，用于"URL 是 /new 时加载预设目录"）——
   * 那判的是"URL 是不是 /new"，与"要不要 create"是**不同语义**，不该改。
   *
   * 所以这里按"裸 `if (isNew)` 与 `api.createStrategy(` 的距离"判定：
   * 若某个裸判据紧邻 create 调用（同一分支内），说明 create 分流被改回去了。
   */
  const createIdx = SRC.indexOf('api.createStrategy(');
  assert.ok(createIdx > 0, '找不到 api.createStrategy 调用');

  /* 取 create 调用之前最近的 400 字符窗口，检查里面有没有裸 `if (isNew) {`。 */
  const window = SRC.slice(Math.max(0, createIdx - 400), createIdx);
  const bare = /if\s*\(\s*isNew\s*\)\s*\{/.exec(window);
  assert.equal(
    bare,
    null,
    '★★★ create 分流里出现了裸 `if (isNew)` —— 那正是本 issue 的缺陷写法：' +
      '创建后 isNew 仍为 true，第二次保存会再建一条。' +
      '正确判据是 `isNew && state.id === 0`',
  );
});

test('★ 初始化 effect 里那处 isNew 是不同语义，不该被"顺手统一"', () => {
  /*
   * 反向守卫：防止下一个人为了"判据统一"把初始化 effect 也改成
   * `isNew && state.id === 0` —— 那会让"URL 是 /new 但已有 id"时不加载预设目录。
   *
   * 这里只断言它**仍然存在**（用 `if (isNew)` 判 URL），
   * 说明"分叉"与"不同语义"是两回事，本测试的意图是前者。
   */
  const initIdx = SRC.indexOf('if (isNew) {');
  assert.ok(
    initIdx > 0,
    '找不到初始化 effect 里的 `if (isNew)` —— 若它被"统一"成了别的判据，' +
      '请确认 URL 为 /new 时仍会加载预设目录',
  );
  assert.ok(
    initIdx < SRC.indexOf('api.createStrategy('),
    '前提：初始化 effect 在 save 之前（本测试依赖这个结构）',
  );
});
