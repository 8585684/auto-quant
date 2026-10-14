/**
 * **迁移的外键校验必须在 `COMMIT` 之前**（外部 issue #161）。
 *
 * ## 缺陷形状
 *
 * `db/index.ts` 的 `migrate()` 原顺序是：
 *
 * ```
 * PRAGMA foreign_keys = OFF
 * BEGIN
 *   migration.sql
 *   PRAGMA user_version = N     ← 版本号落定
 * COMMIT                        ← ★ 事务在这里结束
 * finally {
 *   PRAGMA foreign_key_check    ← ★ 校验已经在事务之外了
 *   if (违规) throw
 * }
 * ```
 *
 * 违规时确实会抛（第一次失败**是响的** —— 服务起不来，人会看见）。
 * 但 `user_version` **已经提交**，而下一次启动 `:54-55` 的
 * `if (migration.version <= current) continue;` 会**跳过**该迁移。
 *
 * 于是危险的不是"第一次失败"，而是"**重试即通过**"：
 * 悬空引用被静默固化，`ON DELETE CASCADE` 的子表
 *（持仓 / 成交 / 订单 / 决策 = **账本**）在后续操作里以难读的方式出错。
 *
 * ## 修法可行性（我实测过）
 *
 * `PRAGMA foreign_key_check` **在事务内能看到未提交的违规** —— 实测：
 *
 * ```
 * 事务内 foreign_key_check = [{"table":"child","rowid":1,"parent":"parent","fkid":0}]
 * 提交后 foreign_key_check = [{"table":"child","rowid":1,"parent":"parent","fkid":0}]
 * ```
 *
 * 所以把校验移进 `try` 块、放在 `user_version = N` 之后 `COMMIT` 之前是可行的：
 * 违规时 `throw` 会走**已有的 `ROLLBACK` 分支**，`user_version` 一并回滚，
 * 下次启动会**重新尝试**那个迁移。
 *
 * ## 为什么本文件用源码结构断言
 *
 * 要驱动"v12 之后外键校验失败"需要在 `traders` 重建之后**恰好留下**一条悬空引用 ——
 * 而 v12 的 SQL 是固定的（它自己会重建表、把数据搬过去），
 * 没有注入点能制造那个中间状态。为一个"两行顺序调整"引入可注入的迁移列表，
 * 会让 `migrate()` 的签名变复杂（它是服务启动路径上的核心函数）。
 *
 * 所以这里断言**接线**：校验必须在 `try` 块内、`COMMIT` 之前。
 * 运行时那一半由 `migration.test.ts` 的真实 v12 迁移用例覆盖
 *（它验证"重建 traders 不会级联删掉子表"），以及下面的 SQLite 行为用例。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const SRC = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

/** 剥掉行注释后再匹配 —— 本仓库注释会逐字引用被讨论的代码。 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

test('★★★ foreign_key_check 必须在 COMMIT 之前 —— 否则失败后 user_version 已提交、重试会跳过', () => {
  const code = stripLineComments(SRC);

  const commitIdx = code.indexOf("exec('COMMIT')");
  const checkIdx = code.indexOf('foreign_key_check');
  const rollbackIdx = code.indexOf("exec('ROLLBACK')");

  assert.ok(commitIdx > 0, '找不到 COMMIT —— 结构变了，请更新本测试');
  assert.ok(checkIdx > 0, '找不到 foreign_key_check —— 校验被删了？');
  assert.ok(rollbackIdx > 0, '找不到 ROLLBACK —— 事务失败分支被删了？');

  assert.ok(
    checkIdx < commitIdx,
    '★★★ 外键校验必须在 `COMMIT` **之前**。\n' +
      '    放在 finally（即 COMMIT 之后）的话：违规时 user_version 已经提交，\n' +
      '    下次启动 `migration.version <= current` 会跳过该迁移 ——\n' +
      '    **悬空引用被静默固化**，而它影响的子表是账本（持仓/成交/订单/决策）。\n' +
      '    第一次失败是响的，危险的是"重试即通过"（issue #161）。',
  );

  /*
   * 而且要落在 `try` 块里（否则 throw 走不到 ROLLBACK）。
   * 判据：校验出现在 BEGIN 之后、COMMIT 之前。
   */
  const beginIdx = code.indexOf("exec('BEGIN')");
  assert.ok(beginIdx > 0 && beginIdx < checkIdx, '★ 校验必须落在 BEGIN 之后（在事务内）');
});

test('★★ 事务内 foreign_key_check 能看到未提交的违规 —— 修法的前提', () => {
  /*
   * 这条用例是上面那条的**事实基础**：如果 SQLite 在事务内看不到违规，
   * 那么"把校验移进事务"这个修法就是错的（会永远通过）。
   *
   * 所以这里真的起一个内存库、真的制造悬空引用、真的在事务内查一次。
   */
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  db.exec(
    'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
  );
  db.exec('INSERT INTO parent (id) VALUES (1)');
  db.exec('INSERT INTO child (id, pid) VALUES (1, 1)');

  /* 关外键 → 在事务内删掉父行（不会级联）→ 制造悬空引用。 */
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  db.exec('DELETE FROM parent');

  const inTransaction = db.prepare('PRAGMA foreign_key_check').all();
  assert.ok(
    inTransaction.length > 0,
    '★★ 事务内必须能看到悬空引用 —— 否则"把校验移进事务"这个修法无效，' +
      '而 issue #161 的修法依赖这一点',
  );

  /* ROLLBACK 之后违规必须消失（证明回滚真的撤销了那次删除）。 */
  db.exec('ROLLBACK');
  const afterRollback = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(
    afterRollback.length,
    0,
    '★ ROLLBACK 必须撤销那次删除 —— 这是"失败后下次启动重试"能成立的原因',
  );

  /* 再确认一次：提交之后违规才持久化。 */
  db.exec('BEGIN');
  db.exec('DELETE FROM parent');
  db.exec('COMMIT');
  assert.ok(
    db.prepare('PRAGMA foreign_key_check').all().length > 0,
    '★ 提交后违规会留下 —— 这正是"user_version 已提交就没救了"的机制',
  );
});
