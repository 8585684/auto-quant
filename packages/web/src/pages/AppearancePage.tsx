/**
 * 外观：模板 · 主题 · 界面密度。
 *
 * ## 为什么单独一页，而不是塞进「操作员账户」
 *
 * 外观**不是**账户信息。把它挂在账户页会让"改密码"和"换外观"共享一屏，
 * 而两者的心智模型完全不同：一个是安全操作（需要当前密码、有后果），
 * 一个是显示偏好（随手可逆，且不离开这台设备）。混在一起的结果是账户页
 * 看起来像"设置大杂烩"，而真正的安全操作被一堆开关稀释。
 *
 * ## 三组设置的关系（**这一页最重要的那件事**）
 *
 *   · **模板**决定骨架：导航在哪、有没有工具栏、窗口是不是浮着的；
 *   · **主题**（深/浅）与**密度**（行高）是配色与节奏。
 *     一个模板可以同时支持两套主题（控制台就是这样），也可以只有一套
 *     （经典模板是固定的深色）。
 *
 * 它们**正交**，所以这里是三个独立的选择器，不是一个"外观套餐"下拉。
 * 把主题混进模板里，会变成"换个深色版 = 换一套模板"，那是重复劳动 ——
 * 也是这一页存在的理由。
 *
 * ## 切换模板**不刷新页面**
 *
 * 两套模板的 CSS 与组件都在这一个 bundle 里，切换只改 `<html>` 上的根类名
 * （`store.applyTemplateClass`）。刷新页面会断开 WebSocket、清掉当前页面的
 * 状态 —— 而换皮肤不该有这种代价。
 *
 * ## ⚠️ 这一页必须能在**两套模板里都正常显示**
 *
 * 它只用通用的排版原语（`Panel` / `.data-grid` / `SectionHeading`），
 * 不 import 任何模板目录里的东西 —— 否则它会变成"只有某一套外观下才好看"
 * 的页面，而那正是模板系统要避免的分叉。
 */
import { useState } from 'react';
import { Check, LayoutDashboard, Moon, PanelTop, Sun } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { PageShell, SectionLabel } from '../components/shell';
import { Panel, cn } from '../components/ui';
import { listTemplates } from '../templates/registry';
import { TEMPLATE_KEY, useTemplateStore } from '../templates/store';
import type { TemplateId } from '../templates/types';
import {
  DENSITIES,
  DENSITY_KEY,
  SKINS,
  SKIN_KEY,
  getDensity,
  getSkin,
  setDensity,
  setSkin,
  type Density,
  type Skin,
} from '../templates/lib/appearance';

/** 模板卡上的图标：按 id 挑，挑不到就用一个中性的。 */
const TEMPLATE_ICON: Record<string, typeof PanelTop> = {
  classic: PanelTop,
  console: LayoutDashboard,
};

