/**
 * **Harness agent 运行时** —— 让角色真正"能自己干活"。
 *
 * ## 为什么需要它（实测对照，2026-10-12）
 *
 * 同一个任务（「查今天 BTC 三条新闻 + 方向判断」）跑两种做法：
 *
 * | | 手搓单次调用 | harness agent |
 * |---|---|---|
 * | 情报产出 | **零** —— 「我无法联网，没有工具」 | **3 条具体新闻 + 资金流 + 价格** |
 * | 来源 | 无 | **5 个真实 Sources 链接** |
 * | 行为 | 给框架、要用户贴新闻 | **自己调工具查到，还给结论与依据** |
 *
 * **差距是质，不是量。** 手搓的角色只是"被问一次就答一次"，
 * 而用户要的是"像公司员工一样，领了任务能自己去干"。
 *
 * 用户的原话：
 *
 * > 「在我理解中，智能体就像一个真人一样，公司干活的员工，公司给他委派任务，
 * >  他能**自己上班干活，给公司贡献**，而不是像机器人一样**问一次答一次**，
 * >  如果是这样那么这个模式和之前 2 个模式又有什么区别？」
 *
 * ## 为什么不自己写 agent 循环（"不重复造轮子"）
 *
 * 一个能干活的 agent 需要：工具调用、多轮循环、上下文压缩、权限、错误恢复。
 * 这些 harness 已经做得很成熟 —— 用户的需求 #4 明确要求直接用它们。
 *
 * ## 与 magpie 的关系（两者天然咬合）
 *
 * ```
 *   harness  = 会干活（工具、循环、自主）
 *   magpie   = 用哪个模型（按工种的路由组，优选→兜底）
 * ```
 *
 * magpie 原生说 Anthropic Messages 协议，所以 claude code 只要设
 * `ANTHROPIC_BASE_URL` 就能直接用它。
 */

import { spawn } from 'node:child_process';

/** 一次 agent 任务的输入。 */
export interface AgentTaskInput {
  /** 交给这个"员工"的任务（自然语言，就像跟同事说话）。 */
  task: string;
  /**
   * 允许它用的工具（逗号分隔）。
   *
   * ⚠️ 用**白名单**而不是 `--dangerously-skip-permissions`：
   * 后者在 root 下会被 harness 直接拒绝（实测），而且给一个交易系统开全权限太危险。
   */
  allowedTools?: string;
  /** magpie 的路由组（`group/team-news` 之类）—— "这个人用哪档模型"。 */
  model?: string;
  /** 体力活用的快模型（harness 内部的小任务，例如压缩上下文）。 */
  fastModel?: string;
  /** 工作目录（agent 的"办公室"）。 */
  workdir: string;
  /** 超时（毫秒）。 */
  timeoutMs?: number;
  /** magpie 网关地址。 */
  baseUrl?: string;
  /** magpie 调用密钥。 */
  authToken: string;
}

/** 一次 agent 任务的结果。 */
export interface AgentTaskResult {
  ok: boolean;
  /** agent 的交付内容。 */
  text: string;
  /** 失败原因（ok=false 时有值）。 */
  error?: string;
  latencyMs: number;
}

/**
 * 实际的进程执行 —— **抽成可注入的**。
 *
 * 两个原因：
 * ① 测试里不能真的起进程（本机沙箱下 `spawn` + `stdio: 'pipe'` 会 EPERM）；
 * ② 将来换 harness（codex / opencode / dsh）只改这一处。
 */
export type SpawnAgent = (input: AgentTaskInput) => Promise<AgentTaskResult>;

/**
 * **默认实现：驱动 claude code**。
 *
 * 命令形状（实测可用，2026-10-12）：
 *
 * ```
 *   claude --print --allowedTools "WebSearch,WebFetch"   ← 任务走 stdin
 * ```
 *
 * ⚠️ 三个实测踩到的坑，都在下面标注了。
 */
export const spawnClaudeCode: SpawnAgent = async (input) => {
  const started = Date.now();
  const bin = process.env.AQ_HARNESS_BIN ?? '/opt/autoquant/tools/harness/node_modules/.bin/claude';
  const timeoutMs = input.timeoutMs ?? 300_000;

  return await new Promise<AgentTaskResult>((resolve) => {
    /*
     * ⚠️ 坑 ①：任务必须走 **stdin**。
     * 实测把任务当位置参数传会报 "Input must be provided either through stdin
     * or as a prompt argument" —— 而它其实是在等 stdin。
     */
    const child = spawn(bin, [
      '--print',
      ...(input.allowedTools !== undefined && input.allowedTools.length > 0
        ? ['--allowedTools', input.allowedTools]
        : []),
    ], {
      cwd: input.workdir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: input.baseUrl ?? 'http://127.0.0.1:3425',
        ANTHROPIC_AUTH_TOKEN: input.authToken,
        ...(input.model !== undefined ? { ANTHROPIC_MODEL: input.model } : {}),
        ...(input.fastModel !== undefined ? { ANTHROPIC_SMALL_FAST_MODEL: input.fastModel } : {}),
        /*
         * ⚠️ 坑 ②：claude code 不认识 `group/team-*` 这种模型名，会警告并
         * **按 200k 预估上下文**。我们显式告诉它真实窗口，避免它过早压缩上下文。
         */
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.AQ_HARNESS_CONTEXT_TOKENS ?? '200000',
        HOME: process.env.AQ_HARNESS_HOME ?? `${input.workdir}/.home`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: AgentTaskResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, text: '', error: `agent 超过 ${Math.round(timeoutMs / 1000)} 秒未返回`, latencyMs: Date.now() - started });
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });

    child.on('error', (e) => {
      /*
       * ⚠️ 坑 ③：**没装 harness 时必须说清楚**，不能静默失败 ——
       * 否则现象是"这个分析师这轮没产出"，而真正原因是环境没装好。
       */
      finish({
        ok: false,
        text: '',
        error: `起不了 harness（${bin}）：${e.message} —— 需要先安装（见 .dsh 文档的 harness 安装步骤）`,
        latencyMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      const latency = Date.now() - started;
      const text = out.trim();
      if (code === 0 && text.length > 0) {
        finish({ ok: true, text, latencyMs: latency });
        return;
      }
      finish({
        ok: false,
        text,
        error: `harness 退出码 ${code ?? 'null'}${err.trim().length > 0 ? ` · ${err.trim().slice(0, 300)}` : ''}`,
        latencyMs: latency,
      });
    });

    child.stdin.write(input.task);
    child.stdin.end();
  });
};

/**
 * 跑一次 agent 任务。
 *
 * 调用方（角色）只需要给"任务是什么、能用什么工具、用哪档模型"，
 * **不需要知道底下是 claude code 还是别的 harness**。
 */
export async function runAgentTask(
  input: AgentTaskInput,
  spawnAgent: SpawnAgent = spawnClaudeCode,
): Promise<AgentTaskResult> {
  if (input.task.trim().length === 0) {
    return { ok: false, text: '', error: '任务为空 —— 没给这个 agent 任何活干', latencyMs: 0 };
  }
  return await spawnAgent(input);
}
