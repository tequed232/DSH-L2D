// audit-log.mjs — update-history.sqlite（node:sqlite）。Token 与敏感串不落库（redact 兜底）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 敏感串脱敏：npm token / GitHub token / 任意 key=value 形态的凭据 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  out = out.replace(/npm_[0-9A-Za-z]{20,}/g, '[REDACTED]');
  out = out.replace(/gh[pousr]_[0-9A-Za-z]{20,}/g, '[REDACTED]');
  out = out.replace(/github_pat_[0-9A-Za-z_]{20,}/g, '[REDACTED]');
  out = out.replace(/\b(?:token|password|passwd|secret|authorization|api[_-]?key|private[_-]?key)\b[=:]\s*\S+/gi, '[REDACTED]');
  return out;
}

export function openHistoryDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      pkg TEXT NOT NULL,
      old_version TEXT,
      new_version TEXT,
      level TEXT,
      command TEXT,
      result TEXT NOT NULL,
      duration_ms INTEGER,
      backup_dir TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_update_history_pkg ON update_history(pkg);
    CREATE INDEX IF NOT EXISTS idx_update_history_project ON update_history(project_dir);
  `);
  return db;
}

export class AuditLog {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = openHistoryDb(dbPath);
  }

  /** 记录一次更新事件。command/detail 先脱敏再落库。 */
  record({
    projectDir, pkg, oldVersion, newVersion, level, command, result, durationMs, backupDir, detail,
  }) {
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(`INSERT INTO update_history
        (ts, project_dir, pkg, old_version, new_version, level, command, result, duration_ms, backup_dir, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ts, projectDir, pkg, oldVersion ?? null, newVersion ?? null, level ?? null,
        redact(command) ?? null, result, durationMs ?? null, backupDir ?? null,
        detail ? redact(JSON.stringify(detail)) : null,
      );
    return { id: Number(info.lastInsertRowid), ts };
  }

  list({ projectDir, pkg, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (projectDir) { where.push('project_dir = ?'); params.push(projectDir); }
    if (pkg) { where.push('pkg = ?'); params.push(pkg); }
    const sql = `SELECT * FROM update_history
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ${Number(limit) || 50}`;
    return this.db.prepare(sql).all(...params);
  }

  lastRecord({ projectDir, pkg, result } = {}) {
    const where = [];
    const params = [];
    if (projectDir) { where.push('project_dir = ?'); params.push(projectDir); }
    if (pkg) { where.push('pkg = ?'); params.push(pkg); }
    if (result) { where.push('result = ?'); params.push(result); }
    const sql = `SELECT * FROM update_history
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT 1`;
    return this.db.prepare(sql).get(...params) || null;
  }

  close() {
    this.db.close();
  }
}
