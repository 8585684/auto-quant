/**
 * **看板错误边界** —— 一条坏记录不该让整个页面白屏。
 *
 * ## 为什么需要它（本轮实测踩到）
 *
 * 用真实浏览器验证团队看板时，我插了一条**字段不全**的决策记录
 * （只给了 `symbol`/`action`，而真实记录有 14 个字段），结果：
 *
 * ```
 * TypeError: Cannot read properties of undefined (reading 'length')
 *   at TraderPage-*.js
 * BODY: （空）        ← 整个页面白屏
 * ```
 *
 * **一条数据异常 → 整个控制台不可用**，连"去别的地方看看"都做不到。
 *
 * ## 为什么用错误边界，而不是去修那个具体的 `.length`
 *
 * 1. **找不到是哪一个**：构建产物里只给出行号，而候选点有二十多个；
 * 2. **修完这一个还有下一个**：决策记录是从模型输出解析来的，
 *    字段缺失/类型不对是**常态**（模型不总是听话）；
 * 3. **边界能防住所有同类的**：包括未来新增的渲染代码。
 *
 * ## 边界该在哪一层
 *
 * **包住每一轮决策**（而不是整个页面）—— 这样一条坏记录只影响它自己那一块，
 * 其余决策与页面照常显示。包在页面级会让"一条坏记录 = 全页不可用"，
 * 那正是要避免的。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时显示什么（缺省是一句通用说明）。 */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 把渲染异常挡在里面的边界。
 *
 * ⚠️ **必须说清"是哪一块坏了"**，而不是显示一句"出错了" ——
 * 用户看到白屏时最需要知道的是"这是数据问题还是系统挂了、要不要管"。
 */
export class FeedErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * 打到控制台 —— 用户报问题时能从这里拿到栈。
     * 不往服务端发（本项目没有前端错误上报，也不该为此新增一条链路）。
     */
    console.error('[决策看板] 某一块渲染失败：', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs">
          <div className="font-medium text-warn">这一块渲染失败</div>
          <div className="mt-0.5 text-ink-soft">
            {/*
              说清"数据可能不完整"这个最可能的原因 —— 决策记录是从模型输出解析来的，
              字段缺失是常态。用户据此能判断"不用管，刷新看看"还是"该报个问题"。
            */}
            这条记录的数据可能不完整（决策记录由模型输出解析而来）。
            其余内容不受影响，页面其他部分照常可用。
          </div>
          <div className="num mt-1 text-ink-faint">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
