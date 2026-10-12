/**
 * 操作员账户。
 *
 * 这一页是**安全设置**，不是资料页：系统没有注册入口，账号在服务首次启动时
 * 自动创建，之后只能在这里改。版面按 `LAYOUT.md` §1 分成两半：
 *
 *   左指标栏（只读状态）：当前身份 / 角色 / 账户创建时间 / 服务端版本 / 数据库 / 运行环境。
 *     这些数字回答的是"我现在改的是哪个账号、跑在什么环境里" —— 它们是**状态**，
 *     改密码时不需要动它们，所以不该和表单抢同一列。
 *   主内容区：凭据变更表单（用户名 / 当前密码 / 新密码）。
 *
 * **供应商目录已删除**：那是一张"这个版本支持哪些模型厂商"的静态清单，与
 * "改我的账号凭据"没有任何关系，而它占了整页最下方一大块。要看供应商清单去
 * 「AI 模型」页 —— 那里每一行都是**你实际配置过的**模型，比一张通用目录有用。
 * （见 `git log` 里 `fix(ui): 账号页删掉与它无关的供应商目录`。）
 *
 * `PATCH /api/auth/account` 要求**当前密码**，这是有意为之：能碰到这台浏览器的人
 * 不应该因此就能永久接管账户。这一道校验在前端不做任何"放宽" ——
 * 契约保持原样：`currentPassword` 必填，`username` 与 `newPassword`（≥8）可选，
 * 服务端重新签发令牌后本地必须换掉那一份（否则后续请求带的还是旧身份）。
 */
import { useState } from 'react';
import { Save } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { api, setToken } from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import { Button, ErrorNote, Field, Panel, TextInput } from '../ui';
import { Metric, MetricGroup, PageShell, SectionLabel } from '../shell';
import { fmtDateTime } from '../../lib/format';

