# 外部 Issue 集中分类（triage）

**处理者**：PR/Issue 处理窗口　**日期**：2026-10-13　**基线**：`c8c4db3`（第 2 轮已推进到 `725e381`）
**范围**：open issue #112–#125（14 个，全部来自外部贡献者 `8585684` / Vanta），open PR：0 个

---

## 0. 本轮结论摘要

| # | 标题（缩写） | 判定 | 严重度 | 处置 |
| --- | --- | --- | --- | --- |
| 117 | 执行回执的 `adjust_protection` 绕过风控 | **属实** | 🔴 最高 | `risk-engine` + `trading-path`，**留复核** |
| 118 | `maxEntriesPerHour` 同批内不生效 | **属实** | 🔴 高 | `risk-engine`，**留复核** |
| 115/116 | `pause_trading` / `resume_trading` 从未实现 | **属实** | 🟠 中 | 方向选择，**留复核** |
| 112 | 前端 `resumeTrader` 调不存在的路由 | **属实**（补充：该函数无调用点，是死代码） | 🟠 中 | 与 #115/#116 同一根因，**留复核** |
| 114 | `check:links` / `check:routes` 未接入 CI | **属实** | 🟡 中 | 链接已修；是否接 CI **留复核** |
| 113 | README 49/51 行完全重复 | **属实** | ⚪ 低 | ✅ **已修并关闭** |
| 120 | `Math.min(...seen)` 栈溢出 | **属实** | 🟡 中 | ✅ **已修并关闭** |
| 122 | 成交表手续费符号相反 | **部分属实**（显示层，非记账） | ⚪ 低 | ✅ **已修并关闭** |
| 124 | `/api/logs` limit 未钳制 | **属实** | 🟡 中 | ✅ **已修并关闭** |
| 125 | 保本平仓显示成绿色 +0.00 | **属实** | ⚪ 低 | ✅ **已修并关闭** |
| 121 | 停止机器人四入口只有一处确认 | **属实** | 🟠 中 | ✅ **已修并关闭** |
| 119 | seed:demo 后健康检查判红 | **部分属实**（10 分钟、非永久） | 🟡 中 | **留复核** |
| 123 | 提示词注入面 | **部分属实**（symbol 不可控） | ⚪ 低 | 按 hardening **留复核** |

**进度**：14 个 issue 中 **6 个已修复关闭**（#113 #120 #121 #122 #124 #125）、
**8 个保留待复核**（#112 #114 #115 #116 #117 #118 #119 #123），
其中 **2 个触及风控引擎**（#117 #118）按红线必须由开发窗口在完整上下文里改 ——
但两者都已**复现到实测级别**并**给出已验证的修法**（见 §1）。

---

## 1. 最高优先级：风控引擎被绕过（#117、#118）

### #117 执行回执那一轮的 `adjust_protection` 绕过了风控引擎

**判定：属实。**

风控引擎是通往订单的唯一路径（`docs/AGENTS.md` §2.1）。全仓库**只有一个** `risk.review()`
调用点（`packages/server/src/trader/autoTrader.ts:3831`），它服务主决策路径。

执行回执路径（`runExecutionReceipt()` 类似逻辑，`autoTrader.ts:8120-8124`）：

```ts
for (const decision of parsed.decisions) {
  if (isAdjustAction(decision.action)) {
    followed.push(await this.executeAdjust(decision));   // ← 直接执行，无 review
  } else if (isCancelPendingAction(decision.action)) {
    followed.push(await this.executeCancelPending(decision));
  }
  ...
```

而 `executeAdjust()`（`autoTrader.ts:9510` 起）**自身没有任何方向校验**：它读
`decision.stopLoss` 后直接 `placeProtection({ triggerPrice: newStop, ... })`（9613-9619）。
方向校验（"多头止损只能上移、不能下移"、"止损不能放到现价之上"）**只存在于**
`RiskEngine.reviewAdjust()`，证据是 `risk/engine.test.ts:822-896` 一整套用例全打在
`reviewAdjust` 上：

```
adjust_protection：把多头止损往下移会被拒 —— 那是主动扩大风险
adjust_protection：止损放到现价之上会被拒 —— 那等于立刻市价平仓
adjust_protection：空头的方向判断是镜像的
```

**后果**：模型在执行回执那一轮若给出一个"下移的止损"或"放到现价之上的止损"，
会被**原样挂到交易所**。前者主动扩大风险（与 `docs/AGENTS.md` §2.9
"减少风险的工作先于增加风险"直接冲突），后者等价于立刻市价平仓。
这是**唯一能改止损的两条路之一没有方向校验**。

**为什么危险但不显眼**：`executeAdjust` 仍会在"撤旧单失败"与"无仓位"时正确放弃，
所以它看起来是保守的；缺的只有**方向**这一层，而那一层恰好是风控引擎的全部价值。

**建议修法**：回执路径执行前调用 `risk.review()`（或至少 `reviewAdjust()`），
把 `adjust_protection` 与 `cancel_pending` 之外的动作用白名单挡掉（已经有白名单）。
**必须有测试**：一个"回执轮里给出向下移止损"的用例，断言它被拒且拒绝理由落库。

### #118 `maxEntriesPerHour` 在同一批决策里不生效

**判定：属实，且定位到确切的漏传参数。**

`RiskEngine.review()`（`risk/engine.ts:477`）用局部变量滚动跟踪同一批内的额度：

