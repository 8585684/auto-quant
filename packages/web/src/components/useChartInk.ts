/**
 * 图表配色的响应式读取。
 *
 * ## 它解决的是什么问题
 *
 * 图表（canvas 与写进 `stroke` / `fill` 的 SVG）**吃不了 CSS 变量** ——
 * 写 `var(--aq-accent)` 不会报错，只是**什么都不画**。所以它们只能拿到一串
 * 算好的十六进制值，而"算好"这个动作必须在**外观切换之后再做一次**。
 *
 * 有两件事会改变这些取值：**换模板**（控制台与经典是两套配色）与
 * **切深浅**。两者都会派发 `aq:appearance`（见 `templates/lib/appearance.ts`）。
 *
 * 没有这个 hook 时的表现很隐蔽：切完之后整页都变了，只有图表还是上一套配色。
 * 页面看起来"基本正常"，只是图表的绿不是那个绿 —— 而没有人会因此去查代码。
 *
 * ## 为什么用 `useSyncExternalStore` 而不是 `useState` + `useEffect`
 *
 * 外观切换发生在**渲染之外**（用户点标题栏那个按钮，或者外观页上的一次点击），
 * 而订阅外部可变状态正是 `useSyncExternalStore` 的用途：它在并发渲染下也不会
 * 读到撕裂的旧值。
 *
 * ## ⚠️ `getSnapshot` 必须返回**稳定引用**
 *
 * 这一条踩过：`readChartInk()` **每次调用都新建一个对象**，直接拿它当快照，
 * React 会认为"状态一直在变"——
 *
 *   · 轻则每帧重渲染一次（图表不停地重画，看起来像在闪烁）；
 *   · 重则 `useSyncExternalStore` 判定为无限更新并抛
 *     "The result of getSnapshot should be cached to avoid an infinite loop"。
 *
 * 所以缓存挂在模块作用域上（`cached`），由**事件**负责失效：只有外观真的
 * 变了才重读一次颜色，其余时候返回同一个对象。
 */
import { useSyncExternalStore } from 'react';
import { CHART_INK, readChartInk } from './equityCurve';
import { APPEARANCE_EVENT } from '../templates/lib/appearance';

let cached: typeof CHART_INK | null = null;

function subscribe(onChange: () => void): () => void {
  const invalidate = () => {
    cached = null;
    onChange();
  };
  window.addEventListener(APPEARANCE_EVENT, invalidate);
  return () => window.removeEventListener(APPEARANCE_EVENT, invalidate);
}

function getSnapshot(): typeof CHART_INK {
  cached ??= readChartInk();
  return cached;
}

/**
 * 服务端渲染时没有 `getComputedStyle` 可读，直接给字面量。
 *
 * `readChartInk()` 自己也有兜底，但 SSR 里连 `document` 都没有 —— 它会走
 * "不是浏览器"那条分支返回 `CHART_INK`。这里再写一次是为了让快照在服务端
 * 与客户端**首次**渲染时是同一个值，避免 hydration 不匹配。
 *
 * （本应用是纯客户端 SPA，这一条是为将来可能的 SSR 留的。）
 */
function getServerSnapshot(): typeof CHART_INK {
  return CHART_INK;
}

/**
 * 当前外观下的图表配色。换模板或切深浅时返回**新对象**，触发图表重绘。
 *
 * 用法：在图表组件的第一行 `const ink = useChartInk()`，然后把原来读
 * `CHART_INK.x` 的地方换成 `ink.x`。
 */
export function useChartInk(): typeof CHART_INK {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
