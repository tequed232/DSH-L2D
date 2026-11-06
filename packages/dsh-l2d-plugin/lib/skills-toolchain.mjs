/**
 * dsh-l2d · Skills 工具链自检（首次打开即检查，异常写 log）
 *
 * 用户要求：每次宿主「首次打开」（插件 apply() 被调用）时检查 skills 工具链的
 * 打开/可用状态；如有异常，追加写入 `$DSH_HOME/l2d-skills-check.log`。
 *
 * 检查范围：
 * - 仓库 `skills/`（开发检出）与 `$DSH_HOME/l2d-skills/`（部署侧兜底）下的每个 skill 目录；
 * - SKILL.md 存在 / 可读 / frontmatter 完整（name 与目录一致、description 非空）；
 * - SKILL.md 中引用的 references/*、assets/* 文件真实存在；
 * - 无零字节文件；
 * - 仓库副本与用户级已安装副本（~/.workbuddy/skills/<name>）哈希比对（漂移/未安装）。
 *
 * 约定：
 * - 纯文件系统检查，不依赖 DSH 服务；自检自身 fail-open，任何失败绝不影响宿主启动。
 * - 只有发现异常才写 log（一行 JSONL，含完整异常清单）；全部正常时不落盘。
 * - log 超过上限时保留较新一半，防止无限增长。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SKILLS_CHECK_LOG_FILE_NAME = 'l2d-skills-check.log';
export const SKILLS_CHECK_LOG_MAX_BYTES = 256 * 1024;
const SKILL_MD = 'SKILL.md';
// SKILL.md 中允许引用的本地资源前缀（存在性必须校验）。
const REFERENCE_RE = /(?:references|assets)\/[A-Za-z0-9][A-Za-z0-9._\-/]*/g;
const WALK_MAX_DEPTH = 6;

/** log 文件落点：$DSH_HOME/l2d-skills-check.log（与其他 l2d-* 状态文件同层）。 */
export function skillsCheckLogPath(homeDir) {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, SKILLS_CHECK_LOG_FILE_NAME);
}

/**
 * 解析 SKILL.md 顶部 YAML frontmatter（仅取顶层 key: value，够用即止）。
 * @returns {{ ok: boolean, data: Record<string, string>, error: string|null }}
 */
export function parseSkillFrontmatter(md) {
  if (typeof md !== 'string') return { ok: false, data: {}, error: 'not-a-string' };
  const text = md.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { ok: false, data: {}, error: 'no-frontmatter' };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { ok: false, data: {}, error: 'unclosed-frontmatter' };
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { ok: true, data, error: null };
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列出目录下全部文件（相对路径），带深度上限防失控。 */
function listFilesRel(dir, base = dir, depth = 0, out = []) {
  if (depth > WALK_MAX_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isDirectory()) listFilesRel(abs, base, depth + 1, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 检查单个 skill 目录的结构与完整性。
 * @returns {{ name: string, dir: string, ok: boolean, anomalies: Array<{code: string, detail?: string}> }}
 */
export function checkSkillDir(dir) {
  const name = path.basename(dir);
  const anomalies = [];
  const mdFile = path.join(dir, SKILL_MD);

  let md;
  try {
    md = fs.readFileSync(mdFile, 'utf8');
  } catch (err) {
    anomalies.push({ code: 'missing-skill-md', detail: err && err.code === 'ENOENT' ? 'SKILL.md 不存在' : 'SKILL.md 不可读' });
    return { name, dir, ok: false, anomalies };
  }

  const fm = parseSkillFrontmatter(md);
  if (!fm.ok) {
    anomalies.push({ code: 'bad-frontmatter', detail: fm.error });
  } else {
    if (!fm.data.name) anomalies.push({ code: 'missing-name' });
    else if (fm.data.name !== name) anomalies.push({ code: 'name-mismatch', detail: `${fm.data.name} != 目录名 ${name}` });
    if (!fm.data.description || !fm.data.description.trim()) anomalies.push({ code: 'missing-description' });
  }

  // 引用的 references/*、assets/* 必须真实存在。
  const refs = [...new Set((md.match(REFERENCE_RE) || []))];
  for (const ref of refs) {
    if (!fs.existsSync(path.join(dir, ref))) {
      anomalies.push({ code: 'missing-file', detail: ref });
    }
  }

  // 零字节文件视为异常（空壳/损坏）。
  for (const rel of listFilesRel(dir)) {
    try {
      if (fs.statSync(path.join(dir, rel)).size === 0) {
        anomalies.push({ code: 'empty-file', detail: rel });
      }
    } catch {
      /* 读取失败不追加（readFileSync 已覆盖主路径） */
    }
  }

  return { name, dir, ok: anomalies.length === 0, anomalies };
}

/**
 * 解析参与自检的根目录：
 * - repoDir：仓库 `skills/`（按模块位置推导，可被 options.repoSkillsDir 覆盖）；
 * - homeDir：`$DSH_HOME/l2d-skills/`（部署侧兜底，可被 options.homeSkillsDir 覆盖）；
 * - userDir：用户级已安装 skill 根 `~/.workbuddy/skills/`（仅用于安装/漂移比对）。
 */
export function resolveSkillRoots(options = {}) {
  let repoDir = options.repoSkillsDir || null;
  if (!repoDir) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      repoDir = path.resolve(here, '..', '..', '..', 'skills');
    } catch {
      repoDir = null;
    }
  }
  const home = options.homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const homeDir = options.homeSkillsDir || path.join(home, 'l2d-skills');
  const userDir = options.userSkillsDir || path.join(os.homedir(), '.workbuddy', 'skills');
  return { repoDir, homeDir, userDir };
}

function listSkillDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return null; // 根目录不可用
  }
}

