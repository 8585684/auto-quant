/**
 * 「停止机器人」的二次确认 —— **四个入口共用这一份**。
 *
 * ## 为什么这个组件必须存在（外部 issue #121）
 *
 * 停止机器人**不会平仓**。误停一台**持有杠杆仓位**的机器人的后果是：
 * 它不再管理这些仓位 —— 保护位不再被跟踪调整、决策循环退出，
 * 而那笔仓位还在交易所上担着风险。
 *
 * 而全前端有**四个**停止入口，原先只有机器人列表页有确认：
 *
 * | 入口 | 位置 | 原先 |
 * | --- | --- | --- |
 * | 机器人列表页 | `TradersPage.tsx` | ✅ 有确认 |
 * | 总览页 | `OverviewPage.tsx` / `overviewParts.tsx` | ❌ **单击即停** |
 * | 机器人详情页 | `TraderPage.tsx` | ❌ **单击即停** |
 * | 命令面板 | `CommandPalette.tsx` | ❌ **回车即停** |
 *
 * 而更危险的「删除」在列表页**反倒是有**确认的 —— 这个反差说明三处缺失是漏改，
 * 不是有意的取舍。
 *
 * ## 为什么抽成组件，而不是在三处各写一遍
 *
 * 确认弹窗的价值**全在那段后果说明里**（"不会自动平仓"）。三处各写一遍，
 * 迟早只改其中一处 —— 那就又制造出"同一件事有三个说法"，而操作员会读到
 * 互相矛盾的两个版本。所以文案与结构只在这里定义一次。
 *
 * ⚠️ 这正是本仓库反复记录的那类失效（`docs/COLLABORATION.md` §6）：
 * 各自正确的多份实现合起来会失效。
 */
import { Button, Modal } from './ui';

/**
 * 「停止」的后果说明 —— **四处共用的唯一一份文案**。
 *
 * 单独抽出来的理由见文件头：确认弹窗的价值全在这段话里。
 * 命令面板不能用 `ConfirmStopTrader`（它是在自己的对话框里内联换一步，
 * 再嵌一层 Radix Dialog 会打乱焦点陷阱），所以它渲染这个片段而不是另抄一份文字。
 */
export function StopConsequence({ name }: { name: string | undefined }) {
  return (
    <div className="space-y-2">
      <p className="text-base leading-relaxed text-ink-mid">
        停止 <span className="font-semibold text-ink-hi">{name}</span> 会立即结束当前循环。
      </p>
      <p className="text-base leading-relaxed text-ink-mid">
        后果：该机器人不再开新仓，也不再有模型决策；
        <strong className="font-semibold text-ink-hi">已有的持仓与交易所侧挂单保持不变</strong>
        ，不会自动平仓。重新启动后需要再次通过预检。
      </p>
    </div>
  );
}

export function ConfirmStopTrader({
  trader,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  /** 待停止的机器人；`null` 表示对话框关闭。 */
  trader: { id: number; name: string } | null;
  /** 冗余但显式：调用方通常写 `open={target !== null}`，可读性更好。 */
  open: boolean;
  /** 请求进行中 —— 此时禁用按钮并禁止点遮罩关闭。 */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open && trader !== null}
      onClose={() => (busy ? undefined : onCancel())}
      title={`停止“${trader?.name ?? ''}”`}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" busy={busy} autoFocus onClick={onConfirm}>
            确认停止
          </Button>
        </>
      }
    >
      <StopConsequence name={trader?.name} />
    </Modal>
  );
}
