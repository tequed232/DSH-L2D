// rollback-manager.mjs — 备份创建 / 校验 / 还原（文件字节级还原 + manifest 留痕）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 参与备份/还原的文件（存在者备份） */
export const TRANSACTION_FILES = ['package.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'package-lock.json'];

const sanitize = (s) => String(s).replace(/[^0-9A-Za-z._-]+/g, '_').slice(0, 80);

/** 备份 projectDir 下的锁文件/清单到 backupDir，写 manifest.json（含 sha256 以供校验） */
export async function createBackup(projectDir, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const files = [];
  for (const name of TRANSACTION_FILES) {
    const src = join(projectDir, name);
    if (!existsSync(src)) continue;
    const content = readFileSync(src);
    const dst = join(backupDir, name);
    cpSync(src, dst);
    files.push({ name, sha256: await sha256(content), size: content.length });
  }
  if (files.length === 0) {
    throw new Error(`no files to back up in ${projectDir}`);
  }
  const manifest = { projectDir, createdAt: new Date().toISOString(), files };
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { backupDir, manifest };
}

/** 还原 backupDir 的内容到 projectDir（字节级覆盖），返回还原文件名列表 */
export async function restoreBackup(backupDir, projectDir) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  const restored = [];
  for (const f of manifest.files) {
    const src = join(backupDir, f.name);
    if (!existsSync(src)) throw new Error(`backup missing file: ${f.name}`);
    const content = readFileSync(src);
    const digest = await sha256(content);
    if (digest !== f.sha256) throw new Error(`backup integrity check failed for ${f.name}`);
    writeFileSync(join(projectDir, f.name), content);
    restored.push(f.name);
  }
  return { restored, manifest };
}

/** 校验备份目录完整性（不执行还原） */
export async function verifyBackup(backupDir) {
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: 'manifest.json missing' };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of manifest.files) {
    const p = join(backupDir, f.name);
    if (!existsSync(p)) return { ok: false, reason: `${f.name} missing` };
    const digest = await sha256(readFileSync(p));
    if (digest !== f.sha256) return { ok: false, reason: `${f.name} hash mismatch` };
  }
  return { ok: true, manifest };
}

/** 列出 data/backups 下的备份目录（新→旧） */
export function listBackups(backupsRoot) {
  if (!existsSync(backupsRoot)) return [];
  return readdirSync(backupsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(backupsRoot, d.name))
    .sort()
    .reverse();
}

export function removeBackup(backupDir) {
  rmSync(backupDir, { recursive: true, force: true });
}

export function makeBackupDirName(backupsRoot, pkg) {
  return join(backupsRoot, `${Date.now()}-${sanitize(pkg)}`);
}

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