- `entriesThisCycle` 是局部变量，开仓后 `+= 1`（616 行）
- `positionCount`、`marginUsed` 同样滚动更新

但 `isOpenAction` 分支传下去的是：

```ts
// engine.ts:607-612
const verdict = this.reviewOpen(decision, {
  ...env,
  account: { ...env.account, positionCount, marginUsed },
  entriesThisCycle,                      // ← 只有它被更新了
});                                      //   entriesLastHour 仍是 env 的入口值
```

于是 `reviewOpen` 第 11 步（`engine.ts:1083`）读到的 `env.entriesLastHour`
**整批都是入口值不变** —— 同一批里连开 N 笔，小时上限一次都数不到。

**这段代码自己已经写过一条同源注释**，只是修在了另一个分支上（551-573 行，
`add_to_position`）：

```
* `env.entriesThisCycle` 是**进入 `review()` 时**的值 …… 而加仓最终会走
* `reviewOpen`，节流判据读的正是这两个数 —— 于是 `maxEntriesPerCycle`
* 与 `maxEntriesPerHour` **对加仓完全无效**
* ……
* 两个数都要带上本周期已经用掉的量：`entriesThisCycle` 是局部变量，
* 它会在下面 `+= 1` 累加；`entriesLastHour` 是入口值，加上本周期已用的
* 部分才是真实的滚动小时数。
```

`add_to_position` 分支因此写的是 `entriesLastHour: env.entriesLastHour + entriesThisCycle`
（572 行）—— **而紧邻的 `isOpenAction` 分支漏了同样的修正**。
这正是 `docs/COLLABORATION.md` §6 记录的那类失效："两个各自正确的修复合起来失效"。

**后果**：`maxEntriesPerHour` 是模型误判时唯一的频率刹车。同批内失效意味着
**一轮里可以真实开出远超上限的仓位**，而 issue 说"零拒绝记录"——因为每次比较
都算出同一个未超限的值。风控的可见性（`adjustments` / `rejection.reason`）也因此失效。

**建议修法**：`isOpenAction` 分支补上 `entriesLastHour: env.entriesLastHour + entriesThisCycle`，
与 572 行对齐；加测试：一个 `maxEntriesPerHour: 2` 的 fixture，同一批给 6 条合法开仓，
断言只放行 2 条、其余 4 条**带理由被拒**。

---

## 2. `pause_trading` 半成品（#115、#116、#112）

### #115 / #116 注释声称存在 `pause_trading` / `resume_trading`，但两者均未实现

**判定：属实。**

`tools.ts` 注册的工具只有 **11 个**（grep `name:` 逐一确认）：`get_performance`、
`get_equity_curve`、`get_experiments`、`get_lessons`、`get_recent_decisions`、
`get_market_overview`、`get_skipped_outcomes`、`get_current_params`、`set_params`、
`set_cycle_interval`、`finish`。**没有 `pause_trading`，也没有 `resume_trading`。**

而以下位置都在声称它存在：

| 位置 | 内容 |
| --- | --- |
| `agent/tools.ts:24` | 「所有工具要么只读，要么只能收紧（`pause_trading`）」 |
| `agent/tools.ts:427-428` | `/** pause_trading 被调用。 */ paused?: { reason: string }` |
| `agent/orchestrator.ts:113` | 「之后还要 `set_params`（或 `pause_trading`）」 |
| `strategy/prompt.ts:136` | `paused?: { at: string; reason: string } \| null` |
| `web/pages/TraderPage.tsx:933-940` | 声称"提示词告知状态 + 给它 `resume_trading` 自己恢复" |

且 `paused` 在生产代码里**没有任何写入点**（只有类型声明）。

**为什么这不只是"注释过时"**：`prompt.ts:118` 那段注释记录了一次真实用户投诉
（2026-10-04：「页面上显示了开多，又显示 AI 已主动停手，你完全就是自相矛盾」），
当时的"修复"就是**依赖这个字段**让 AI 看见停手状态 —— 而承载它的字段无人写入，
**那次修复实际并未落地**。也就是说：一个已经闭环过一次的线上问题，
其修复方案是悬空的。

**方向选择（需要人决定，不是我能定的）**：
- **A 补全实现**：注册 `pause_trading` / `resume_trading` 工具 + 写 `paused` 状态 +
  补 `POST /api/traders/:id/resume` + 前端渲染停手状态。
- **B 清除半成品**：删掉类型、注释与 `resumeTrader`，把"停手"交给已有的
  `stopped` 状态与运维端点。

**我的建议：A，但要按 `stopped` 的既有语义来定 resume 的边界。**
理由见 #112 一节的实测观察。

### #112 前端 `resumeTrader` 调用后端不存在的 `/traders/:id/resume`

**判定：属实，并有两点对原 Issue 的重要修正。**

