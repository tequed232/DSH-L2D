#!/usr/bin/env node
/**
 * 清理「老版本 dsh-l2d 插件构建」——测试前置卫生步骤。
 *
 * 背景（用户 2026-11-13 要求）：E2E / 真机验收时，DSH 侧残留的旧插件构建
 * （已安装目录、.uninstalled-bak、旧 tgz）会与当前仓库代码抢加载，导致
 * 「改了代码但行为没变」的假阴性。测试前必须先把旧构建下线。
 *
 * 设计纪律：
 *  1. **默认 dry-run**：不加 --apply 只列清单，不动任何文件。
 *  2. **可逆**：--apply 是移动到 <plugins>/.trash-<时间戳>/，不是删除；
 *     需要真正抹掉时显式 --purge（仍只删 .trash-* 里的内容）。
 *  3. **白名单根目录**：只允许操作 <DSH_HOME>/plugins 与 <repo>/dist；
 *     解析后的真实路径不在白名单内一律拒绝（防符号链接逃逸）。
 *  4. **不碰状态**：*.sqlite / l2d-nodegraphs / l2d-*.json / 日志 / 设置一概不动，
 *     删掉它们等于丢用户数据与工作区绑定。
 *
 * 用法：
 *   node tools/dev/clean-plugin-build.mjs                 # 只列出
 *   node tools/dev/clean-plugin-build.mjs --apply         # 移到 .trash-<ts>/
 *   node tools/dev/clean-plugin-build.mjs --apply --purge # 直接删除
 *   node tools/dev/clean-plugin-build.mjs --keep=dsh-l2d  # 保留指定目录名
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PLUGINS_DIR = path.join(DSH_HOME, 'plugins');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PURGE = argv.includes('--purge');
const KEEP = new Set(argv.filter((a) => a.startsWith('--keep=')).map((a) => a.split('=')[1]).filter(Boolean));

/** 允许操作的根目录（解析真实路径后比较，防符号链接逃逸）。 */
const ALLOWED_ROOTS = [PLUGINS_DIR, DIST_DIR].map((p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
});

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function isUnder(target, root) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function dirSize(p) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const child = path.join(p, entry.name);
    try {
      total += entry.isDirectory() && !entry.isSymbolicLink() ? dirSize(child) : fs.lstatSync(child).size;
    } catch { /* 读取失败按 0 计，不中断扫描 */ }
  }
  return total;
}

function readVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { name: pkg.name, version: pkg.version };
  } catch { return null; }
}

/** 收集候选：插件目录 + 旧打包产物。 */
function collect() {
  const found = [];
  // A. <DSH_HOME>/plugins 下的 dsh-l2d 相关目录（含 .uninstalled-bak / .disabled 等变体）
  let entries = [];
  try { entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.name.startsWith('dsh-l2d')) continue;
    if (KEEP.has(entry.name)) continue;
    const full = path.join(PLUGINS_DIR, entry.name);
    // 符号链接 = 开发者本地 link，指向真实源码，绝不移动
    if (entry.isSymbolicLink()) {
      found.push({ kind: 'symlink-skip', path: full, note: '符号链接（dev link）→ 跳过' });
      continue;
    }
    const meta = readVersion(full);
    found.push({
      kind: entry.isDirectory() ? 'plugin-dir' : 'plugin-file',
      path: full,
      version: meta ? `${meta.name}@${meta.version}` : '(无 package.json)',
      size: (() => { try { return dirSize(full); } catch { return 0; } })(),
      mtime: (() => { try { return fs.lstatSync(full).mtime.toISOString(); } catch { return ''; } })(),
    });
  }
  // B. <repo>/dist 下的旧打包 tgz / 解包目录
  let distEntries = [];
  try { distEntries = fs.readdirSync(DIST_DIR, { withFileTypes: true }); } catch { distEntries = []; }
  for (const entry of distEntries) {
    const isTgz = /^dsh-l2d-.*\.tgz$/.test(entry.name);
    const isDir = entry.isDirectory() && entry.name.startsWith('dsh-l2d');
    if (!isTgz && !isDir) continue;
    if (KEEP.has(entry.name)) continue;
    const full = path.join(DIST_DIR, entry.name);
    found.push({
      kind: isTgz ? 'dist-tgz' : 'dist-dir',
      path: full,
      version: isDir ? (readVersion(full)?.version || '(未知)') : entry.name,
      size: (() => { try { return dirSize(full); } catch { return 0; } })(),
      mtime: (() => { try { return fs.lstatSync(full).mtime.toISOString(); } catch { return ''; } })(),
    });
  }
  return found;
}

