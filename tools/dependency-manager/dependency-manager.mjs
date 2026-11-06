// dependency-manager.mjs — 编排：check / update / rollback / audit + 配置门禁 + 同包进程内互斥
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanProject, installedVersion, latestVersion } from './npm-registry.mjs';
import { checkCompatibility, runAudit } from './compat-check.mjs';
import { runUpdateTransaction } from './update-transaction.mjs';
import { restoreBackup, verifyBackup } from './rollback-manager.mjs';
import { AuditLog } from './audit-log.mjs';
import { CacheStore } from './cache-store.mjs';
import { diffLevel } from './version-resolver.mjs';

export const DEFAULT_CONFIG = {
  updatePolicy: {
    autoCheck: true,
    autoInstall: false,      // 默认禁自动安装
    requireApproval: true,   // 默认要求显式批准（检查与安装分离授权）
  },
};

/**
 * 同一包的更新互斥：进程内 Map<pkg, true>。
 * Phase 1 单进程互斥即可（见裁决书 §4）；跨进程互斥留 Phase 2（SQLite 锁行）。
 */
export const updateLocks = new Map();

export class DependencyManager {
  /**
   * @param {object} opts
   * @param {string} opts.projectDir  目标项目目录
   * @param {string} opts.dataDir     data/dependency-manager
   * @param {object} [opts.config]    覆盖配置（测试用）；缺省读 config.json，无则写默认
   */
  constructor({ projectDir, dataDir, config }) {
    this.projectDir = resolve(projectDir);
    this.dataDir = resolve(dataDir);
    this.config = config ?? loadConfig(this.dataDir);
    this.audit = new AuditLog(join(this.dataDir, 'update-history.sqlite'));
    this.cache = new CacheStore(join(this.dataDir, 'dependency-cache.sqlite'));
    this.backupsRoot = join(this.dataDir, 'backups');
  }

  /** 配置门禁：autoInstall 且 !requireApproval，或显式批准 */
  static isAuthorized(config, { approved = false } = {}) {
    const p = config.updatePolicy || {};
    return approved === true || (p.autoInstall === true && p.requireApproval === false);
  }

  /**
   * 只读检查：全量扫描（或单包），结果落 dependency-cache.sqlite。不安装、不改文件。
   */
  async check(pkg) {
    if (pkg) return this.checkOne(pkg);
    const rows = await scanProject(this.projectDir, {});
    this.cache.saveScan(this.projectDir, rows);
    return rows;
  }

  async checkOne(pkg) {
    const installed = await installedVersion(this.projectDir, pkg);
    const latest = await latestVersion(pkg);
    const spec = (await readDepsSpec(this.projectDir, pkg)) ?? null;
    let level = 'not-installed';
    let prerelease = false;
    if (installed) ({ level, prerelease } = diffLevel(installed, latest));
    const row = { pkg, spec, type: 'dependency', installed, latest, level, prerelease };
    this.cache.saveScan(this.projectDir, [row]);
    return row;
  }

  /**
   * 事务式更新 pkg → version（精确版本）。
   * 未授权（配置默认 + 未显式批准）时直接拒绝执行，不碰任何文件。
   * @param {object} opts
   * @param {boolean} [opts.approved]  用户显式批准（CLI --approve）
   * @param {boolean} [opts.skipCompatCheck] 仅测试用
   * @param {string|Function} [opts.verify] 验证命令/函数
   */
  async update(pkg, version, opts = {}) {
    if (updateLocks.has(pkg)) {
      const err = new Error(`package "${pkg}" update already in progress; concurrent request rejected (mutex)`);
      err.code = 'DEPS_MUTEX';
      throw err;
    }
    if (!DependencyManager.isAuthorized(this.config, { approved: opts.approved })) {
      const err = new Error(
        'update rejected: installation is not authorized. '
        + 'Default policy is autoInstall=false / requireApproval=true (check and install are separately authorized). '
        + 'Re-run with --approve, or change data/dependency-manager/config.json updatePolicy.',
      );
      err.code = 'DEPS_UNAUTHORIZED';
      throw err;
    }

    updateLocks.set(pkg, true);
    try {
      // 1) 兼容性 & 安全检查（audit before update）
      if (!opts.skipCompatCheck) {
        const compat = await checkCompatibility(pkg, version, { projectDir: this.projectDir });
        if (!compat.ok) {
          const err = new Error(`compatibility check failed: ${JSON.stringify(compat)}`);
          err.code = 'DEPS_COMPAT';
          err.compat = compat;
          throw err;
        }
      }
      // 2) 事务：备份 → 安装 → 验证 → 提交/回滚（审计在事务内部落库）
      return await runUpdateTransaction({
        projectDir: this.projectDir,
        pkg,
        version,
        backupsRoot: this.backupsRoot,
        audit: this.audit,
        verify: opts.verify,
      });
    } finally {
      updateLocks.delete(pkg);
    }
  }

  /** 回滚：默认回滚该项目最近一次成功更新；指定 pkg 时回滚该包最近一次 */
  async rollback(pkg, { approved = false } = {}) {
    if (!DependencyManager.isAuthorized(this.config, { approved })) {
      const err = new Error('rollback rejected: not authorized (same gate as update). Use --approve.');
      err.code = 'DEPS_UNAUTHORIZED';
      throw err;
    }
    const rec = this.audit.lastRecord({ projectDir: this.projectDir, pkg, result: 'success' });
    if (!rec) throw new Error(`no successful update record found to roll back${pkg ? ` for ${pkg}` : ''}`);
    const check = await verifyBackup(rec.backup_dir);
    if (!check.ok) throw new Error(`backup unusable: ${check.reason}`);
    const { restored } = await restoreBackup(rec.backup_dir, this.projectDir);
    const { npmInstall } = await import('./npm-registry.mjs');
    await npmInstall([], { cwd: this.projectDir }); // 按 lockfile 重新对齐 node_modules
    this.audit.record({
      projectDir: this.projectDir, pkg: rec.pkg,
      oldVersion: rec.new_version, newVersion: rec.old_version, level: null,
      command: `rollback ${rec.pkg} ${rec.new_version} -> ${rec.old_version}`,
      result: 'success', durationMs: null, backupDir: rec.backup_dir,
      detail: { rollbackOf: rec.id, restored },
    });
    return { ok: true, pkg: rec.pkg, restoredFrom: rec.new_version, restoredTo: rec.old_version, restored };
  }

  /** 只读 audit：npm audit 结果（best-effort） */
  async securityAudit() {
    return runAudit(this.projectDir);
  }

  listAudit(filter) {
    return this.audit.list({ projectDir: this.projectDir, ...filter });
  }

  close() {
    this.audit.close();
    this.cache.close();
  }
}

export function loadConfig(dataDir) {
  const cfgPath = join(dataDir, 'config.json');
  if (!existsSync(cfgPath)) {
    // 首次使用：落默认配置（保守门禁）
    writeConfig(dataDir, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  return { ...structuredClone(DEFAULT_CONFIG), ...raw, updatePolicy: { ...DEFAULT_CONFIG.updatePolicy, ...(raw.updatePolicy || {}) } };
}

export function writeConfig(dataDir, config) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function readDepsSpec(projectDir, pkg) {
  const raw = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  return (raw.dependencies || {})[pkg] ?? (raw.devDependencies || {})[pkg] ?? null;
}