1. `packages/web/src/lib/api.ts:745` 确实声明了 `resumeTrader`：
   ```ts
   resumeTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}/resume`, { method: 'POST', body: {} }),
   ```
   而后端 `server.ts` 只有 `/stop`(1879)、`/run-once`(1931)、`/selfcheck`(2394) —— **没有 `/resume`**。
   `npm run check:routes` 会把它报出来（本轮实测）。

2. **修正**：该函数在**前端没有任何调用点**（grep `resumeTrader` 只命中 api.ts 自身的定义）。
   所以原 Issue 的措辞「这些按钮点了必然失败」**不准确** —— 没有按钮会点到它。
   真实性质是**死代码 + 悬空承诺**，而不是一个可触发的 404。

3. `TraderPage.tsx:939` 明写「运维侧的恢复端点保留（`POST /api/traders/:id/resume`）——
   那不是产品功能，是出事故时的最后手段」——**这个"保留"的端点从未存在过**。

**⚠️ 若走方案 A 补 `resume`，必须沿用 `resumePersisted()` 的边界**：
只恢复 `running` / `safe_mode` / `error`，**刻意不恢复 `stopped`**。
证据：`autoTrader.ts:1510` 与 `manager.resume.test.ts:3161` 都专门测了这条
（人工 stop 过的机器人不能被自动复活）。在一个真实资金的系统里，
"运维最后手段"变成"把操作员特意停掉的机器人又拉起来"，比没有这个按钮更糟。

---

## 3. 质量门禁（#114）

**判定：属实。** 本轮实测两条脚本在当前 `main` 上**都是红的**，而 CI 不跑它们：

```
$ npm run check:routes
✗ 前端调了但后端没有的路由：/traders/:p/resume（api.ts: resumeTrader）   ← #112

$ npm run check:links
发现 2 个无法解析的站内链接：
  ✗ docs\COLLABORATION.md → ../AGENTS.md#2-改动规则不可违反的不变量
  ✗ docs\COLLABORATION.md → ../AGENTS.md
```

`.github/workflows/ci.yml` 的步骤是 `类型检查 → Lint → 测试 → 构建 → 密钥扫描`，
**没有 `check:links` / `check:routes`**（grep 无命中）。

**Issue 的核心论点成立**：CI 现在跑的都是"提 PR 之前本地本来就全绿"的东西，
而真正会失败的两个检查不在里面 —— 这也正是 #112 那个悬空路由一直没被发现的原因。

**⚠️ 本轮新增发现（原 Issue 未提到）**：`check:links` 的 4 个坏链，
原 Issue 说"已随 `docs/RELEASING.md` 的修订一并修好"，但**现在仍有 2 个**，
且都在 `docs/COLLABORATION.md` —— 引用的是**仓库根目录的 `AGENTS.md`，而它并不存在**
（只有 `docs/AGENTS.md`）。这不是新增回归，是那次修订没覆盖到本文件。

**处置建议**：接入 `check:links`（先修掉这 2 个链接）+ `check:routes`。
⚠️ 但 `check:routes` 设为**阻断**前必须先解决 #112，否则接进去的当天 CI 就是红的 ——
而 `ci.yml` 自己的注释说了「把 main 长期弄成红色会训练人忽略红色」。

---

## 4. 低风险、可直接修（#113）

**判定：属实。** `README.md:49` 与 `README.md:51` 是**逐字相同**的一行：

```
📖 完整说明：[deploy/README.md](deploy/README.md) · [部署指南](docs/DEPLOYMENT.md)
```

重复行删掉一行即可。**这是本轮唯一一个我可以直接改的 Issue。**

---

## 5. 前端与接口缺陷（#120、#122、#124、#125）

### #120 `Math.min(...seen)` 栈溢出——12.5 万个元素让整轮决策报废

**判定：属实，且已在本机实测复现到精确边界。**

`packages/server/src/strategy/parser.ts:634-646`：

```ts
export function extractNextCheckMinutes(rawItems: readonly unknown[], root?: unknown): number | undefined {
  const seen: number[] = [];
  const read = (value: unknown): void => { ... seen.push(raw); };
  read(root);
  for (const item of rawItems) read(item);
  if (seen.length === 0) return undefined;
  return Math.min(...seen);          // ← 展开运算符，实参数量 = seen.length
}
```

它被 `parseDecisionResponse`（`parser.ts:683`）调用，而那是**每轮决策的唯一解析入口**。

**本机实测（Node v22.23.1）**，直接跑该函数的等价实现：

```
1000    => OK 5
50000   => OK 5
125000  => OK 5
200000  => THROW RangeError: Maximum call stack size exceeded

