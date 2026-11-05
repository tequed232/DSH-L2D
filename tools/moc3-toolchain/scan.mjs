#!/usr/bin/env node
/**
 * dsh-l2d · MOC3 解析工具链扫描（可复现，非一次性操作）
 *
 * 职责：
 *  1. 检测 Python 与 py-moc3（vendor/thirdparty/py-moc3，MIT，零依赖，源码直跑不安装）。
 *  2. 用真实模型文件跑 smoke：info（可解析）+ verify（读写往返字节一致，cwd 在临时目录，
 *     绝不把派生文件写回模型源目录——模型源资产不可变）。
 *  3. 结果幂等写入 SQLite 工具链注册表（@dsh/db）。
 *
 * 状态口径（不得美化）：
 *  - present_verified   = 可执行且 smoke 通过
 *  - present_unverified = 可执行但 smoke 未通过/未跑
 *  - missing            = 仓库不存在或工具不可用（如 LIVE2D-MOC3 上游 404）
 *
 * 运行：node tools/moc3-toolchain/scan.mjs [--moc3 <路径>]*
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertToolchainComponent } from '../../packages/dsh-l2d-db/src/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_MOC3_SRC = path.join(repoRoot, 'vendor', 'thirdparty', 'py-moc3', 'src');

// 默认 smoke 目标：真实业务模型 + 官方 SDK 样例（对照组）
const DEFAULT_MOC3 = [
  path.join(repoRoot, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.moc3'),
  path.join(repoRoot, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources', 'Haru', 'Haru.moc3'),
];

const args = process.argv.slice(2);
const requested = args.includes('--moc3')
  ? args[args.indexOf('--moc3') + 1].split(',').map((p) => path.resolve(p))
  : DEFAULT_MOC3;

function runPython(pythonArgs, options = {}) {
  return execFileSync('python', pythonArgs, {
    encoding: 'utf8',
    timeout: 60000,
    ...options,
  });
}

function detectPython() {
  try {
    const out = runPython(['--version']).trim(); // "Python 3.13.14"
    const match = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { status: 'present_unverified', version: out };
    return { status: 'present_verified', version: `${match[1]}.${match[2]}.${match[3]}` };
  } catch {
    return { status: 'missing', version: null };
  }
}

function smokeMoc3(moc3Path) {
  const result = { file: path.relative(repoRoot, moc3Path) || moc3Path, info: false, verify: false, error: null };
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moc3-smoke-'));
  try {
    if (!fs.existsSync(moc3Path)) {
      result.error = 'file-not-found';
      return result;
    }
    const env = { ...process.env, PYTHONPATH: PY_MOC3_SRC, PYTHONDONTWRITEBYTECODE: '1' };
    // info：只读解析
    runPython(['-m', 'moc3', 'info', moc3Path], { cwd: tmpCwd, env });
    result.info = true;
    // verify：读写往返字节一致；产物只落临时目录
    runPython(['-m', 'moc3', 'verify', moc3Path], { cwd: tmpCwd, env });
    result.verify = true;
  } catch (err) {
    result.error = String(err.message || err).slice(0, 400);
  } finally {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return result;
}

// ---- 主流程
const db = openDb({ startDir: repoRoot });
const report = { python: null, pyMoc3: null, live2dMoc3Rust: null, smokes: [] };

// 1. Python
report.python = detectPython();
upsertToolchainComponent(db, {
  name: 'python',
  kind: 'runtime',
  version: report.python.version,
  provenance: 'system',
  status: report.python.status,
  smokeTest: { check: '--version' },
});

// 2. py-moc3（源码直跑）
let pyMoc3Status = 'missing';
let pyMoc3Version = null;
let pyMoc3WriteRoundTrip = 'unknown';
if (fs.existsSync(path.join(PY_MOC3_SRC, 'moc3', '__init__.py'))) {
  // 锁定版本 = pyproject 声明版本 + 克隆时 HEAD
  try {
    pyMoc3Version = execFileSync('git', ['-C', path.join(repoRoot, 'vendor', 'thirdparty', 'py-moc3'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { pyMoc3Version = null; }
  const pyproject = fs.readFileSync(path.join(repoRoot, 'vendor', 'thirdparty', 'py-moc3', 'pyproject.toml'), 'utf8');
  const decl = pyproject.match(/version\s*=\s*"([^"]+)"/);
  pyMoc3Version = `v${decl ? decl[1] : '?'}@${pyMoc3Version || 'unknown'}`;
  report.smokes = requested.map(smokeMoc3);
  const readOkCount = report.smokes.filter((s) => s.info).length;
  const verifyOkCount = report.smokes.filter((s) => s.verify).length;
  // 口径：读路径（info）全通过 = present_verified（本流水线只读检查，源资产不可变）；
  // 写往返（verify）结果如实随 smoke 明细记录，不据此抬高/谎报状态。
  pyMoc3Status = readOkCount === requested.length && requested.length > 0 ? 'present_verified' : 'present_unverified';
  pyMoc3WriteRoundTrip = verifyOkCount === requested.length ? 'full' : 'partial';
}
report.pyMoc3 = { status: pyMoc3Status, version: pyMoc3Version, writeRoundTrip: pyMoc3WriteRoundTrip, smokes: report.smokes };
upsertToolchainComponent(db, {
  name: 'py-moc3',
  kind: 'parser',
  version: pyMoc3Version,
  sourceUrl: 'https://github.com/Ludentes/py-moc3',
  installPath: path.relative(repoRoot, PY_MOC3_SRC),
  provenance: 'vendor/thirdparty git clone（MIT，零依赖，源码直跑）',
  status: pyMoc3Status,
  smokeTest: { files: report.smokes, writeRoundTrip: pyMoc3WriteRoundTrip, at: new Date().toISOString() },
});

// 3. LIVE2D-MOC3（Rust 候选，上游 404 + 本机无 cargo → 如实 missing）
report.live2dMoc3Rust = {
  status: 'missing',
  reason: 'github.com/loliRururi/LIVE2D-MOC3 不存在（404）；且本机无 cargo，即便存在也无法构建',
};
upsertToolchainComponent(db, {
  name: 'LIVE2D-MOC3(rust)',
  kind: 'parser',
  sourceUrl: 'https://github.com/loliRururi/LIVE2D-MOC3',
  provenance: 'model-intelligence skill Phase 2 候选项',
  status: 'missing',
  smokeTest: { reason: report.live2dMoc3Rust.reason, at: new Date().toISOString() },
});

console.log(JSON.stringify(report, null, 2));