export function AppearancePage() {
  useDocumentTitle('外观');

  const templateId = useTemplateStore((s) => s.id);
  const setTemplateId = useTemplateStore((s) => s.setId);
  const [skin, setSkinState] = useState<Skin>(() => getSkin());
  const [density, setDensityState] = useState<Density>(() => getDensity());

  const pickSkin = (next: Skin) => {
    setSkin(next);
    setSkinState(next);
  };

  const pickDensity = (next: Density) => {
    setDensity(next);
    setDensityState(next);
  };

  return (
    <PageShell>
      <SectionHeading
        title="外观"
        sub="这三项只影响这台设备上的显示，不会同步到服务器，也不影响任何交易行为。"
      />

      {/* ---------------------------------------------------------------- */}
      {/*  模板                                                             */}
      {/* ---------------------------------------------------------------- */}
      {/*
        ## 为什么把模板放在第一位

        它是**骨架**的选择（导航在哪、动作在哪），比配色更根本 ——
        也是这一页唯一会改变"页面结构"的一项。切完会立刻看到整页重排，
        这是刻意的：用户应该一眼看出自己换的是什么。

        ## 卡片从注册表来，不是写死的两个

        `listTemplates()` 会带上运行时注册的第三方模板（见 `registry.ts`）。
        写死两张卡的话，插件式扩展即使注册成功也不会出现在这一页 ——
        一个"能注册但看不见"的接口等于没有接口。
      */}
      <section>
        <SectionLabel title="模板" count={listTemplates().length} />
        <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
          {listTemplates().map((option) => {
            const active = templateId === option.id;
            const Icon = TEMPLATE_ICON[option.id] ?? PanelTop;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setTemplateId(option.id as TemplateId)}
                aria-pressed={active}
                className={cn(
                  'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                  active ? 'border-accent bg-accent-soft' : 'border-base-700 bg-base-900 hover:border-base-600',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                    active ? 'border-accent/50 bg-accent/15 text-accent' : 'border-base-700 text-ink-faint',
                  )}
                >
                  <Icon aria-hidden className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-base font-semibold text-ink-hi">{option.label}</span>
                    {active && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                    {option.ownsPalette && (
                      <span
                        className="chip chip-plain shrink-0 border-base-700 text-ink-lo"
                        title="这套模板自带配色：它会覆盖默认色板（见 templates/<名字>/theme.css）"
                      >
                        自带配色
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-lo">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          {/*
            ⚠️ **这里不能用 Markdown 的 `**粗体**`。** JSX 不解析 Markdown，
            星号会**原样画在屏幕上**（第一版就是这样，截图里一眼看见两处
            `**不刷新页面**`）。要加粗就用 <strong>，或者像这里一样把该强调的
            词单独包一层。
          */}
          模板记在浏览器本地（<span className="num">{TEMPLATE_KEY}</span>），切换时
          <strong className="font-semibold text-ink-lo">不刷新页面、不重连推送</strong>
          。想自己做一套？见仓库里的 <span className="num">packages/web/TEMPLATES.md</span> ——
          只需要一个外壳组件加一条注册，不必碰任何业务页面。
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/*  主题                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionLabel title="主题" />
        <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
          {SKINS.map((option) => {
            const active = skin === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => pickSkin(option.id)}
                aria-pressed={active}
                className={cn(
                  'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                  active ? 'border-accent bg-accent-soft' : 'border-base-700 bg-base-900 hover:border-base-600',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                    active ? 'border-accent/50 bg-accent/15 text-accent' : 'border-base-700 text-ink-faint',
                  )}
                >
                  {option.id === 'dark' ? (
                    <Moon aria-hidden className="h-4 w-4" />
                  ) : (
                    <Sun aria-hidden className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-base font-semibold text-ink-hi">{option.label}</span>
                    {active && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-lo">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          主题记在浏览器本地（<span className="num">{SKIN_KEY}</span>），并且由
          <span className="num"> index.html </span>
          里的一段内联脚本在样式表生效前读出来 —— 所以刷新时不会先闪一下另一种底色。
          <br />
          ⚠️ <strong className="font-semibold text-ink-lo">经典模板只有深色</strong>
          ：它的配色就是原版配色，这一项在那套外壳下不生效（切了不会坏，只是看不出来）。
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/*  密度                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionLabel title="界面密度" />
        <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-3">
          {DENSITIES.map((option) => {
            const active = density === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => pickDensity(option.id)}
                aria-pressed={active}
                className={cn(
                  'min-w-0 rounded-lg border px-3 py-2.5 text-left transition',
                  active ? 'border-accent bg-accent-soft' : 'border-base-700 bg-base-900 hover:border-base-600',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-base font-semibold text-ink-hi">{option.label}</span>
                  {active && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-lo">{option.hint}</span>
              </button>
            );
          })}
        </div>

        <Panel className="mt-3" title="预览">
          {/*
            预览用**真实**的 `.th` / `.td` 与真实的行高变量 —— 一个用 div 画出来的
            "示意图"永远会和真表格差几个像素，而这几像素正是用户要判断的东西。
          */}
          <div className="scroll-x">
            <table className="data-grid w-full border-collapse">
              <thead>
                <tr>
                  <th className="th">交易对</th>
                  <th className="th text-right">价格</th>
                  <th className="th text-right">24h</th>
                  <th className="th text-right">成交额</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['BTCUSDT', '82,713.40', '-0.60%', '103.30B'],
                    ['ETHUSDT', '2,530.86', '+0.76%', '104.84B'],
                    ['DOGEUSDT', '0.08510', '-1.56%', '107.33B'],
                  ] as const
                ).map(([symbol, price, change, volume]) => (
                  <tr key={symbol}>
                    <td className="td num">{symbol}</td>
                    <td className="td num text-right">{price}</td>
                    <td className={cn('td num text-right', change.startsWith('-') ? 'text-down' : 'text-up')}>
                      {change}
                    </td>
                    <td className="td num text-right text-ink-lo">{volume}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          密度只改<strong className="font-semibold text-ink-lo">表格行高</strong>（
          <span className="num">--aq-row-h</span>，记在{' '}
          <span className="num">{DENSITY_KEY}</span>），不改字号：字号是全站排版基准，
          跟着密度变会让"正文一个尺寸"这个前提失效，而字号是写死像素的 ——
          结果是一半文字变了一半没变。
          <br />
          经典模板下这一项同样不生效：它的行高就是原版的行高。
        </p>
      </section>
    </PageShell>
  );
}