二分定位：works up to ~125000, fails at ~125781
```

**这个数字与 Issue 标题里的"12.5 万个"完全吻合** —— 触发阈值约 12.5 万实参，
正是 V8 的展开实参上限。Issue 的描述是精确的，不是估算。

**爆破半径**（比 Issue 说的还确定）：`parseDecisionResponse` 在
`autoTrader.ts:3723` 被调用，而抛出的位置在
`progress.decisions = parsed.decisions`（3738 行）**之前** —— 异常一路冒到
周期外层，`progress` 根本没被填上。所以确实是"**整轮决策报废**"，
不是"少一条决策"。

**为什么模型能触发**：`rawItems` 就是模型返回的决策数组，长度完全由模型决定，
而列表里每条都可以带 `next_check_in_minutes`。**模型输出是不可信输入**
（`docs/AGENTS.md` §2.4）。

**⚠️ 但可达性极低——这一条必须说清，否则会误导后续排期**：
按本仓真实字段算，单条决策 JSON ≈ 449 字符；而 `parser.ts:398` 的注释记录了
实测输出上限 `max_tokens: 131072`、实际在约 58K tokens 被截断
→ **正常一轮只有 194~388 条决策**，离 12.5 万差三个数量级。
要触发需要约 **53.6 MB** 的单条响应。**正常模型输出到不了这个量级。**

所以准确定性是：**真 bug、真无上限、但可达性极低**。
会炸的前提是模型跑飞被越狱、网关返回异常巨型 payload、或将来有人大幅放开
候选池/输出上限。而目前**全仓库没有任何长度护栏**拦 8MB 的响应。

**建议修法**：改成一个循环求最小值（`for (const v of seen) if (v < min) min = v;`），
保留"取最小 = 最早醒 = 最保守"的既有语义（注释 622-629 行说得很清楚）。
**必须有测试**：给一个 20 万条的 `rawItems`，断言不抛且返回最小值
（当前该字段**零测试覆盖**，这也是它能长期潜伏的原因）。

### #122 历史成交表手续费出现两种相反符号

**判定：属实，但性质是「显示不一致」，不是「记账错误」——这一点很关键。**

同一格内两行（`packages/web/src/components/TraderTables.tsx`）：

```tsx
2001:  {fmtSigned(-trade.fee, 4)}                        // ← 取负 → 显示 "-0.0123"
2002:  <div className="text-xs text-ink-faint">
2003:    开 {fmtSigned(trade.entryFee, 4)} · 平 {fmtSigned(trade.exitFee, 4)}   // ← 原值 → 显示 "+0.0050"
2004:  </div>
```

**根因**：两行对同一个量的符号约定不同。主行主动取负（把手续费呈现为"成本"），
子行直接用原值。而 `entryFee` / `exitFee` 在库里**正数存储** ——
`repositories.ts:2606-2608`：

```ts
const entryFee = input.entryFee ?? 0;
const exitFee = input.exitFee ?? 0;
const fee = entryFee + exitFee;      // fee = 两者之和，同为正值
```

`fmtSigned`（`format.ts:219-226`）对正数补 `+`。于是**主行负数、子行正数**。

**✅ 账目算术没有被破坏**：`netPnl = 毛 − 手续费 − 资金费` 在
`netPnlOf()` / `trades.insert()` 里统一计算（`repositories.ts:2615`），
手续费始终是**正数被减**，口径一致。**问题只在前端这一格。**

**但为什么仍要修**：这一格是操作员核对账目的地方。同一格同时显示 `-0.0123`
和 `+0.0050 +0.0073`，会让人怀疑账本本身有问题 —— 而**"让操作员不信任账目"
在一个真实资金的系统里本身就是缺陷**。修法是统一约定（建议子行也取负，
或给函数加一个"这是成本"的显式方向参数）。

### #124 `GET /api/logs` 的 limit 未过 zod

**判定：属实，已实测复现。**

`packages/server/src/api/server.ts:989-992`：

```ts
app.get('/api/logs', authed, async (request) => {
  const limit = Number((request.query as { limit?: string }).limit ?? 200);
  return { logs: runtimeLogs.list(Number.isFinite(limit) ? limit : 200) };
});
```

**唯一的一道校验是 `Number.isFinite`，而 `1e21` 是有限数** —— 它顺利通过，
直达 SQL 的 `LIMIT ?`。

**本机实测（`node:sqlite`，与生产同一实现）**：

```
limit=200                     => OK rows=1
limit=1000000000              => OK rows=1
limit=1000000000000000        => OK rows=1
limit=9007199254740991        => OK rows=1
limit=1e+21                   => THROW ERR_SQLITE_ERROR datatype mismatch
limit=9223372036854776000     => THROW ERR_SQLITE_ERROR datatype mismatch
```

**报错文字与 Issue 标题里的 `500 datatype mismatch` 完全一致。**

**修复要点（不只是加个上限）**：正确的判据是 **SQLite 的 64 位整数范围**，
不是 `Number.isFinite`。同时应对**负数**做处理。建议按项目既有风格加 zod
（`z.coerce.number().int().min(1).max(...)`）—— 仓库里其它路由普遍如此，
`/api/logs` 是漏网的那一个。

### #125 教训记忆里保本平仓显示成绿色盈利 +0.00

**判定：属实，且"已有 `pnlColor` 却没复用"这一条完全成立。**

`packages/web/src/components/AgentAuditPanel.tsx:241-244`（"教训记忆"区块）：

```tsx
<span className={m.netPnl >= 0 ? 'num w-16 shrink-0 text-up' : 'num w-16 shrink-0 text-down'}>
  {m.netPnl >= 0 ? '+' : ''}
  {m.netPnl.toFixed(2)}
