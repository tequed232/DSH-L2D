/**
 * P0 修复（模型加载失败）：overlay.js 恢复状态机静态钩子断言 + renderer bundle 根修回归。
 *
 * 背景：overlay.js 是 4800+ 行 classic script（浏览器 IIFE），无法在 node 里直接执行；
 * 状态机语义已由 l2d-recovery.test.mjs 在纯函数规格模块上全路径覆盖。本测试保证：
 *   ① overlay.js 内嵌实现的关键钩子存在（防后续重构悄悄删掉）；
 *   ② 构建产物 assets/renderer.js 不再含 DEFAULT_EMBODIED_FLAGS 裸引用
 *     （根因：index.ts 漏 import，bundle IIFE 顶层即抛 ReferenceError）。
 * 运行：node packages/dsh-l2d-plugin/lib/overlay-recovery.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok -', name);
  } catch (err) {
    console.error('  FAIL -', name);
    throw err;
  }
}

const overlaySrc = readFileSync(join(HERE, 'overlay.js'), 'utf8');
const repoRoot = join(HERE, '..', '..', '..');
const bundlePath = join(repoRoot, 'packages', 'dsh-l2d-plugin', 'assets', 'renderer.js');

test('overlay 内嵌：恢复状态对象与全部关键钩子存在', () => {
  for (const hook of [
    'var L2D_RECOVERY = {',
    'function setL2DState(',
    'function collapseL2DContainer(',
    'function restoreL2DContainer(',
    'function scheduleL2DRetry(',
    'function retryL2DRenderer(',
    'function showL2DErrorDialog(',
    'function clearL2DRetryTimer(',
  ]) {
    assert.ok(overlaySrc.includes(hook), '缺少钩子: ' + hook);
  }
});

test('overlay 内嵌：验收参数（3 次重试 / 1s-3s-8s / 15s 超时 / 300px）', () => {
  assert.match(overlaySrc, /maxRetries: 3/);
  assert.match(overlaySrc, /retryTimers: \[1000, 3000, 8000\]/);
  assert.match(overlaySrc, /loadTimeoutMs: 15000/);
  assert.match(overlaySrc, /width:300px !important;height:300px !important/);
});

test('overlay 内嵌：对话框独立挂 body 且内容走 textContent（防注入）', () => {
  assert.match(overlaySrc, /getElementById\('dsh-l2d-error-dialog'\)/);
  assert.match(overlaySrc, /document\.body\.appendChild\(dialog\)/);
  assert.match(overlaySrc, /title\.textContent = 'Live2D 模型加载失败'/);
  // showL2DErrorDialog 函数体内不得出现 innerHTML（错误串拼接防注入），其余文件区域的
  // 合法 innerHTML 用法不受影响
  const fnStart = overlaySrc.indexOf('function showL2DErrorDialog(');
  assert.ok(fnStart > 0, 'showL2DErrorDialog 缺失');
  const fnBody = overlaySrc.slice(fnStart, fnStart + 6000);
  assert.doesNotMatch(fnBody, /innerHTML/);
  // 四个用户出口
  for (const action of ['retry', 'model', 'module', 'refresh']) {
    assert.match(overlaySrc, new RegExp(`action: '${action}'`));
  }
});

test('overlay 内嵌：模组禁用持久化 + 刷新恢复', () => {
  assert.match(overlaySrc, /localStorage\.setItem\('dsh-l2d\.disabled', 'true'\)/);
  assert.match(overlaySrc, /localStorage\.getItem\('dsh-l2d\.disabled'\) === 'true'/);
  assert.match(overlaySrc, /dispatchEvent\(new CustomEvent\('dsh:l2d:disable-module'\)\)/);
  assert.match(overlaySrc, /dispatchEvent\(new CustomEvent\('dsh:l2d:state'/);
});

test('overlay 内嵌：initRenderer 带 generation 防旧代竞态 + 超时竞速', () => {
  assert.match(overlaySrc, /var gen = \+\+L2D_RECOVERY\.generation/);
  assert.match(overlaySrc, /Promise\.race\(\[loading, timeout\]\)/);
  assert.match(overlaySrc, /gen !== L2D_RECOVERY\.generation\)? return/);
  // 重试前销毁旧渲染实例 + 移除旧 script，防双 Canvas/双 RAF
  assert.match(overlaySrc, /if \(L && L\.destroy\)/);
  assert.match(overlaySrc, /getElementById\('dsh-l2d-renderer'\)/);
});

test('根修回归：renderer bundle 无 DEFAULT_EMBODIED_FLAGS 裸引用', () => {
  assert.ok(existsSync(bundlePath), 'bundle 未构建：先 pnpm -F @dsh/renderer build');
  const bundle = readFileSync(bundlePath, 'utf8');
  // 修复前形态：`XX=DEFAULT_EMBODIED_FLAGS[...]` —— 名字既无定义也无内联，运行时必炸。
  // 修复后：常量被 esbuild 内联为字面量对象（引用数 0），或保留定义（var/const 声明）。
  const bareRefs = bundle.match(/[=,;(]DEFAULT_EMBODIED_FLAGS[[.]/g) || [];
  assert.equal(bareRefs.length, 0, 'bundle 含裸全局引用（漏 import 根因复现）: ' + bareRefs[0]);
});

console.log('\noverlay-recovery: ' + passed + ' passed, 0 failed');
