// npm-registry.mjs — npm CLI 封装（execFile，零第三方依赖）
// 所有子进程调用均带超时与 UTF-8 输出；Windows 下用 npm.cmd。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffLevel } from './version-resolver.mjs';

const execFileP = promisify(execFile);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DEFAULT_TIMEOUT_MS = 60_000;

/** 运行 npm 子命令。返回 stdout 字符串；失败抛错（含 stderr 摘要）。 */
export async function runNpm(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileP(NPM, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      // Windows 上 npm.cmd 必须经 shell 启动（spawn EINVAL）；args 全部为受控枚举值
      shell: process.platform === 'win32',
    });
    return stdout;
  } catch (err) {
    const stderr = (err.stderr || err.message || '').toString().slice(0, 400);
    const e = new Error(`npm ${args.join(' ')} failed: ${stderr}`);
    e.cause = err;
    throw e;
  }
}

/** npm view <pkg>@latest version → 最新稳定版（prerelease dist-tag 除外，@latest 语义由 registry 保证） */
export async function latestVersion(pkg, opts = {}) {
  const out = (await runNpm(['view', `${pkg}@latest`, 'version'], opts)).trim();
  const v = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(out);
  if (!v) throw new Error(`npm view ${pkg} version: unexpected output ${JSON.stringify(out.slice(0, 100))}`);
  return v[1];
}

/** npm view <pkg>@<version> <fields...> --json */
export async function viewPackage(pkg, version, fields = [], opts = {}) {
  const args = ['view', version ? `${pkg}@${version}` : pkg, ...fields, '--json'];
  const out = await runNpm(args, opts);
  if (!out.trim()) return {};
  return JSON.parse(out);
}

/** npm ls <pkg> --depth=0 --json：返回已安装版本字符串；未安装返回 null */
export async function installedVersion(projectDir, pkg, opts = {}) {
  let out;
  try {
    out = await runNpm(['ls', pkg, '--depth=0', '--json'], { cwd: projectDir, ...opts });
  } catch (err) {
    // npm ls 对缺失/不匹配依赖以非零退出并输出 JSON——有 JSON 就解析
    out = err.cause && err.cause.stdout ? err.cause.stdout : '';
    if (!out) return null;
  }
  try {
    const data = JSON.parse(out);
    const dep = data.dependencies && data.dependencies[pkg];
    if (!dep) return null;
    return dep.version || null;
  } catch {
    return null;
  }
}

/** npm install <args...>（用于事务安装，--no-audit --no-fund 控制噪声） */
export async function npmInstall(args, { cwd, timeoutMs = 300_000 } = {}) {
  return runNpm(['install', '--no-audit', '--no-fund', ...args], { cwd, timeoutMs });
}

/** 读取项目 package.json 的 dependencies + devDependencies */
export async function readProjectDeps(projectDir) {
  const raw = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  return {
    dependencies: raw.dependencies || {},
    devDependencies: raw.devDependencies || {},
    engines: raw.engines || {},
    raw,
  };
}

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
};

/**
 * 逐包扫描（只读）：对 projectDir 的每个依赖查 registry 最新稳定版并分级。
 * 返回 [{pkg, spec, type, installed, latest, level, prerelease, error?}]
 * installed 实际版本优先取 node_modules（npm ls），不可得时退回 spec 提示。
 */
export async function scanProject(projectDir, { concurrency = 4, timeoutMs } = {}) {
  const { dependencies, devDependencies } = await readProjectDeps(projectDir);
  const specs = [
    ...Object.entries(dependencies).map(([pkg, spec]) => ({ pkg, spec, type: 'dependency' })),
    ...Object.entries(devDependencies).map(([pkg, spec]) => ({ pkg, spec, type: 'devDependency' })),
  ];
  const opts = { timeoutMs };
  return mapLimit(specs, concurrency, async ({ pkg, spec, type }) => {
    const base = { pkg, spec, type, installed: null, latest: null, level: 'unknown', prerelease: false };
    try {
      const [latest, installed] = await Promise.all([
        latestVersion(pkg, opts),
        installedVersion(projectDir, pkg, opts),
      ]);
      base.latest = latest;
      base.installed = installed;
      if (installed) {
        const { level, prerelease } = diffLevel(installed, latest);
        base.level = level;
        base.prerelease = prerelease;
      } else {
        base.level = 'not-installed';
      }
    } catch (err) {
      base.error = err.message;
    }
    return base;
  });
}