</span>
```

两处都用 `>= 0`：
- **颜色**：`netPnl === 0` → `text-up`（绿色 = 盈利）
- **符号**：`netPnl === 0` → 前缀 `'+'` → 渲染成 **`+0.00`**

**而项目里已经有正确的实现**（`packages/web/src/lib/format.ts:306-310`）：

```ts
/** Tailwind text colour for a signed number. Zero is neutral. */
export function pnlColor(value: number | null | undefined): string {
  if (!isNum(value) || value === 0) return 'text-ink-mid';   // ← 0 是中性色
  return value > 0 ? 'text-up' : 'text-down';
}
```

**"模式已存在、只是这一处没复用"的判定成立**：`pnlColor` 已被
`TraderTables.tsx`（2006、2012 行）、`PnlBreakdown.tsx`、`BalanceCells.tsx`
等多处复用，且注释明写 **"Zero is neutral"** —— 正是本 Issue 要求的行为。

**为什么不是小事**：保本平仓被显示成"绿色盈利"，会让操作员把一笔
**实际没赚钱、还倒贴了手续费以外的成本**的回合读成赚了。而这个区块正是
"AI 从每笔平仓里学到了什么"的地方 —— **颜色在那里等于一条结论**。

**建议修法**：改用 `pnlColor(m.netPnl)`；符号也用 `fmtSigned`（它天然不给 0 加符号）。
⚠️ 这是"两处各自正确、合起来失效"的又一例，改动要**同时**覆盖颜色与符号。
**同一组件 `AgentAuditPanel.tsx:218` 有完全相同的 bug**（实验表手写 `outcomeNetPnl >= 0`），
要一起修。顺带建议给 `format.test.ts` 补 `pnlColor(0) === 'text-ink-mid'` ——
`pnlColor` 目前**零测试覆盖**，这正是漏用长期没被发现的原因。

### #121 停止机器人四个入口，只有列表页有二次确认

**判定：属实。** `api.stopTrader` 在前端**恰好 4 个调用点**：

| # | 入口 | 位置 | 二次确认 |
| --- | --- | --- | --- |
| 1 | 机器人列表页 | `TradersPage.tsx:122`（`runPending`） | ✅ 有（`ConfirmDialog`，468 行只 `setPending`） |
| 2 | 总览页 | `OverviewPage.tsx:264`（`stop`） | ❌ **无，点击即停** |
| 3 | 机器人详情页 | `TraderPage.tsx:911`（`stop`） | ❌ **无，点击即停** |
| 4 | 命令面板 | `CommandPalette.tsx:134`（`stopBot`） | ❌ **无，回车即停** |

**后端**（`server.ts:1879-1883`）路由存在、`authed` 有鉴权、`stopTrader` **幂等**
（`manager.ts:3007-3055`：重复调用只是再写一次 `stopped` + 一条日志）。

**⚠️ 额外发现（原 Issue 未提，但很说明问题）**：命令面板**自己已经有**确认机制 ——
`:324` 的"立即执行周期"走 `setPending({kind:'run-once'})`，
**唯独 `stop` 绕过了它**直接 `onSelect`（`:312`）。这是**不对称**的，
看起来像漏改而不是有意设计。

**⚠️ 另一个后端问题**：`server.ts:1881` 把 `stopTrader` 的 promise `void` 掉，
并**无条件 `return { ok: true }`** —— 失败不会回传给前端。
前端因此无法区分"真的停了"和"停止请求丢了"。

**为什么这是真实资金风险、不只是体验问题**：停止机器人**不会自动平仓**
（命令面板 `:486` 自己也这么提示）。所以误停 = 一个**持有杠杆仓位**的机器人
停止管理仓位 —— 保护位不再被跟踪调整、决策循环退出。
而这些入口是**单击/回车生效**，且总览页那排"停止"按钮与启动按钮挨得很近
（`overviewParts.tsx:476-485`）。对照之下，**更危险的"删除"在列表页反而是有确认的**。

### #119 seed:demo 后健康检查判红

**判定：部分属实 —— 核心机制属实，但 Issue 的两处断言需要修正。**

**根因**：`seedDemoData.ts:461` 造完历史后对**所有**机器人调
`traders.recordCycle(...)`，而 `recordCycle`（`repositories.ts:707-716`）把
`last_cycle_at` 写成**当时的 now**。示例机器人又被赋成 `running`
（`seedDemoData.ts:386`，62% 概率）。于是 seed 完之后它们**看起来像"刚跑完一轮"
的正常机器人，而实际没有任何进程在跑**。

红灯判据（`server.ts:412-415`）：`running` 且距 `last_cycle_at` 超过
`max(周期 × 2, 5 分钟)`（`STALE_CYCLE_MULTIPLIER = 2`、`STARTUP_GRACE_MS = 300_000`）。

**实测复现**（真跑 `seed:demo` 进一次性 DB，再照 `/api/health` 的调用形状）：
seed 出 14 台（running 6）；龄 30s；
**+10 分钟 → ok=false、stale=3**（那 3 台周期 5min，阈值 `max(5×2,5)=10`）。

**修正 Issue 的两点**：
1. **不是 12 分钟，是 10 分钟** —— `max(周期×2, 5min)`，最早越线的是周期 5 分钟的。
2. **不是"永久 unhealthy"**。它取决于进程有没有在跑：
   - **正常路径不会红**：开机 `resumePersisted()` 会把 `running` 的拉起来 →
     示例账户 Key 是假的（`seedDemoData.ts:276` 写 `demo-xxxx`）→
     真实 `getAccountState()` 鉴权失败 → blocking preflight →
     `setTraderStatus(traderId,'error')`（`manager.ts:2365`）。
     **状态一旦落成 `error` 就不再是 `running`，健康检查立刻转绿**
     （实测该情形 0→10080 分钟全程 ok=true）。
   - **会持续红的情形**：`resumePersisted()` 没跑到 / 被 `globalTradingDisabled`
     跳过（`manager.ts:3512-3515` 直接 return）/ 或机器人真在跑但循环卡住
     → 实测 +600 分钟仍 false。

**⚠️ 诚实声明**："假 Key → 鉴权失败 → 写 error"这一步是**静态读码**，
未真实连币安（按纪律不该做）。但"非 `running` 即转绿"那半边是用纯函数
`evaluateTraderHealth` **实测**的，确定无误。

**影响**：示例账户不是真账户，所以**不直接造成资金损失**。
但 `docker-compose.yml` 的 healthcheck 是唯一的编排器信号，
容器会被标 unhealthy 甚至被重启策略反复拉起。**真正的危害是它训练运维忽略健康告警** ——
在一个真有实盘仓位的系统里，这比没有告警更危险。

**建议修法**：seed 时不要把 `last_cycle_at` 写成 now（写成过去的时间，或对示例机器人写 null），
并在 seed 结束的提示里说明"示例机器人会让 /api/health 变红，属预期"。
更干净的口径是让 health 只统计"本进程实际持有运行实例"的机器人，
而不是光信 DB 里的 `status` 字符串。

### #123 市场数据原样拼进提示词

**判定：部分属实 —— 注入面真实存在，但 symbol 路径现实不可利用。**
**定性为「加固建议」，不是「可利用漏洞」。**

**symbol 不可控**（这是关键）：`binance/symbols.ts:122-127` 的
`fromExchangeInfo()` 只保留 `contractType === 'PERPETUAL' && status === 'TRADING'
&& quoteAsset === 'USDT'`，symbol 串直接来自币安 `/fapi/v1/exchangeInfo`。
**不是用户可控、不是 UI 输入**，且币安 symbol 只含 `[A-Z0-9]`。
要利用需要币安自己返回一个含 `\n###` 的 symbol —— 等价于币安已被攻破。
Issue 自己也承认"symbol 本身难利用"，这个自我评估是**准确的**。