/**
 * 执行一次 skills 工具链自检（纯函数式，不写 log）。
 * @returns {{ checkedAt: string, ok: boolean, roots: object, skills: Array, anomalies: Array }}
 */
export function runSkillsToolchainCheck(options = {}) {
  const roots = resolveSkillRoots(options);
  const anomalies = [];
  const skills = [];
  const checkedAt = new Date().toISOString();

  const repoDirs = listSkillDirs(roots.repoDir);
  const homeDirs = listSkillDirs(roots.homeDir);

  // 两个主根都不可用 = 工具链整体缺失。
  if (repoDirs === null && homeDirs === null) {
    anomalies.push({ code: 'skills-dir-missing', detail: `仓库与部署侧均无 skills 目录：${roots.repoDir} / ${roots.homeDir}` });
  }

  // 收集待检 skill 目录（同名时仓库侧优先）。
  const seen = new Set();
  const ordered = [];
  if (Array.isArray(repoDirs)) for (const dir of repoDirs) { const n = path.basename(dir); if (!seen.has(n)) { seen.add(n); ordered.push({ dir, source: 'repo' }); } }
  if (Array.isArray(homeDirs)) for (const dir of homeDirs) { const n = path.basename(dir); if (!seen.has(n)) { seen.add(n); ordered.push({ dir, source: 'home' }); } }

  const userRootAvailable = roots.userDir ? fs.existsSync(roots.userDir) : false;
  for (const { dir, source } of ordered) {
    const check = checkSkillDir(dir);
    check.source = source;
    skills.push(check);
    for (const a of check.anomalies) anomalies.push({ code: a.code, skill: check.name, detail: a.detail });

    // 安装/漂移比对只针对仓库侧 skill。
    if (source !== 'repo') continue;
    if (!userRootAvailable) continue; // 用户级根不可用（非 WorkBuddy 环境）不算异常，只记录。
    const installedDir = path.join(roots.userDir, check.name);
    if (!fs.existsSync(path.join(installedDir, SKILL_MD))) {
      anomalies.push({ code: 'not-installed', skill: check.name, detail: installedDir });
      continue;
    }
    const repoFiles = new Map(listFilesRel(dir).map((rel) => [rel, sha256File(path.join(dir, rel))]));
    const instFiles = new Map(listFilesRel(installedDir).map((rel) => [rel, sha256File(path.join(installedDir, rel))]));
    const drift = [];
    for (const [rel, hash] of repoFiles) if (instFiles.get(rel) !== hash) drift.push(rel);
    for (const rel of instFiles.keys()) if (!repoFiles.has(rel)) drift.push('+' + rel);
    if (drift.length) anomalies.push({ code: 'drift', skill: check.name, detail: drift.slice(0, 8).join(', ') });
  }

  return {
    checkedAt,
    ok: anomalies.length === 0,
    roots: { repoDir: roots.repoDir, homeDir: roots.homeDir, userDir: roots.userDir, userRootAvailable },
    skills,
    anomalies,
  };
}

/**
 * 有异常时把结果追加为一行 JSONL；超出上限时保留较新一半。
 * @returns {{ logged: boolean, file: string, error?: string }}
 */
export function appendSkillsCheckLog(result, options = {}) {
  const file = skillsCheckLogPath(options.homeDir);
  if (!result || !Array.isArray(result.anomalies) || result.anomalies.length === 0) {
    return { logged: false, file };
  }
  const line = JSON.stringify({
    time: result.checkedAt,
    level: 'anomaly',
    ok: false,
    anomalies: result.anomalies,
    skills: (result.skills || []).map((s) => ({ name: s.name, source: s.source, ok: s.ok })),
  }) + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > (options.maxBytes || SKILLS_CHECK_LOG_MAX_BYTES)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const keep = lines.slice(Math.floor(lines.length / 2));
        fs.writeFileSync(file, keep.join('\n') + (keep.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      /* 截断失败不影响追加 */
    }
    fs.appendFileSync(file, line, { encoding: 'utf8' });
    return { logged: true, file };
  } catch (err) {
    return { logged: false, file, error: String(err && err.message ? err.message : err) };
  }
}

let startupCheckDone = false;

/**
 * 首次打开自检入口（进程级只跑一次，除非 force）。任何失败都 fail-open。
 * @returns {{ result: object, logged: object }|null}
 */
export function maybeRunStartupSkillsCheck(options = {}) {
  if (startupCheckDone && !options.force) return null;
  startupCheckDone = true;
  try {
    const result = runSkillsToolchainCheck(options);
    const logged = appendSkillsCheckLog(result, options);
    if (!result.ok && logged && logged.error) {
      console.warn('[dsh-l2d] skills 自检异常 log 写入失败: ' + logged.error);
    }
    return { result, logged };
  } catch (err) {
    try {
      console.warn('[dsh-l2d] skills 工具链自检失败（不影响启动）: ' + String(err && err.message ? err.message : err));
    } catch {
      /* ignore */
    }
    return null;
  }
}
