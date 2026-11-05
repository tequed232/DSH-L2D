/**
 * dsh-l2d · SQLite 打开与迁移（node:sqlite，Node >= 22.5）
 *
 * - 本机 Node 22.22 实测免旗标可用（带 ExperimentalWarning）；
 *   若宿主 Node 需要，请以 `node --experimental-sqlite` 运行。
 * - 连接即施加 PRAGMA（外键/WAL/busy_timeout），并按 schema_migrations 逐版本迁移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.mjs';

export { SCHEMA_VERSION };

/** 默认库路径：<仓库根>/data/bootstrap-state.sqlite（仓库根=向上找到 pnpm-workspace.yaml）。 */
export function defaultDbPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.join(dir, 'data', 'bootstrap-state.sqlite');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(startDir), 'data', 'bootstrap-state.sqlite');
}

export function resolveDbPath(options = {}) {
  return options.path
    || process.env.DSH_L2D_DB_PATH
    || defaultDbPath(options.startDir);
}

/**
 * 打开数据库并完成迁移。
 * @param {{path?: string, startDir?: string}} [options]
 * @returns {DatabaseSync}
 */
export function openDb(options = {}) {
  if (typeof DatabaseSync !== 'function') {
    throw new Error('node:sqlite 不可用：请使用 Node >= 22.5（必要时加 --experimental-sqlite）');
  }
  const file = resolveDbPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** 逐版本应用迁移；重复打开不重复执行。 */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    duration_ms INTEGER NOT NULL DEFAULT 0
  );`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)),
  );
  for (const [version, ddl] of Object.entries(MIGRATIONS)) {
    const v = Number(version);
    if (applied.has(v)) continue;
    const started = Date.now();
    try {
      withTransaction(db, () => {
        db.exec(ddl);
        db.prepare('INSERT INTO schema_migrations (version, duration_ms) VALUES (?, ?)').run(v, Date.now() - started);
      });
    } catch (err) {
      throw new Error(`迁移 v${v} 失败：${err.message}`);
    }
  }
  return { appliedTo: SCHEMA_VERSION };
}

/**
 * 事务包装：fn 抛错即回滚；支持嵌套（内层转 SAVEPOINT）。
 * Node 22 的 node:sqlite 无 beginTransaction()，故用 SQL 语句手工管理。
 */
export function withTransaction(db, fn) {
  const depth = db.__dshL2dTxDepth || 0;
  const savepoint = `dsh_l2d_sp_${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  db.__dshL2dTxDepth = depth + 1;
  try {
    const result = fn();
    db.__dshL2dTxDepth = depth;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.__dshL2dTxDepth = depth;
    if (depth === 0) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    } else {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch { /* 已回滚 */ }
    }
    throw err;
  }
}