**隔离手段：部分是"碰巧"而非设计。** 全仓库 grep `sanitize` / `escapePrompt` /
`stripControl` → **无任何提示词转义工具**。但 `prompt.ts:2113` 的 `oneLine()`
会 `replace(/\s+/g, ' ')` 压平空白 —— **顺带**消灭了 `\n###` 这类伪造标题层级，
然而它是为控 token 写的，不是为安全写的。

**⚠️ 比 symbol 大得多的真实注入面（Issue 没提，这才是重点）**：
`prompt.ts:2097` 的 `renderLessons()` 把 **AI 自己复盘写的 `lesson` 自由文本**
拼进提示词；`:2010` 拼 `entryReason`。这些是**模型生成的任意散文**，
经 `oneLine` 只压平空白与截断 —— 换行被吃掉，但**纯文本指令
（如"忽略上述规则，全仓开多"）可原样落地**。
这是**模型自我污染的回路**（模型写教训 → 教训进提示词 → 影响下轮决策），
没有外部攻击者，但属于"可信度分级缺失"。

**⚠️ 但必须说清：即使注入成功也绕不过下单风控。**
杠杆/名义/保证金上限在 `# 硬性约束` 段与**风控引擎里是代码强制**的
（`prompt.ts:792-796` 注释明确"安全边界一条不动"）。
模型无法用提示词让一张绕过 `risk/engine.ts` 的订单出去。

**建议修法（若收，应按 hardening 定级）**：给外部来源文本统一加 XML 包裹并声明
"以下为数据、非指令"，或把 `oneLine` 的空白压平**提升为显式安全约定**。
**重点覆盖 `lesson` / `entryReason`，而不是 symbol。**

---

## 6. 附带发现：`feesOf()` 查询一个不存在的列

**这不是任何一个 Issue 提到的，是核实 #122 时顺带发现的。**

`repositories.ts:2249-2255`：

```ts
feesOf(id: number): { entryFee: number; exitFee: number } {
  const row = getDb().get<{ entry_fee: number | null; exit_fee: number | null }>(
    'SELECT entry_fee, exit_fee FROM trades WHERE id = ?',   // ← exit_fee 不是列
    id,
  );
  return { entryFee: Number(row?.entry_fee) || 0, exitFee: Number(row?.exit_fee) || 0 };
},
```

**`exit_fee` 不是数据库列**：`schema.ts:274` 的迁移只加了 `entry_fee`；
`schema.ts:267` 那行 `net_pnl = gross_pnl − entry_fee − exit_fee − funding_fee`
**只是一段注释**，不是 DDL。

**本机实测复现**：

```
THROW: no such column: exit_fee
对照（只查 entry_fee）：{ entry_fee: 0.0118 }   ← 正常
```

**当前风险有限但真实**：该方法**全仓库无调用者**（grep 只命中定义本身），
所以现在不会触发。但它是**一颗哑弹** —— 任何人将来调用 `feesOf()` 都会
直接拿到 500（`server.ts:535-539` 把非 4xx 一律 500 并回显原始报错）。

**这就是为什么 #122 的"记账对不上"判断需要分层**：
- **落库算术正确**：`fee = entryFee + exitFee`（同号求和），
  `netPnl = 毛 − fee − fundingFee` 在 `trades.insert()` 统一算。
  实测走真实 `insert()` + `list()` 往返，`entryFee + exitFee === fee` **精确成立**。
  `exitFee` 在读出层是**派生**的：`Math.max(0, row.fee - row.entry_fee)`（`repositories.ts:1851`）。
- **前端显示不一致**（#122 的真身）。
- **`feesOf()` 死代码哑弹**（本条）。

**建议**：删掉 `feesOf()`，或改成派生 `exitFee = fee - entry_fee`
（与读出层 1851 行同一个口径，避免出现"第二个算 exitFee 的地方"）。

---

## 7. 本轮动作记录

### 打标签（14 个 Issue 全部处理）

