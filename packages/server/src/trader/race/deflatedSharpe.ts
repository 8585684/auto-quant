/**
 * **Deflated Sharpe Ratio（DSR）** —— 多重比较校正。
 *
 * ## 为什么必须有它（真实调研的结论，2026-10-12）
 *
 * 调研来源：[Bailey & López de Prado (2014), "The Deflated Sharpe Ratio"](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
 *
 * > 「当你在同一份数据上试了 K 个变体，观测到的**最大 Sharpe 会被系统性抬高** ——
 * >  K=50 次试验时，**纯靠运气也能跑出 0.4–0.8 的 Sharpe**，必须按试验次数和
 * >  非正态性做通缩校正。判读：**DSR ≥ 0.95 才算通过多重检验**。」
 *
 * ## 为什么这对我们尤其重要
 *
 * 调研的原文结论：
 *
 * > 「**多重比较校正对你尤其重要**……2 万 U 下**"运气当能力"是头号杀手**。」
 *
 * 而我们的场景**正是**多重比较的重灾区：我们会在同一批行情上试很多策略变体
 *（不同参数、不同标的、不同时间框架），然后挑"最好的那个" ——
 * **不校正的话，挑出来的必然包含大量噪声。**
 *
 * ## 它修正了什么
 *
 * | 朴素 Sharpe | DSR |
 * |---|---|
 * | 只看这一个策略的收益/波动 | 还看**你试了多少次**（K 越大，门槛越高）|
 * | 假设收益正态 | 还看**偏度与峰度**（厚尾会削弱显著性）|
 * | 一个数，无判读标准 | 输出**概率**，≥ 0.95 才算"不是运气" |
 *
 * ⚠️ **它是"打折"，不是"推翻"** —— 一个真实很强的策略，K 很大时 DSR 仍会高。
 * 它惩罚的是"试很多次后挑出来的那个最好看的"。
 */

/** 标准正态分布 CDF（用 Abramowitz & Stegun 7.1.26 的 erf 近似，精度 ~1e-7）。 */
export function normalCdf(x: number): number {
  /* Φ(x) = 0.5 * (1 + erf(x / √2)) */
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-((x / Math.SQRT2) ** 2));
  const erf = x >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/** 标准正态分布的分位数（Acklam 近似，精度 ~1e-9）。 */
export function normalInv(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`normalInv 需要 0 < p < 1（收到 ${p}）`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** 欧拉-马斯刻若尼常数（Bailey & López de Prado 公式里的 γ）。 */
const EULER_GAMMA = 0.5772156649015329;

export interface DsrInput {
  /** 逐笔收益率（按时间顺序）。 */
  returns: readonly number[];
  /**
   * **你在同一份数据上试过的变体数**（K）。
   *
   * ⚠️ 这个数字**必须诚实**：试了 50 个参数组合就要写 50。
   * 少报 K 会让 DSR 虚高 —— 那正是这个函数要防的事。
   */
  trials: number;
}

export interface DsrResult {
  /** 观测到的逐笔 Sharpe（未年化）。 */
  sharpe: number;
  samples: number;
  /** 零假设下"最好那个"的期望 Sharpe 上限（通缩基准）。 */
  sharpeThreshold: number;
  /** **通缩后的 Sharpe 概率** —— ≥ 0.95 才算通过多重检验。 */
  dsr: number;
  /** 偏度 / 峰度（非正态性会削弱显著性）。 */
  skew: number;
  kurtosis: number;
  /** 一句话结论（给人看的）。 */
  verdict: string;
}

/**
 * 算 Deflated Sharpe Ratio。
 *
 * 公式（Bailey & López de Prado 2014）：
 *
 * ```
 *   SR0 = √Var(SR) · [ (1-γ)·Φ⁻¹(1 - 1/K) + γ·Φ⁻¹(1 - 1/(K·e)) ]
 *   DSR = Φ[ (SR - SR0)·√(N-1) / √(1 - γ3·SR + (γ4-1)/4·SR²) ]
 * ```
 *
 * 其中 `γ3` = 偏度、`γ4` = 峰度、`N` = 样本数、`K` = 试验次数。
 */
export function deflatedSharpe(input: DsrInput): DsrResult | null {
  const r = input.returns;
  const n = r.length;
  /* 少于 4 个样本连偏度/峰度都算不了 —— 直接返回 null（"还没有结论"）。 */
  if (n < 4 || input.trials < 1) return null;

  const mean = r.reduce((a, b) => a + b, 0) / n;
  const m2 = r.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2);
  if (!(sd > 1e-9)) return null; /* 波动为 0 → 无法评估（与 allocator 同一判据） */

  const sharpe = mean / sd;

  /* 偏度与峰度（总体矩，Bailey 原文用的就是这两个）。 */
  const skew = r.reduce((a, b) => a + (b - mean) ** 3, 0) / n / sd ** 3;
  const kurtosis = r.reduce((a, b) => a + (b - mean) ** 4, 0) / n / sd ** 4;

  /*
   * `Var(SR)` 的估计 —— Bailey 原文用 `(1 - γ3·SR + (γ4-1)/4·SR²) / (N-1)`。
   * 这与下面 DSR 的分母是**同一个量**，所以先算出来复用（少一次重复计算，
   * 也保证两处用的是同一个数）。
   */
  const varSr = (1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2) / (n - 1);
  if (!(varSr > 0)) return null;

  const k = Math.max(1, input.trials);
  /*
   * 期望最大 Sharpe 上限。
   *
   * ## ⚠️ `K = 1` 是**退化情形**，必须单独处理（我自己的测试当场抓到的）
   *
   * 公式里第一项是 `Φ⁻¹(1 - 1/K)` —— 当 `K = 1` 时那是 `Φ⁻¹(0)`，
   * **数学上是 -∞**，而数值实现会**抛错**（`normalInv` 要求 `0 < p < 1`）。
   *
   * 正确的语义是：**只试了一次就没有多重比较，也就没有通缩** →
   * 门槛应当恰好为 **0**。所以这里显式短路，而不是去凑一个近似值。
   */
  const sharpeThreshold = k < 2
    ? 0
    : Math.sqrt(varSr) * (
      (1 - EULER_GAMMA) * normalInv(1 - 1 / k) + EULER_GAMMA * normalInv(1 - 1 / (k * Math.E))
    );

  const dsr = normalCdf((sharpe - sharpeThreshold) * Math.sqrt(n - 1) / Math.sqrt(varSr));

  const verdict = dsr >= 0.95
    ? `通过（DSR ${dsr.toFixed(3)} ≥ 0.95）—— 试了 ${k} 个变体后仍然显著`
    : `**未通过**（DSR ${dsr.toFixed(3)} < 0.95）—— 试了 ${k} 个变体，这个"最好"可能只是运气`;

  return { sharpe, samples: n, sharpeThreshold, dsr, skew, kurtosis, verdict };
}
