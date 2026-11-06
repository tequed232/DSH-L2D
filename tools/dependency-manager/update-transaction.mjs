// update-transaction.mjs — 事务式更新：备份 → 安装指定版本 → 验证 → 提交 / 回滚
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { npmInstall, installedVersion } from './npm-registry.mjs';
import { createBackup, makeBackupDirName, restoreBackup } from './rollback-manager.mjs';

/**
 * 执行一次包更新事务。
 * @param {object} p
 * @param {string} p.projectDir   目标项目目录（含 package.json）
 * @param {string} p.pkg          包名
 * @param {string} p.version      目标精确版本（semver）
 * @param {string} p.backupsRoot  备份根目录（data/dependency-manager/backups）
 * @param {object} p.audit        AuditLog 实例
 * @param {object} [p.oldVersion] 已安装旧版本（缺省时现场探测）
 * @param {string|Function} [p.verify]  验证手段：命令字符串（在 projectDir 内 shell 执行）或 async () => {ok, reason}
 * @returns {object} { ok, pkg, oldVersion, newVersion, backupDir, durationMs, verify }
 *   失败时返回 { ok:false, stage, reason, rolledBack:true }（已尽力还原）。
 */
export async function runUpdateTransaction({
  projectDir, pkg, version, backupsRoot, audit, oldVersion: knownOld, verify,
}) {
  const started = Date.now();
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`update requires an exact semver version, got: ${version}`);
  }
  const command = `npm install ${pkg}@${version} --no-audit --no-fund`;
  const oldVersion = knownOld ?? (await installedVersion(projectDir, pkg));

  // 1) 备份（package.json + 各类 lockfile，存在者全备）
  const backupDir = makeBackupDirName(backupsRoot, pkg);
  const backup = await createBackup(projectDir, backupDir);

  let stage = 'install';
  try {
    // 2) 安装指定精确版本（--save-exact：package.json 记录精确版本，禁 ^ 浮动）
    await npmInstall(['--save-exact', `${pkg}@${version}`], { cwd: projectDir });

    // 3) 验证
    stage = 'verify';
    const verdict = await runVerify(verify, { projectDir, pkg, version });
    if (!verdict.ok) {
      throw new Error(`verification failed: ${verdict.reason || 'no reason given'}`);
    }

    // 4) 提交：留审计
    const durationMs = Date.now() - started;
    audit.record({
      projectDir, pkg, oldVersion, newVersion: version, level: null,
      command, result: 'success', durationMs, backupDir,
    });
    return { ok: true, pkg, oldVersion, newVersion: version, backupDir, durationMs, backupManifest: backup.manifest };
  } catch (err) {
    // 5) 回滚：字节级还原备份，并同步 node_modules
    let rolledBack = false;
    let rollbackError = null;
    try {
      await restoreBackup(backupDir, projectDir);
      await npmInstall([], { cwd: projectDir }); // 按 lockfile 重新对齐 node_modules
      rolledBack = true;
    } catch (rbErr) {
      rollbackError = rbErr.message;
    }
    const durationMs = Date.now() - started;
    audit.record({
      projectDir, pkg, oldVersion, newVersion: version, level: null,
      command, result: rolledBack ? 'rolled_back' : 'rollback_failed',
      durationMs, backupDir, detail: { stage, reason: err.message, rollbackError },
    });
    return {
      ok: false, stage, reason: err.message, rolledBack, rollbackError,
      backupDir, durationMs,
    };
  }
}

/** 默认验证：npm ls <pkg> 已且为指定版本（由 npmInstall 语义保证，这里核对 package.json 记录） */
function defaultVerify({ projectDir, pkg, version }) {
  const raw = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  const spec = (raw.dependencies || {})[pkg] ?? (raw.devDependencies || {})[pkg];
  if (spec === undefined) return { ok: false, reason: `${pkg} not present in package.json after install` };
  const declared = String(spec).replace(/^(=|v)/, '');
  if (declared !== version) {
    return { ok: false, reason: `package.json records ${spec}, expected exact ${version}` };
  }
  return { ok: true };
}

async function runVerify(verify, ctx) {
  if (typeof verify === 'function') return verify(ctx);
  if (typeof verify === 'string') {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      await promisify(exec)(verify, { cwd: ctx.projectDir, timeout: 300_000, windowsHide: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `command failed (${err.code ?? 'nonzero'}): ${(err.message || '').slice(0, 300)}` };
    }
  }
  return defaultVerify(ctx);
}