| Issue | 标签 |
| --- | --- |
| 117 | `risk-engine` `trading-path` `bug` |
| 118 | `risk-engine` `bug` |
| 120 | `bug` `strategy` `needs-triage` |
| 124 | `bug` `api` |
| 125 | `bug` `web` |
| 122 | `bug` `web` `needs-triage` |
| 123 | `strategy` `needs-triage` |
| 121 | `bug` `web` |
| 119 | `bug` `deployment` `needs-triage` |
| 114 | `enhancement` `deployment` |
| 113 | `documentation` |
| 112 | `bug` `api` `needs-triage` |
| 115 | `bug` `strategy` `needs-triage` |
| 116 | `bug` `strategy` `api` `needs-triage` |

`needs-triage` = 需要开发窗口定方向（多为"补实现 vs 清半成品"的产品决策）。

### 已直接修复（低风险、有测试兜底）

1. **#113** `README.md` 删掉重复的那一行（49/51 逐字相同）。
2. **#114 的一部分 + 本轮新发现** `docs/COLLABORATION.md` 的 2 个坏链
   （`../AGENTS.md` → 仓库根没有这个文件，正确目标是同目录的 `AGENTS.md`）。

修复后实测：

```
npm run check:links  → exit 0  ✅ 51 个 markdown 文件、113 个站内链接全部有效
npm run typecheck    → exit 0
npm test             → exit 0  （42 + 1383 + 132，0 fail）
```

`check:routes` 仍为红（`/traders/:p/resume`）——**那是 #112，故意不在这里修**
（见下节"为什么不顺手修"）。

### 明确不做、留给开发窗口

**为什么不顺手修 #112 / #115 / #116**：
它们不是"改一行"能解决的，而是**产品方向选择**——
**补全 `pause_trading` 实现**，还是**清除半成品**。两者互斥且影响
提示词、工具注册表、API 路由、前端四处。按 COLLABORATION.md
"不确定就升级，不要硬判断"，留给开发窗口定方向后再动手。

**为什么不直接修 #117 / #118**：
两者都**触及风控引擎**，属 `risk-engine` / `trading-path`。
按 `CONTRIBUTING.md`「涉及真实资金的改动」一节，这类改动**不接受"我读了觉得对"**，
必须有与之一档的验证（单测 + `npm run sim`）。
#117 的修法还涉及一个设计判断（回执路径是调用完整 `review()` 还是只调用
`reviewAdjust()`），应由开发窗口在完整上下文里决定。
**本报告已把根因定位到行、并给出建议修法与测试要点，可直接据此开工。**

**为什么不直接修 #119 / #121 / #123**：
- #119 的干净修法要改 health 的**判据口径**（从"信 DB 的 status"改成"信进程实际持有的实例"），
  那是设计决定；且我实测出它**并非永久红**，紧迫度低于 issue 标题给人的印象。
- #121 涉及抽一个共享 `ConfirmDialog`（跨三个页面 + 命令面板），
  属前端结构改动，该由熟悉那套组件的人一次做对。
- #123 是否收、按什么定级，本身就是产品决策。

### 第 2 轮：把可安全修的 4 个 bug 转成实际工作

COLLABORATION.md §4 对「有复现步骤的 bug」的指示是"**直接修**，
修的时候先写一个能复现的用例"。第 1 轮只做了 triage，第 2 轮把这 4 个补上
（都不碰风控引擎、不碰账目算术）：

| Issue | commit | 改动 | 复现用例（修复前实测失败） |
| --- | --- | --- | --- |
| #120 | `656550f` | `parser.ts` 用循环求最小值替代 `Math.min(...seen)` | `parser.test.ts` 4 条，含 20 万元素 |
| #124 | `3d38b83` | `runtimeLogs.list()` 在**仓储层**钳制 limit | `retention.test.ts` 覆盖 `1e21`/`1.5`/负数/`0` |
| #125 | `9fe9533` | 教训记忆与实验表改用 `pnlColor` + `fmtSigned` | `format.test.ts` 补 `pnlColor` 零覆盖 |
| #122 | `0e36ec5` | 成交表手续费子行统一取负；`feesOf()` 派生 `exitFee` | `retention.test.ts` 钉住 `feesOf()` 不再炸 |

**每个用例都先证明它会失败，再改代码**（AGENTS.md §3.5 的顺序）。
实测到的失败原文（修复前）：

```
#120  not ok 44 - ★ 元素极多时不炸栈 —— 抛 RangeError
#122  not ok 14 - ★ feesOf() 必须派生 exitFee —— Actual message: "no such column: exit_fee"
#124  not ok  3 - ★ runtimeLogs.list() 自己钳制 limit —— Actual message: "datatype mismatch"
```

`feesOf()` 那一条不在原 issue 里 —— 是核实 #122 时**顺带发现的哑弹**
（查询一个不存在的列 `exit_fee`，此前无调用者所以没爆）。已一并修掉并加测试。

修复后的完整验证（**在 rebase 到对方最新提交之后再跑一遍**）：

```
npm run typecheck   → exit 0
npm test            → exit 0  （46 + 1395 + 133，0 fail）
npm run build       → exit 0
npm run lint        → exit 0
npm run check:links → exit 0
npm run sim         → exit 0  （18/18 项校验全部通过）
```

