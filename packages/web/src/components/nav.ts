/**
 * 导航表 —— 两套外壳、菜单栏与命令面板共用的**唯一**一份路由清单。
 *
 * ## 为什么必须有这一份
 *
 * 需要"跳页面"的地方有四个：经典模板的顶部导航、控制台模板的侧栏与菜单栏、
 * 命令面板。各写一份列表就一定会漂移 —— 加了一个页面，只有顶部导航有；
 * 侧栏搜不到；命令面板里跳不过去。同一个数组喂给所有地方，漂移这件事就不存在了。
 *
 * 标签必须与页面语义一致，不要为了短而改叫法 —— 用户是照着导航记路名的。
 *
 * ## 分组不是装饰
 *
 * 九个平级的导航项读起来没有层级：**看盘的**（总览/机器人/行情）和
 * **配置的**（模型/交易所/账户）是两类完全不同的动作，混在一列里，
 * 用户每次都要从九个里挑。分组之后，视线只需先落在组标题上。
 *
 * ⚠️ 分组同时被**控制台模板的菜单栏**复用（一组一个下拉）。所以组名要短 ——
 * 菜单栏是横排的，四个字就是上限。
 *
 * ⚠️ 经典模板**不用**这个分组：它的顶栏横排，用的是 `NavItem.group`
 * 那个"收进设置下拉"的小分组（见下面的字段注释）。两份分组不是一回事，
 * 一份是业务层级、一份是屏幕空间的取舍，所以它们分开存。
 *
 * ⚠️ 这里**只**放导航链接本身。页面级标题由各页面自己的内容区渲染：
 * 应用外壳不再渲染标题（LAYOUT.md §0/§1）；控制台模板的标题栏会从这张表
 * 反查一个"文档名"，那是那套外壳自己的事。
 */
import {
  ArrowLeftRight,
  Bot,
  ChartCandlestick,
  CircleHelp,
  FlaskConical,
  LayoutDashboard,
  Palette,
  ScrollText,
  Sparkles,
  UserCog,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * `g` 前缀快捷键的第二段（例如 `g` `t` → 机器人）。
   *
   * 只给导航里的一级页面。字母取自中文名的英文对位，不是首字母拼音 ——
   * 拼音首字母在"策略/数据"和"模型/行情"上会打架。
   */
  jump: string;
  /**
   * 顶栏把这一项收进哪个下拉。不写 = 直接显示在顶栏上。
   *
   * ## 为什么要有这个字段
   *
   * 顶栏横着排九项时，每一项都变得又窄又挤，而其中三项（模型 / 交易所 / 账户）
   * 是**低频的配置操作** —— 它们和"看机器人现在怎么样"不是同一类动作，
   * 却各占一格最贵的位置。
   *
   * ⚠️ **它只影响顶栏的呈现**：小屏抽屉仍然平铺全部（那里是纵向列表，收起
   * 只会多一次点击），命令面板也仍然列出全部（它的价值就是"什么都能搜到"）。
   */
  group?: 'settings';
}

/**
 * 导航分组（控制台模板的侧栏与菜单栏用）。
 *
 * `NavItem.group` 那个字段管的是**经典模板顶栏**要不要把它收进「设置」下拉，
 * 这里是**业务层级**：一组一个下拉、一组一个侧栏小节。两者不要合并 ——
 * 外观页既是低频配置（该收进经典模板的下拉），又属于「系统」组。
 */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * 分组顺序 = 使用频率顺序。
 *
 * 「交易」在最上：这是每天真正在看的东西。「系统」在中间，因为配置类操作
 * 虽然低频，但出问题时（密钥过期、模型欠费）需要**立刻找得到**。
 * 「帮助」在最后 —— 它是文档，不是功能。
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: '交易',
    items: [
      { to: '/', label: '总览', icon: LayoutDashboard, jump: 'o' },
      { to: '/traders', label: '机器人', icon: Bot, jump: 't' },
      { to: '/strategy', label: '策略工作室', icon: FlaskConical, jump: 's' },
      { to: '/market', label: '行情', icon: ChartCandlestick, jump: 'm' },
      { to: '/data', label: '数据与日志', icon: ScrollText, jump: 'd' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/models', label: 'AI 模型', icon: Sparkles, jump: 'a', group: 'settings' },
      { to: '/exchanges', label: '交易所', icon: ArrowLeftRight, jump: 'e', group: 'settings' },
      { to: '/account', label: '操作员账户', icon: UserCog, jump: 'u', group: 'settings' },
      { to: '/appearance', label: '外观', icon: Palette, jump: 'p', group: 'settings' },
    ],
  },
  {
    label: '帮助',
    items: [{ to: '/faq', label: '帮助', icon: CircleHelp, jump: 'h' }],
  },
];

/**
 * 扁平化后的列表。
 *
 * 命令面板（"什么都能搜到"）与模板的标题栏（路径 → 文档名）用它；
 * 侧栏与菜单栏用 `NAV_GROUPS`。
 *
 * ⚠️ **顺序 = `NAV_GROUPS` 展开后的顺序**，不是另排的一份。命令面板按这个
 * 顺序列结果，所以组与组之间的先后关系在两处是一致的。
 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
