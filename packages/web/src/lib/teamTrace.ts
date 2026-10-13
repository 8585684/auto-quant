/**
 * **从决策记录里解析团队审计信息**。
 *
 * ## 为什么不需要新增数据库字段
 *
 * 团队模式的裁决产出**本来就带审计块**（见 `deskOutput.ts` 的 `renderDeskOutcome`）：
 *
 * ```
 * <decision>[…]</decision>
 * <team>
 * 交易台：分析师 4/4 成功 · 已裁决 · 调用 7/8
 * ## 各角色产出
 * - market_analyst（workbuddy-ai/glm-5.3）：市场偏多…
 * - judge（workbuddy-ai/gpt-6-astra）：结论…
 * </team>
 * ```
 *
 * 这段文字**已经落库**在 `decision_records.raw_response` 里。
 * 所以历史区只要**解析它**就能显示"谁参与了、各自说了什么"——
 * **不需要加列、不需要迁移**（迁移要动挂着实盘的 `traders` 表，风险不值得）。
 *
 * ## 为什么解析失败必须优雅
 *
 * 普通/智能托管模式的 `rawResponse` **没有** `<team>` 块 ——
 * 那是正常情况，不是错误。解析器要返回 `null`，而不是抛错或显示空壳。
 */

/** 一个角色在某一轮的产出。 */
export interface TeamMemberOutput {
  /** 角色 id（与后端一致）。 */
  role: string;
  /** 它用的模型（审计的关键信息 —— "谁用了什么模型"）。 */
  modelId: string | null;
  /** 产出摘要。 */
  text: string;
}

/** 从一轮决策里解析出的团队信息。 */
export interface TeamTrace {
  /** 摘要行（`交易台：…`）。 */
  summary: string | null;
  /** 各角色产出。 */
  members: TeamMemberOutput[];
}

/**
 * 从 `rawResponse` 里抽出 `<team>` 块的内容。
 *
 * 返回 `null` = 这不是一轮团队决策（普通模式），**不是错误**。
 */
export function parseTeamTrace(rawResponse: string): TeamTrace | null {
  const open = rawResponse.indexOf('<team>');
  if (open < 0) return null;
  const close = rawResponse.indexOf('</team>', open);
  const body = close < 0 ? rawResponse.slice(open + '<team>'.length) : rawResponse.slice(open + '<team>'.length, close);

  const lines = body.split('\n').map((l) => l.trim());
  let summary: string | null = null;
  const members: TeamMemberOutput[] = [];
  let inMembers = false;

  for (const line of lines) {
    if (line.startsWith('交易台：')) {
      summary = line.slice('交易台：'.length).trim();
      continue;
    }
    if (line.startsWith('## 各角色产出')) {
      inMembers = true;
      continue;
    }
    if (!inMembers) continue;
    /*
     * 成员行形如：`- market_analyst（workbuddy-ai/glm-5.3）：市场偏多…`
     *
     * ⚠️ 用**第一个** `：` 分割角色与内容 —— 因为内容里很可能也有中文冒号
     *（模型写的论证经常有）。用最后一个会把角色名切坏。
     */
    if (!line.startsWith('- ')) continue;
    const rest = line.slice(2);
    const colon = rest.indexOf('：');
    if (colon < 0) continue;
    const head = rest.slice(0, colon);
    const text = rest.slice(colon + 1).trim();
    /* head 形如 `role（model）` 或 `role` */
    const parenOpen = head.indexOf('（');
    const role = parenOpen < 0 ? head.trim() : head.slice(0, parenOpen).trim();
    const modelId = parenOpen < 0 ? null : head.slice(parenOpen + 1).replace(/）\s*$/, '').trim();
    if (role.length === 0) continue;
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **`role` 必须是"角色 id 的形态"，否则这是【正文里的列表项】**
     *      （2026-10-14 用户截图抓到：「出现大量 <reasoning>、空的，杂乱无章」）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：把模型输出里的 markdown 列表当成了角色
     *
     * 解析器原来只要求「以 `- ` 开头 + 含 `：`」—— 而**角色的产出本身就是多行
     * markdown，里面全是列表项**。线上实测（`#11` `c134` 的 `<team>` 块）：
     * ```
     *   - newscaster（group/team-grunt）：# 新闻事件卡      ← 真角色行
     *   - **实体**：Interactive Brokers（IBKR）、ZeroHash    ← 新闻卡的内容！被当成角色
     *   - **方向**：bullish（对 ETH 需求面偏多）              ← 同上
     *   - 6 个候选的完整指标序列：BTCUSDT、TRUTHUSDT、…      ← market_analyst 的正文
     *   - ARC开空75分                                        ← bull 的正文
     * ```
     * 结果是看板上冒出十几行"岗位"（`**实体**`、`6 个候选的完整指标序列`…），
     * 而它们其实是某个角色的**正文内容** —— 用户看到的"杂乱无章"就是这个。
     *
     * ## 判据：角色 id 是**纯小写英文 + 下划线**（`market_analyst` / `judge` / `bull`…）
     *
     * ```
     *   ✓ market_analyst · technical · newscaster · sentiment · bull · bear · judge · reporter
     *   ✗ **实体**                    ← 含 `*`
     *   ✗ 6 个候选的完整指标序列        ← 含中文与空格
     *   ✗ BTC 83372.70 +0.57%，ETH…   ← 含空格、数字、标点
     *   ✗ ARC开空75分                  ← 含中文与数字
     * ```
     * ⚠️ 用**形态**判据而不是"已知角色白名单"：后端加新角色时前端不该跟着改
     *（`rosterEntries` 已经能处理"编制表之外的角色"那种情况）。
     */
    if (!/^[a-z][a-z0-9_]*$/.test(role)) continue;
    members.push({ role, modelId, text });
  }

  return { summary, members };
}
