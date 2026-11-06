// helpers.mjs — 测试夹具：临时目录项目 + npm 安装
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function makeFixtureProject({ deps = {}, devDeps = {}, scripts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dep-fixture-'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dep-fixture',
    version: '0.0.0',
    private: true,
    dependencies: deps,
    devDependencies: devDeps,
    scripts,
  }, null, 2)}\n`);
  return dir;
}

export function npmInstallIn(dir, args = []) {
  execFileSync(NPM, ['install', '--no-audit', '--no-fund', ...args], {
    cwd: dir,
    timeout: 300_000,
    windowsHide: true,
    stdio: 'pipe',
    shell: process.platform === 'win32', // Windows 上 .cmd 必须经 shell 启动（Node EINVAL）
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readText(path) {
  return readFileSync(path, 'utf8');
}

export function fileExists(path) {
  return existsSync(path);
}