export function AccountSection() {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const health = useApp((s) => s.health);
  const bootstrap = useApp((s) => s.bootstrap);

  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /*
   * 部署版本，以及"线上是不是最新的"。
   *
   * 版本比对**单独加载**，因为服务端要为它出网（打 GitHub，8 秒超时）——
   * 塞进 `/api/system` 会让整页的加载被一个有则更好、没有也无妨的诊断拖住。
   * 不带 interval：打开这一页查一次就够，服务端自己缓存 10 分钟。
   */
  const build = system?.build ?? null;
  const update = usePolled((signal) => api.updateCheck(signal), { intervalMs: 0 });

  const updateLabel = update.error
    ? '检查失败'
    : update.loading
      ? '检查中…'
      : update.data?.state === 'up-to-date'
        ? '一致'
        : update.data?.state === 'behind'
          ? `落后${update.data.behindBy === null ? '' : ` ${update.data.behindBy} 个提交`}`
          : update.data?.state === 'ahead'
            ? '领先（未推送）'
            : update.data?.state === 'diverged'
              ? '已分叉'
              : '未知';
  const updateTone: 'default' | 'up' | 'warn' = update.error
    ? 'warn'
    : update.data?.state === 'up-to-date'
      ? 'up'
      : update.data?.state === 'behind' ||
          update.data?.state === 'ahead' ||
          update.data?.state === 'diverged'
        ? 'warn'
        : 'default';

  const reset = () => {
    setNewUsername('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
  };

  const submit = async () => {
    setError(null);
    setDone(null);

    const username = newUsername.trim();
    const wantsUsername = username.length > 0 && username !== user?.username;
    const wantsPassword = newPassword.length > 0;

    // 前端先拦一道，避免为明显的输入问题跑一趟网络；
    // 真正的校验在服务端，这里只是省一次往返。
    if (!wantsUsername && !wantsPassword) {
      return setError('没有需要修改的内容 —— 请填写新用户名或新密码。');
    }
    if (!currentPassword) {
      return setError('请输入当前密码。修改凭据必须验证当前密码。');
    }
    if (wantsPassword && newPassword.length < 8) {
      return setError('新密码至少需要 8 个字符。');
    }
    if (wantsPassword && newPassword !== confirm) {
      return setError('两次输入的密码不一致。');
    }

    setBusy(true);
    try {
      const result = await api.updateAccount({
        currentPassword,
        ...(wantsUsername ? { username } : {}),
        ...(wantsPassword ? { newPassword } : {}),
      });

      // 用户名变了，服务端会重新签发令牌 —— 必须换掉本地那份，
      // 否则后续请求带的还是旧身份。
      setToken(result.token);
      await bootstrap();

      const parts: string[] = [];
      if (wantsUsername) parts.push('用户名');
      if (wantsPassword) parts.push('密码');
      setDone(`${parts.join('与')}已更新。`);

      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------------ */
  /*  伴随栏：只读状态与部署信息                                              */
  /* ------------------------------------------------------------------------ */
  /*
   * ## 为什么状态回到伴随栏，而不是"横排占整宽"
   *
   * 这块指标**曾经**就在伴随栏里被截断过：`MetricGroup` 的列数是按**视口**
   * 断点算的（不看容器宽度），伴随栏只占视口的 40%，`columns={4}` 却照样排
   * 四列 —— 每列约 150px，而 `Metric` 的数值带 `truncate`：`main @ 222ae15`、
   * `2026-09-20 03:33`、`autoquant.sqlite` 全被静默切掉。
   *
   * 当时的修法是"横排占整宽"。宽度是够了，但页面变成了**两张互不相干的表**：
   * 上面一条占满整宽的大字指标带，下面左边一个表单、右边一段说明，中间大片空白。
   *
   * 现在回到伴随栏，但换一条思路解决截断：**列数跟着栏宽显式降下来**。
   * 这一栏里所有指标都用 `columns={1}`（一行一个），于是长值天然放得下 ——
   * 不再依赖"整宽"这件事，也就不需要占满整宽。
   *
   * ⚠️ **不要给这里的任何一组改回 3/4 列**：那是把同一次静默截断再犯一次。
   */
  const rail = (
    <div className="space-y-4">
      <Panel title="当前账户" bodyClassName="p-4">
        <MetricGroup title="身份" columns={1}>
          <Metric label="用户名" value={user?.username ?? '—'} size="lg" tone="strong" />
          <Metric
            label="角色"
            value={user?.role ? userRoleLabel(user.role) : '—'}
            sub={user?.role ?? undefined}
          />
          <Metric label="账户创建时间" value={fmtDateTime(user?.createdAt)} />
        </MetricGroup>

        <MetricGroup title="运行环境" columns={1}>
          <Metric
            label="模式"
            value={system?.dryRun ? '模拟' : '实盘'}
            tone={system?.dryRun ? 'default' : 'warn'}
            sub={system?.environmentLabel ?? system?.environment ?? '—'}
            subTitle={system?.environmentLabel ?? system?.environment ?? undefined}
          />
        </MetricGroup>
      </Panel>

      <Panel title="服务端" bodyClassName="p-4">
        <MetricGroup title="版本与部署" columns={1}>
          <Metric
            label="服务端版本"
            value={build ? `${build.branch} @ ${build.commitShort}` : '未知'}
            sub={build?.subject || (build ? undefined : '本次部署没有写出版本信息')}
            subTitle={build?.subject}
            tone={build?.dirty ? 'warn' : 'default'}
          />
          <Metric label="部署时间" value={build?.deployedAt ? fmtDateTime(build.deployedAt) : '—'} />
          <Metric
            label="与 GitHub"
            value={updateLabel}
            tone={updateTone}
            sub={update.error ?? update.data?.message}
            subTitle={update.error ?? update.data?.message}
          />
        </MetricGroup>

        <MetricGroup title="运行时" columns={2}>
          <Metric label="产品版本" value={system?.version ?? health?.version ?? '—'} />
          <Metric label="数据库" value={health?.db ?? '—'} />
        </MetricGroup>
      </Panel>
    </div>
  );

  /*
   * 账户说明 = 表单的注脚。
   *
   * 它原来在右栏里、和「服务端」那些指标叠在一起，而左栏的表单比它高一截 ——
   * 两栏底部对不齐，右下角空出半屏。这一段只说三件事（没有注册入口、忘记密码
   * 只能去服务器、打包不干净时线上代码无法解释），而**读它的人正在做"改密码"
   * 这件事**，所以它跟着表单走，落在表单下面。
   */
  const notes = (
    <Panel title="账户说明">
      <div className="space-y-2 text-xs leading-relaxed text-ink-mid">
        <p>
          本系统面向单人部署：管理员账号在服务首次启动时自动创建，<strong>不提供注册入口</strong>
          ，也没有找回密码的流程 —— 修改只能在这里做，且必须验证当前密码。
        </p>
        <p>如果用户名与密码都忘了，只能到服务器上重置数据库里的凭据记录。</p>
        {build?.dirty && (
          <p className="text-warn">
            ⚠ 打包时工作区有未提交改动 —— 线上跑的代码<strong>不等于</strong> {build.commitShort}{' '}
            这个提交，它的行为无法用仓库里的任何一版解释。
          </p>
        )}
      </div>
    </Panel>
  );

  /*
   * 版面：伴随栏放**只读的**（我是谁、跑在什么版本上），主区放**唯一的动作**
   * （改凭据）—— 与「交易所」页同一套结构，两屏之间不用重新学怎么读。
   *
   * `fillHeight={false}`：这一页内容少，撑满视口只会在最下面空出半屏纯黑。
   * 表单也不再自己限宽（原来 `max-w-xl` + 外层再套列宽，结果左边空出四百多
   * 像素）：它现在只占主内容列，输入框横跨这一列正是该有的宽度。
   */
  return (
    <PageShell aside={rail} fillHeight={false}>
      <section className="min-w-0">
        <SectionLabel
          title="修改用户名与密码"
          actions={<span className="text-xs text-ink-faint">Enter 提交 · Esc 清空</span>}
        />
        <Panel>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onKeyDown={(event) => {
              // Esc 清空表单：和对话框里的取消保持一致，别让半填的密码留在屏幕上
              if (event.key === 'Escape') reset();
            }}
          >
            <Field label="新用户名" hint="留空则不修改。">
              <TextInput
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                autoComplete="username"
                placeholder={user?.username ? `留空则保持 ${user.username}` : '留空则不修改'}
              />
            </Field>

            <Field
              label="当前密码"
              hint="修改任何一项都必须验证当前密码 —— 服务端会拒绝没有它的请求。"
            >
              <TextInput
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="修改任何一项都需要验证"
              />
            </Field>

            <Field label="新密码" hint="留空则不修改，至少 8 个字符。">
              <TextInput
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="留空则不修改"
              />
            </Field>

            <Field label="确认新密码" hint="与新密码完全一致。">
              <TextInput
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                placeholder="与新密码一致"
              />
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}
            {done && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-md border border-up/40 bg-up/10 px-3 py-2 text-base text-up"
              >
                <span aria-hidden>✓</span>
                <span className="min-w-0">
                  {done}
                  {done.includes('用户名') && ' 服务端已重新签发令牌，当前会话继续有效。'}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" busy={busy}>
                <Save aria-hidden className="h-3.5 w-3.5" />
                保存修改
              </Button>
              <Button type="button" onClick={reset} disabled={busy}>
                清空
              </Button>
            </div>
          </form>
        </Panel>
      </section>

      {notes}
    </PageShell>
  );
}
