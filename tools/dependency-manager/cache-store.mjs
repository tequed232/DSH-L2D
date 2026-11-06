// cache-store.mjs — dependency-cache.sqlite：check 扫描结果缓存（只读扫描落缓存，不消耗重复 npm view）
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openCacheDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      pkg TEXT NOT NULL,
      spec TEXT,
      dep_type TEXT,
      installed TEXT,
      latest TEXT,
      level TEXT,
      prerelease INTEGER,
      error TEXT,
      UNIQUE(project_dir, pkg)
    );
  `);
  return db;
}

export class CacheStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = openCacheDb(dbPath);
  }

  /** 写入/覆盖一次扫描结果（upsert by project+pkg） */
  saveScan(projectDir, rows) {
    const ts = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO scan_cache (ts, project_dir, pkg, spec, dep_type, installed, latest, level, prerelease, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_dir, pkg) DO UPDATE SET
        ts=excluded.ts, spec=excluded.spec, dep_type=excluded.dep_type, installed=excluded.installed,
        latest=excluded.latest, level=excluded.level, prerelease=excluded.prerelease, error=excluded.error
    `);
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      for (const r of rows) {
        upsert.run(ts, projectDir, r.pkg, r.spec, r.type, r.installed, r.latest, r.level,
          r.prerelease ? 1 : 0, r.error ?? null);
      }
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  latestScan(projectDir) {
    return this.db
      .prepare(`SELECT * FROM scan_cache WHERE project_dir = ? ORDER BY pkg`)
      .all(projectDir);
  }

  close() {
    this.db.close();
  }
}