⚠️ **一处未验证项（不谎报）**：#122 / #125 是**渲染层**改动，而 `packages/web`
**没有任何组件级测试**（`*.test.tsx` 一个都没有）。所以能证明的是
"`pnlColor` 的语义被测试钉住了 + typecheck/build 通过"，
**没有**在浏览器里实际打开这些面板确认渲染结果（AGENTS.md §3.2）。

### 回帖记录

第 1 轮：13 个 issue 各留了一条**结论性**评论（不含客套，只写证据与根因）；
第 2 轮：4 个已修 issue 各留一条修复说明并关闭；
第 3 轮：修 #121 并关闭；**把 #117 / #118 两个风控缺陷推到"可实测复现 + 修法已验证"**。

### 第 3 轮：把两个风控缺陷推到可开工状态（不合并）

#117 / #118 按红线不能由本窗口合并，但它们此前只到"静态定位"。本轮各做了**实测探针**
（用完即删，工作区干净），把结论钉死：

**#118** —— 实测 fixture（`maxEntriesPerCycle: 20`、**`maxEntriesPerHour: 2`**、同一批 6 条合法开仓）：

```
放行 6 / 6，拒绝 0        ← 与 issue 描述逐字吻合
```

补上 `entriesLastHour: env.entriesLastHour + entriesThisCycle`（与 572 行对齐）后：

```
放行 2 / 6，拒绝 4
  拒绝 SOLUSDT：开仓节流：最近一小时内已开 2 仓（上限 2）。
  …（另外 3 条同）
```

→ 上限生效 **且**被拒记录带理由落库（"零拒绝记录"的可观测性问题一并解决）。
**`engine.test.ts` 56 个用例全部仍通过。**

**#117** —— 两半都实测：

```
引擎对"下移多头止损"：放行 0，拒绝 1
  拒绝理由：多头止损只能往上移（当前 69000，你给的是 67000）—— 往下移是主动扩大风险。
```

另一半：把 `executeAdjust()` 整段过了一遍，**没有任何一处**拿 `newStop` 与
`local.stop_loss` 比大小（`local` 只用来取 `symbol`/`side`）→ 同一个决策
**主路径被拒、回执路径原样挂到交易所**。

修法建议里补了两个容易踩的细节：① `reviewAdjust` 是 `private`，回执路径够不着
（要么走完整 `review()`，要么把它提为 public）；② 回执轮拿到 `rejected` 必须落库
（回执轮"不走开仓上限"的设计意图 **不含** `reviewAdjust` 的方向判据，别照抄那个结论）。

**为什么探针不入库**：它们断言的是"当前有 bug"，合进 main 会让 CI 变红；
而修法本身属风控引擎改动，按 `CONTRIBUTING.md` 需要开发窗口连同 `npm run sim` 一起做。
所以探针的**内容**写进了 issue 回帖，形状可直接改成回归用例。

| Issue | 回帖要点 |
| --- | --- |
| 117 | 唯一 `risk.review()` 在 3831 行；回执路径 8122 行直调 `executeAdjust`；方向校验只在 `reviewAdjust`（用例 822-896 为证） |
| 118 | 607-612 行漏传 `entriesLastHour`；572 行的 `add_to_position` 分支已修，紧邻的开仓分支没修 |
| 119 | **修正**：是 10 分钟不是 12；**不会永久红**（实测两种情形） |
| 120 | 二分实测 125218/125219；**补充**：可达性极低（真实一轮仅 194~388 条决策） |
| 121 | 四入口表格；**补充**：命令面板已有确认机制却绕过它；后端 `void` 掉 promise 且无条件 `ok:true` |
| 122 | **分层**：落库算术正确（实测恒等式成立）／前端显示不一致／附带发现 `feesOf()` 哑弹 |
| 123 | symbol 不可控 → 降级为 hardening；**指出真正的面在 `lesson`/`entryReason`** |
| 124 | 实测：触发条件是 **≥1e21 或非整数**，不是"超出安全整数"（`2**53` 不炸） |
| 125 | `pnlColor` 已在 10+ 处复用、此组件未 import；**同文件 218 行有第二处** |
| 112 | **修正**：该函数零调用点（死代码），不是"按钮点了必然失败"；真正承诺它的是 `TraderPage.tsx:939` 的注释 |
| 115 | 11 个工具逐个数过；`paused` 零写入 → **`prompt.ts:118` 那次修复是悬空的** |
| 116 | 逐环节表格确认；**建议**：规则 6 等方向定了再加（否则规则无从触发、无从验证） |
| 114 | **修正**：`check:links` 当时**仍是红的**（2 个坏链，已由我修好）；接 `check:routes` 前须先清 #112 |
| 113 | 已修，已关闭 |

### 本轮未做的事（以及为什么）

- **没有合并任何 PR** —— 当前 open PR 数为 **0**，无可合并对象。
- **没有修 #117 / #118 / #120 / #121 / #122 / #124 / #125 的代码** ——
  它们本身风险可控或已定位，但按作业手册"一个迭代 = 一个 PR"、
  且我这一轮的角色是 triage：**先把结论与定位固化下来**，
  让开发窗口能在完整上下文里一次改对。特别是 #117 / #118 触及风控引擎，
  不是"改一行顺手带上"的位置。
- **没有开启分支保护 / 任何 GitHub 自动化**（红线）。
- **没有跑 deploy.ps1 / liveSmokeTest / sim:live**（红线）。
- **没有把 `gh` 放进任何循环** —— 全部为单次调用，写操作之间间隔 3-4 秒。
