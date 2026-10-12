/**
 * 外壳宿主 —— **只剩三件事**：选模板、挂运行时、渲染那套外壳。
 *
 * ## 这里以前是什么
 *
 * 原来这个文件就是那套"顶部导航 + 内容区"的界面本身（约 450 行）。想换一套
 * 外壳，就必须改它；两套外壳并存时，它同时是"默认外观"和"改造目标" ——
 * 任何顺手改一下都会被读成重设计的一部分。
 *
 * 现在两套外壳各自在 `templates/<名字>/` 里，并在 `templates/registry.ts`
 * 注册。**加一套模板不用动这个文件**（见 `TEMPLATES.md`）。
 *
 * ## 三件事的分工
 *
 * 1. **选模板**：`useTemplateStore` 读 localStorage 里的选择，未知 id 会
 *    回落到默认模板 —— 用户从别人的分支切回来时，孤儿 id 不能让应用白屏。
 * 2. **挂运行时**：`<ShellRuntime>` 把副作用（WebSocket、兜底轮询、命令面板、
 *    toast）收在一处。它包在模板**外面**，所以**切模板不会断开推送**。
 * 3. **渲染外壳**：`Shell` 自己渲染导航、内容区与页面动作的挂载点。
 *
 * ## ⚠️ 一个不能破坏的约束
 *
 * `ShellRuntime` 必须在模板外面。放进模板里的话，每次切模板都会重新挂载
 * 它 —— 表现是"切个皮肤，推送断两秒、toast 闪一下"，而且这类抖动很难
 * 被归因到具体的改动上。
 */
import { useEffect } from 'react';
import { ShellRuntime } from '../templates/lib/context';
import { applyTemplateClass, applyStoredTemplate, useTemplateStore } from '../templates/store';

export function Layout() {
  const id = useTemplateStore((s) => s.id);
  const Current = useTemplateStore((s) => s.current)();

  /*
   * 启动时把已保存的模板类挂上。
   *
   * `index.html` 里的内联脚本已经做过一次（为了首帧不闪），这里是幂等的
   * 第二道 —— 万一内联脚本被 CSP 挡掉、或者属性被别的脚本覆盖。
   *
   * 依赖 `id` 而不是空数组：模板**切换**时也要把新类挂上、把旧的摘掉。
   * 不摘的话两套模板的 CSS 会同时命中，表现是"颜色对了一半"，
   * 而且不会有任何报错。
   */
  useEffect(() => {
    applyTemplateClass(Current);
  }, [Current]);

  useEffect(() => {
    applyStoredTemplate();
  }, [id]);

  return (
    <ShellRuntime>
      <Current.Shell />
    </ShellRuntime>
  );
}
