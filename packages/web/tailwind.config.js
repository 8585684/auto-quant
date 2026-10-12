/**
 * ## 颜色令牌为什么是 `rgb(var(...) / <alpha-value>)` 而不是十六进制
 *
 * 这套界面支持**多套模板**（`src/templates/`）：每套模板是一种完全不同的外壳
 * 与配色，但它们共用同一批页面组件。颜色写死十六进制的话，每套模板都要复制
 * 一份配置并重新编译；改成 CSS 变量之后，模板只需覆盖变量，页面代码不动。
 *
 * 默认值在 `index.css` 的 `:root` 里，**就是原来的配色**。
 *
 * ## ⚠️ 三元组是必需的，不是风格问题
 *
 * Tailwind 编译透明度修饰符的方式是把它塞进 `rgb(... / <alpha>)`：
 *
 *     bg-accent/10   →   rgb(var(--aq-accent-rgb) / 0.1)
 *
 * 而 `--aq-accent` 是十六进制（`#7060f5`），于是编译结果
 * `rgb(#7060f5 / 0.1)` **不是合法 CSS** —— 浏览器整条声明丢弃。
 *
 * 危险在于它是**静默**的：类名生成了、构建过了、控制台干净，只是那一层
 * 底色/边框根本不存在。仓库里 `down/10`、`warn/50`、`accent/10` 这类写法
 * 有一百多处（徽章底、提示条底、选中行底、焦点环），全部会一起失效 ——
 * 界面不会"坏"，只会变得寡淡。
 *
 * 更隐蔽的是它**在 `@apply` 里会直接报错**（"The `border-base-850/70`
 * class does not exist"）—— 报错只出现在那几行，容易被当成个别问题修掉，
 * 而剩下几十处继续静默失效。这条真的发生过。
 *
 * 所以每个颜色令牌在 `index.css` 里都配了一份空格分隔的 `R G B`，
 * 这里统一走 `token()`。**两份值必须同步改** —— 只改一份的话，`bg-accent`
 * 与 `bg-accent/10` 会变成两个色，而且不会有任何报错。
 */