/** 安全校验：真实路径必须在白名单根下，且不是根目录本身。 */
function assertSafe(target) {
  const real = realOrNull(target);
  if (!real) return { ok: false, reason: '路径不可解析（可能已不存在）' };
  if (!ALLOWED_ROOTS.some((root) => isUnder(real, root))) {
    return { ok: false, reason: `越界：${real} 不在 ${ALLOWED_ROOTS.join(' 或 ')} 下` };
  }
  return { ok: true, real };
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const targets = collect();
const movable = targets.filter((t) => t.kind !== 'symlink-skip');
const totalSize = movable.reduce((n, t) => n + (t.size || 0), 0);

console.log(`DSH_HOME: ${DSH_HOME}`);
console.log(`仓库:     ${REPO_ROOT}`);
console.log(`模式:     ${APPLY ? (PURGE ? 'APPLY + PURGE（直接删除，不可恢复）' : 'APPLY（移到回收目录，可恢复）') : 'DRY-RUN（只看不动）'}`);
console.log('');

if (!targets.length) {
  console.log('没有发现需要清理的旧插件构建。');
  process.exit(0);
}

console.log('候选清单：');
for (const t of targets) {
  const size = t.size ? fmtSize(t.size) : '-';
  console.log(`  [${t.kind}] ${t.path}`);
  console.log(`      版本=${t.version}  大小=${size}  修改=${t.mtime || '-'}${t.note ? `  ${t.note}` : ''}`);
}
console.log('');
console.log(`合计可移动 ${movable.length} 项，约 ${fmtSize(totalSize)}。`);
console.log('不会触碰：*.sqlite / l2d-nodegraphs / l2d-*.json / 日志 / 设置（用户数据与工作区绑定）。');

if (!APPLY) {
  console.log('\n这是 DRY-RUN。确认无误后加 --apply 执行（默认移到 .trash-<时间戳>/，可撤回）。');
  process.exit(0);
}

/** 跨盘移动：rename 遇 EXDEV（D: → C:）时退化为「先复制再删除」，保证可逆语义不丢。 */
function moveInto(src, dest) {
  try {
    fs.renameSync(src, dest);
    return { mode: 'rename' };
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
      return { mode: 'copy+unlink' };
    }
    throw err;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const trashDir = path.join(PLUGINS_DIR, `.trash-${stamp}`);
let moved = 0;
let failed = 0;

for (const t of movable) {
  const check = assertSafe(t.path);
  if (!check.ok) {
    console.error(`  ✗ 跳过 ${t.path}：${check.reason}`);
    failed += 1;
    continue;
  }
  try {
    if (PURGE) {
      fs.rmSync(check.real, { recursive: true, force: true });
      console.log(`  ✓ 已删除 ${check.real}`);
    } else {
      fs.mkdirSync(trashDir, { recursive: true });
      // 目标名加来源前缀，避免 plugins 与 dist 下同名条目在回收目录里互相覆盖
      const origin = isUnder(check.real, realOrNull(DIST_DIR) || DIST_DIR) ? 'dist-' : '';
      const dest = path.join(trashDir, `${origin}${path.basename(check.real)}`);
      const how = moveInto(check.real, dest);
      console.log(`  ✓ 已移动 ${check.real} → ${dest}（${how.mode}）`);
    }
    moved += 1;
  } catch (err) {
    console.error(`  ✗ ${t.path}：${err.message}`);
    failed += 1;
  }
}

console.log('');
if (PURGE) {
  console.log(`完成：删除 ${moved} 项，失败 ${failed} 项。`);
} else {
  console.log(`完成：移动 ${moved} 项，失败 ${failed} 项。回收目录：${trashDir}`);
  console.log('如需恢复：把回收目录里的条目移回原位置。如需彻底清除：--purge。');
}
process.exit(failed > 0 ? 1 : 0);
