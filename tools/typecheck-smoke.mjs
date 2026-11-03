#!/usr/bin/env node
/**
 * 窄门禁：typescript 冒烟检查（test:types）。
 *
 * 为什么只做窄门禁：
 *   仓库里预存大量类型错误（历史噪声，修完之前不能当门禁），
 *   但「`Cannot find name` 里除 Live2DCubismCore 之外必须为 0」是能显式失败、
 *   且对渲染包/动作链源码有真实保护意义的断言。
 *
 * 行为：
 *   1. 自己解析 tsc（node_modules 或 pnpm .pnpm 布局），**找不到直接失败**并打印安装命令；
 *   2. 只检查固定文件清单（渲染包入口 + core 动作链相关源码），不扫全仓；
 *   3. 只断言 Cannot find name 错误（排除 Live2DCubismCore，Cubism Core 是运行时全局；
 *      历史代码里 `new csmXxx()` 这类写法属于预存噪声，同样只统计不阻断）。
 *
 * 退出码：0 = 通过；1 = 断言失败；2 = 工具缺失/无法运行。
 * 用法：node tools/typecheck-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INSTALL_HINT = 'pnpm add -D typescript @types/node   # 或 pnpm install';

function findTsc() {
  const candidates = [];
  const direct = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(direct)) candidates.push(direct);
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const entries = fs
      .readdirSync(pnpmDir)
      .filter((n) => /^typescript@/.test(n))
      .sort()
      .reverse();
    for (const e of entries) {
      const p = path.join(pnpmDir, e, 'node_modules', 'typescript', 'bin', 'tsc');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  return candidates;
}

function listSources() {
  const files = [];
  const rendererIndex = path.join(ROOT, 'packages', 'renderer', 'src', 'index.ts');
  if (!fs.existsSync(rendererIndex)) {
    console.error('[typecheck] 缺少 ' + path.relative(ROOT, rendererIndex));
    process.exit(2);
  }
  files.push(rendererIndex);

  const chainNormalize = path.join(ROOT, 'packages', 'core', 'src', 'chain-normalize.ts');
  if (!fs.existsSync(chainNormalize)) {
    console.error('[typecheck] 缺少 ' + path.relative(ROOT, chainNormalize));
    process.exit(2);
  }
  files.push(chainNormalize);

  // E1 语义绑定层：把通道解析成参数写入，类型错了会静默产出错的参数名
  const semanticBinding = path.join(ROOT, 'packages', 'core', 'src', 'semantic-binding.ts');
  if (fs.existsSync(semanticBinding)) files.push(semanticBinding);
  // M1-a 核心纯函数：resolveWritePlan / LimbController（INV 不变量承载者）
  const m1Core = [path.join(ROOT, 'packages', 'core', 'src', 'write-plan.ts'), path.join(ROOT, 'packages', 'core', 'src', 'limb-controller.ts')];
  for (const f of m1Core) if (fs.existsSync(f)) files.push(f);

  // P1 呈现层：自适应布局是纯计算，类型错会静默算出错的缩放/偏移
  const presentationDir = path.join(ROOT, 'packages', 'renderer', 'src', 'presentation');
  if (fs.existsSync(presentationDir)) {
    for (const n of fs.readdirSync(presentationDir).filter((x) => x.endsWith('.ts')).sort()) {
      files.push(path.join(presentationDir, n));
    }
  }

  const coreSrc = path.join(ROOT, 'packages', 'core', 'src');
  const motionFiles = fs
    .readdirSync(coreSrc)
    .filter((n) => /^motion-.*\.ts$/.test(n) && !/\.test\.ts$/.test(n))
    .sort()
    .map((n) => path.join(coreSrc, n));
  // motion-*.ts 是 W3 规划中的动作链文件；当前基线可能还没有，出现后自动纳入，
  // 这里不因「暂时为 0 个」而失败，但会显式打印，避免悄悄漏检。
  if (!motionFiles.length) {
    console.log('[typecheck-smoke] 注意：packages/core/src 下暂无 motion-*.ts（后续新增会自动纳入门禁）');
  } else {
    files.push(...motionFiles);
  }
  return files;
}

const tscList = findTsc();
if (!tscList.length) {
  console.error('[typecheck-smoke] 找不到 typescript（node_modules / node_modules/.pnpm 都没有）。');
  console.error('[typecheck-smoke] 请先安装：' + INSTALL_HINT);
  process.exit(2);
}
// 同版本多份时取排序最后一个（最新），并打印实际路径，便于审计
const tsc = tscList[0];

const files = listSources();
const args = [
  '--noEmit',
  '--strict',
  '--module',
  'esnext',
  '--moduleResolution',
  'bundler',
  '--allowImportingTsExtensions',
  '--skipLibCheck',
  '--lib',
  'ES2022,DOM',
  '--pretty',
  'false',
  ...files,
];

console.log('[typecheck-smoke] tsc: ' + path.relative(ROOT, tsc));
console.log('[typecheck-smoke] files: ' + files.map((f) => path.relative(ROOT, f)).join(', '));

const res = spawnSync(process.execPath, [tsc, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
});

if (res.error) {
  console.error('[typecheck-smoke] 无法运行 tsc: ' + String(res.error.message || res.error));
  console.error('[typecheck-smoke] 请检查安装：' + INSTALL_HINT);
  process.exit(2);
}
if (res.status === null) {
  console.error('[typecheck-smoke] tsc 被信号终止，无法判定');
  process.exit(2);
}

const output = String(res.stdout || '') + String(res.stderr || '');
const lines = output.split(/\r?\n/).filter(Boolean);

// 只关心 Cannot find name；其余预存错误只统计，不阻断
const missingName = [];
const allErrors = [];
for (const line of lines) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (!m) continue;
  allErrors.push(line);
  // TS2304 = Cannot find name；TS2503 = Cannot find namespace（同一个根因：
  // Cubism Core 是运行时全局，没有 .d.ts）。两类都按「缺失全局名」统计。
  const nm = m[5].match(/Cannot find (?:name|namespace) '([^']+)'/);
  if (nm) {
    missingName.push({ file: m[1], line: Number(m[2]), name: nm[1], code: m[4] });
  }
}

// 允许多个全局名（Cubism Core 与当前渲染包里历史代码的 csm 系列），
// 但**必须显式列出**，不静默放过其它缺失名。
const ALLOWED_GLOBALS = new Set(['Live2DCubismCore', 'csmVector2', 'csmRectF', 'csmVector4', 'csmMatrix44', 'csmIntRect']);
const violations = missingName.filter((x) => !ALLOWED_GLOBALS.has(x.name));
const allowedHit = missingName.filter((x) => ALLOWED_GLOBALS.has(x.name));

if (violations.length) {
  console.error('[typecheck-smoke] FAIL：出现未在白名单的 Cannot find name 错误：');
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.name}`);
  process.exit(1);
}

console.log(
  `[typecheck-smoke] PASS（Cannot find name 违规 0；白名单命中 ${allowedHit.length} 个：` +
    [...new Set(allowedHit.map((x) => x.name))].join(', ') +
    '；tsc 其它预存错误 ' + (allErrors.length - missingName.length) + ' 条不计入门禁）',
);
process.exit(0);