const token = (name) => `rgb(var(--aq-${name}-rgb) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * 层级（elevation）而不是"深浅"。
         *
         * base-950 是页面底色，数字越小越靠前。
         *
         * ## 这一版换成**中性黑**（原来偏蓝）
         *
         * 原来的整条阶梯带蓝（`#0b0e14` / `#11151e` …），配合蓝主色是一套完整的
         * 冷暖关系。而参考产品用的是**中性黑 + 紫主色**（实测：底 `#0a0a0a`、
         * 卡片 `#1a1a1a`、边框 `#2f2f2f`，见 `DESIGN-REFERENCE.md`）。
         * 紫是一种很"挑底"的颜色 —— 放在偏蓝的底上会发闷，放在中性黑上才立得住。
         *
         * 三个锚点取自参考，中间几级按同一间距插值。**刻意仍然避开纯黑**：
         * 纯黑底 + 近白字对比度过高，长时间盯盘很累，而且非 OLED 屏上纯黑会与
         * 面板边界糊在一起、看不出层次（这一条原来的理由依然成立）。
         */
        base: {
          950: token('base-950'), // 页面底（参考锚点）
          900: token('base-900'), // 面板
          850: token('base-850'), // 抬升面板 / 表头（参考锚点）
          800: token('base-800'), // 输入框 / hover
          750: token('base-750'), // 分隔线（弱）
          700: token('base-700'), // 边框（参考锚点）
          600: token('base-600'), // 边框（强调）
        },

        /*
         * 文字四级。正文用 ink-hi 而不是纯白 —— 纯白在深色底上会"发光"，
         * 大段阅读时刺眼。纯白只留给真正需要抢注意力的地方（ink-strong）。
         *
         * 色相跟着底色一起从"蓝灰"改成"中性偏紫"：正文取自参考的 `#eae9f4`
         * （它的 G 通道略低于 R/B，是带一点紫的灰白），下面几级按同样的偏移推。
         */
        ink: {
          hi: token('ink'), // 正文 / 主要信息（参考锚点）
          mid: token('ink-mid'), // 次要信息
          lo: token('ink-lo'), // 标签 / 说明
          faint: token('ink-faint'), // 极弱：占位符、禁用
          strong: token('ink-strong'), // 强调：关键数字
          /*
           * ⚠️ `soft` 是**迁移期兼容别名**，值等于 `mid`（见 `index.css` 里
           * 同一行变量上的注释）。上游的多智能体分支里有 13 处写着
           * `text-ink-soft`，而那个类此前根本没被定义过 ——
           * Tailwind 不报错、只是不生成样式，于是那些"次要信息"用了正文色。
           */
          soft: token('ink-soft'),
        },

        /*
         * 交易语义色。
         *
         * 红绿是行业惯例，改色相会让老手看错方向，所以保留 —— 但这一版直接采用
         * **币安自己的绿红**（`#0ecb81` / `#f6465d`）：操作员在交易所端看到的
         * 就是这两个颜色，让控制台与它对上，比"我们自己调过的更好看的绿"有用。
         *
         * 两者明度仍然不同，红绿色盲用户能靠明暗区分（不能只依赖色相）。
         */
        up: token('up'), // 涨 / 多 / 盈利
        down: token('down'), // 跌 / 空 / 亏损
        /*
         * 主操作：**紫**，取自参考（它在对方的构建产物里出现 31 次，是最多的一个色）。
         * 原来这里是蓝 `#5b8def`。
         */
        accent: token('accent'), // 主操作
        'accent-hi': token('accent-hi'), // 主操作 hover
        warn: token('warn'), // 警告

        /*
         * `overlay` 是唯一不能走 `token()` 的：它本身是半透明的，
         * 模板要能同时改色和改透明度，所以拆成两个变量拼出来。
         */
        overlay: 'rgb(var(--aq-overlay) / var(--aq-overlay-alpha))',
      },

      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },

      /*
       * 字号整体上移一档。
       *
       * 原来基线 13px、最小 10px —— 1080p 上已偏小，2K/4K 上基本读不了。
       * 现在最小的辅助字号是 11px，正文 14px。
       *
       * ⚠️ **`base` 必须等于正文尺寸，也就是等于 `body` 的默认值。**
       *
       * 这里踩过一个坑，值得写下来：重设计时我把 `body` 设成 14px，却把 `base`
       * 定义成 13px、让 `md` 去当"正文默认"。而**几乎所有组件都显式写着
       * `text-base`**（126 处 / 33 个文件）—— 它们全是 13px。
       * 于是"我已经把字号调大了"这句话在大部分界面上**根本没有生效**，
       * 用户看到的还是改版前的大小。这个不一致连写它的人都会绕进去。
       *
       * 标准 Tailwind 里 `text-base` 就是正文尺寸；让别的键占据那个位置、
       * 让 `base` 比它更小，是纯粹的自找麻烦。
       *
       * 现在：`base` = 14px = 正文默认。想调正文大小，改这一行就够。
       */
      fontSize: {
        /*
         * 迁移期兼容别名。
         *
         * `2xs` 原本是 10px，是最小的一档。重设计后最小的辅助字号是 11px，
         * 但**不能直接删掉这个键**：Tailwind 对不存在的类不报错，只是不生成
         * 样式 —— 7 个文件里 27 处 `text-2xs` 会静默失去字号，变得和正文一样大，
         * 而这种问题只会在页面上肉眼看出来。
         *
         * 所以保留为 11px 的别名，让老页面先"不变丑"地过渡，
         * 新代码一律用下面的正式档位。全部页面迁移完后可以删掉。
         */
        '2xs': ['11px', '16px'],
        xs: ['11px', '16px'], // 仅辅助信息：角标、单位、表头
        sm: ['12px', '18px'], // 密集列表
        base: ['14px', '21px'], // **正文默认** —— 与 body 一致
        md: ['14px', '21px'], // base 的同义别名（老代码仍在用）
        lg: ['16px', '24px'], // 强调正文、侧栏导航项
        xl: ['18px', '26px'], // 小标题
        '2xl': ['22px', '30px'], // 卡片数值
        '3xl': ['28px', '34px'], // 关键指标
        '4xl': ['36px', '42px'], // 首屏核心数字
      },

      /* 圆角比原来大一点：小圆角在深色界面上显得"硬" */
      borderRadius: {
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
      },

      boxShadow: {
        /* 深色界面的层次主要靠边框与底色差，阴影只做微妙的分离 */
        panel: '0 1px 2px 0 rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.02) inset',
        raised: '0 4px 16px -6px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset',
        overlay: '0 24px 64px -16px rgba(0,0,0,0.75)',
      },

      keyframes: {
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'pulse-soft': 'pulseSoft 1.8s ease-in-out infinite',
        'fade-in': 'fadeIn 140ms ease-out',
        'slide-up': 'slideUp 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slideInRight 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      },

      /*
       * 屏幕适配用 em 而不是 px。
       *
       * 交易界面最怕浏览器缩放把布局搞乱：用 px 断点时，用户放大到 150%
       * 会出现"字变大了但列还是那么窄"的挤压。em 断点会跟着字号一起变，
       * 缩放后仍然拿到合适的列数。
       */
      screens: {
        sm: '40em',
        md: '48em',
        lg: '64em',
        xl: '80em',
        '2xl': '96em',
        '3xl': '120em',
      },
    },
  },
  plugins: [],
};
