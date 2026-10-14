/**
 * **「回显的模型名与请求的不一致」不能每次调用都刷一行 info**
 *（外部 issue #178）。
 *
 * ## 缺陷经过
 *
 * `llm/client.ts:704-709`：
 *
 * ```ts
 * // The concrete model the provider actually served. This differs from the
 * // configured id on OpenRouter aliases and xAI `latest`, so it is logged.
 * if (parsed.model && parsed.model !== this.model) {
 *   log.info(`${this.provider} 回显的模型名与请求的不一致`, { requested, served });
 * }
 * ```
 *
 * 注释**自己就说明了这是预期情况**（OpenRouter 别名、xAI `latest` 必然回显不同的
 * 具体模型名）。而它用的是 `info` 级别 —— 于是**每次成功调用都打一行**。
 *
 * 线上实测（issue #178 的数字）：最近 300 行运行时日志里
 * **93 行（31%）是同一句**，而同屏只有 4 条「决策」、1 条「平仓」、2 条「错误」。
 *
 * 「数据与日志」页是这个项目的**排障入口**，而被刷掉的那 31% 版面
 * 正是操作员打开它想看的操作线索。
 *
 * ## 为什么这个测试钉"去重"而不是"降级"
 *
 * 单纯把它从 `info` 降到 `debug` 也能止住刷屏（默认 `LOG_LEVEL=info`
 * 会让它消失），但那样**连信号一起丢了**：真出现"服务商换了模型"这件事时，
 * 默认视图里什么都看不到。
 *
 * 更好的形态是**只在它变化时打一次** —— 同一件事重复 93 遍没有信息量，
 * 而"从 A 变成 B"有。所以断言的是"**同一对 (requested, served) 只打一次**"。
 *
 * ## 为什么用源码结构断言
 *
 * `LlmClient` 的构造要 apiKey / provider / baseUrl 等一整套，
 * 而这里要验证的只是"那一行 log 调用有没有去重逻辑"。
 * 起一个假的 HTTP 服务去驱动它，被测的会变成桩。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');

/**
 * 找到**真正的 `log.info` 语句**，而不是注释里引用它的那一处。
 *
 * ⚠️ 本仓库的注释会逐字引用被讨论的代码（这条日志的注释里就写了
 * 那句 msg 文本），所以 `indexOf('回显的模型名…')` 会命中注释 ——
 * 同一个坑在 `startCancellation.test.ts` / `traderStatsNotFound.test.ts` /
 * `inkAlias.test.ts` 都出现过。这里用**代码锚点**（`log.info(` 模板串）定位。
 */
const LOG_ANCHOR = 'log.info(`${this.provider} 回显的模型名与请求的不一致`';
const LOG_IDX = SRC.indexOf(LOG_ANCHOR);

test('★★★ 回显模型名不一致时必须有去重 —— 不能每次成功调用都打一行', () => {
  assert.ok(LOG_IDX > 0, '找不到那段日志 —— 结构变了，请更新本测试');

  /*
   * ⚠️ 判据必须落在**那个 `if` 的判据表达式里**，而不是"文件里存在某个
   * `lastServedModel` 字段"。我第一版就是后者 —— 实测把它改成无条件
   * `if (parsed.model !== this.model)` 之后，那条断言**照样通过**
   *（因为字段声明还在），而第 2 条才失败。一个能被绕过一半的守卫不算守卫。
   */
  const guardStart = SRC.lastIndexOf('if (', LOG_IDX);
  const guardEnd = SRC.indexOf(')', SRC.indexOf('this.model', guardStart));
  const guard = SRC.slice(guardStart, guardEnd + 1);

  assert.ok(
    /lastServedModel/.test(guard),
    '★★★ 去重条件必须写在 `if` 判据里（`parsed.model !== this.lastServedModel`）。\n' +
      '    这条日志原来每次成功调用都打 —— 线上实测占掉日志页 31% 的版面，\n' +
      '    把决策/平仓/错误这些操作线索挤掉（issue #178）。\n' +
      `    实际取到的判据：${guard.trim()}`,
  );

  /* 同时：必须真的记住它（否则"变化"永远检测不出来）。 */
  const after = SRC.slice(LOG_IDX, LOG_IDX + 600);
  assert.ok(
    /this\.lastServedModel\s*=\s*parsed\.model/.test(after),
    '★★★ 打了日志之后必须 `this.lastServedModel = parsed.model` —— ' +
      '否则去重条件永远成立、每轮都会重新打一遍',
  );
});

test('★★★ 这条日志不能是 info 级别的无条件输出', () => {
  /*
   * 第二道保险：即便将来有人把去重逻辑改坏，也不该退回"每次 info"。
   * 允许两种形态之一：
   *   · 去重 + info（只在变化时打，信息量足够）
   *   · 无条件 + debug（默认视图看不到，但 LOG_LEVEL=debug 可查）
   */
  assert.ok(LOG_IDX > 0, '找不到那段日志');

  /* 该语句所在的行。 */
  const lineEnd = SRC.indexOf('\n', LOG_IDX);
  const line = SRC.slice(SRC.lastIndexOf('\n', LOG_IDX) + 1, lineEnd);

  /* 去重条件写在同一行的 `if (...)` 里，往**上**多取到那个 `if`。 */
  const lineStart = SRC.lastIndexOf('\n', LOG_IDX) + 1;
  const guardStart = SRC.lastIndexOf('if (', lineStart);
  const guard = SRC.slice(Math.max(0, guardStart), lineEnd);

  const isInfo = /log\.info\s*\(/.test(line);
  const isDebug = /log\.debug\s*\(/.test(line);
  const deduped = /lastServedModel/.test(guard);

  assert.ok(
    (isInfo && deduped) || isDebug,
    `★★★ 这条日志要么"去重后 info"，要么"无条件 debug" —— 实际是 ` +
      `${isInfo ? 'info' : isDebug ? 'debug' : '其它级别'}${deduped ? '（已去重）' : '（未去重）'}。\n` +
      '    "每次成功调用都打一行 info"是 issue #178 报的刷屏形态。\n' +
      `    取到的语句：${line.trim()}`,
  );
});
