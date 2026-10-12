import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyStoredAppearance } from './templates/lib/appearance';
import { applyStoredTemplate } from './templates/store';
/*
 * 模板样式的自动发现（`import.meta.glob`）。
 *
 * ⚠️ 这一个 import 是有**副作用**的：它把 `templates/<名字>/theme.css`
 * 全部拉进 bundle，并且把目录里的第三方外壳注册进注册表。**必须留在
 * `App` 之前** —— 少了它，模板的 CSS 根本不在产物里（控制台模板会只剩
 * 结构、没有任何配色），而那种失败看起来只像"样式没写完"。
 *
 * ## 排在 `App` 之前还有第二个理由：读 localStorage 时注册表已经齐了
 *
 * `store.ts` 在**模块求值**时就读 localStorage 决定当前模板（`readInitial`），
 * 而这次 `getTemplate()` 的结果会被 `Layout` 直接拿去渲染。所以"有哪些模板"
 * 必须在那一刻就确定下来 —— 顺序反了的话，用户上一次选的第三方模板会被
 * 判成孤儿 id、回落到经典。
 *
 * （实测过一次：把这一行挪到 `App` **之后**并不复现故障 —— 因为
 * `useTemplateStore(s => s.current)()` 是在**渲染**时求值的，那时所有模块
 * 早已求值完毕。但这个顺序仍然是该保持的：它不依赖任何关于"Hook 何时调用"
 * 的推理，读起来就是"模板先注册，再启动"。）
 */
import './templates/themes';
import './index.css';

/*
 * 外观开关（模板 / 深浅 / 密度）在 React 挂载**之前**写回 `<html>`。
 *
 * `index.html` 里的内联脚本已经做过同样的事（那是为了首帧不闪），这里是
 * 幂等的第二道 —— 防的是"内联脚本被 CSP 挡掉"或"属性被别的脚本覆盖"。
 * 放在 `createRoot` 之前而不是 `App` 的 effect 里：effect 跑在首屏渲染
 * **之后**，那时用错模板的样式已经画过一帧了。
 */
applyStoredAppearance();
applyStoredTemplate();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
