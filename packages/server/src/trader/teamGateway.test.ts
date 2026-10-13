/**
 * 团队网关配置解析的测试。
 *
 * ## 为什么要测它（这是实测踩了两次的坑）
 *
 * magpie 的配置文件权限是 `-rw-------`（属主是容器内 UID 65532），
 * 服务以 `autoquant` 身份跑，**读不到**。第一次踩到的是 `plugin-providers.json`
 * （免费标注全变未知），第二次是 `caller-keys.json`（团队模式静默退回单模型）。
 *
 * 而"静默退回"是本项目最不能接受的一类失败 —— 界面上写着"AI 团队"，
 * 实际在用**一个模型**跑。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTeamGateway, DEFAULT_MAGPIE_URL } from './teamGateway.js';

/** 造一个假的读文件函数（内容按路径给）。 */
function reader(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

/** 实测的真实形状：一个数组，每项有 `secret`。 */
const KEYS_JSON = JSON.stringify([{ id: 'aq', secret: 'sk-magpie-test-123', label: 'autoquant' }]);

test('★ 显式配置（.env）优先 —— 用户说了算', () => {
  const g = resolveTeamGateway(
    { MAGPIE_GATEWAY_URL: 'http://10.0.0.5:9999/v1', MAGPIE_GATEWAY_KEY: 'explicit-key' },
    reader({}),
  );
  assert.equal(g?.baseUrl, 'http://10.0.0.5:9999/v1');
  assert.equal(g?.apiKey, 'explicit-key');
  assert.ok(g?.source.includes('.env'));
});

test('★★ 能读到部署脚本同步的 key 副本（这是修好的那条路径）', () => {
  /*
   * 服务器上的真实形态：部署脚本把 key 复制到 `/opt/autoquant/data/`，
   * 因为 magpie 原文件服务读不到。
   */
  const g = resolveTeamGateway(
    {},
    reader({ '/opt/autoquant/data/magpie-caller-keys.json': KEYS_JSON }),
  );
  assert.ok(g, '★ 必须能从同步的副本里读到 key');
  assert.equal(g?.apiKey, 'sk-magpie-test-123');
  assert.equal(g?.baseUrl, DEFAULT_MAGPIE_URL, '只给了 key 时地址用默认值');
  assert.ok(g?.source.includes('magpie-caller-keys'), '来源要能看出来（排查时第一个要问的）');
});

test('★ `MAGPIE_GATEWAY_KEY_FILE` 指到哪就从哪读', () => {
  const g = resolveTeamGateway(
    { MAGPIE_GATEWAY_KEY_FILE: '/custom/keys.json' },
    reader({ '/custom/keys.json': KEYS_JSON }),
  );
  assert.equal(g?.apiKey, 'sk-magpie-test-123');
  assert.ok(g?.source.includes('/custom/keys.json'));
});

test('★★ 读不到任何 key → 返回 null（让调用方明确报告，不静默降级）', () => {
  /*
   * 这是本模块**最重要**的行为约定。
   *
   * 返回 null 后，`manager` 会写一条 `severity: 'error'` 的 preflight check
   * 与一条 error 级日志，明确说"AI 团队模式未启用、当前按单模型运行"。
   *
   * **绝不能在这里编一个 key 或退回别的配置** —— 那正是"静默走错路"的形状。
   */
  const g = resolveTeamGateway({}, reader({}));
  assert.equal(g, null, '★ 找不到就必须返回 null');
});

test('★ key 文件是坏 JSON → 不崩，返回 null', () => {
  const g = resolveTeamGateway({}, reader({ '/opt/autoquant/data/magpie-caller-keys.json': '{坏 JSON' }));
  assert.equal(g, null);
});

test('★ key 文件里没有 secret 字段 → 返回 null（不拿空串去请求）', () => {
  const g = resolveTeamGateway({}, reader({ '/opt/autoquant/data/magpie-caller-keys.json': JSON.stringify([{ id: 'x' }]) }));
  assert.equal(g, null);
});

test('★ 兼容 `{ keys: [...] }` 形态（magpie 若改结构）', () => {
  const g = resolveTeamGateway(
    {},
    reader({ '/opt/autoquant/data/magpie-caller-keys.json': JSON.stringify({ keys: [{ secret: 'k2' }] }) }),
  );
  assert.equal(g?.apiKey, 'k2');
});

test('只配了 URL 没配 key → 仍走自动发现，且用配置的 URL', () => {
  const g = resolveTeamGateway(
    { MAGPIE_GATEWAY_URL: 'http://myhost:3425/v1' },
    reader({ '/opt/autoquant/data/magpie-caller-keys.json': KEYS_JSON }),
  );
  assert.equal(g?.baseUrl, 'http://myhost:3425/v1');
  assert.equal(g?.apiKey, 'sk-magpie-test-123');
});
