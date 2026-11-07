/**
 * Fix #40 回归：overModel 命中判定不得 fail-open 外溢。
 *
 * 背景（issue #40）：渲染包 hitTestAt 对「没采样过的点」fail-open 返回 true；
 * overlay 的 overModel 无条件信任它，导致页面任意位置的 pointerdown 被当成
 * 「命中模型」启动拖拽——换装按钮点击被劫持，容器被后续鼠标移动拖到左上角
 * （clamp 下界 y=0、x≥-0.35w = 部分出屏）。修复：容器矩形预判 + 同步
 * fail-closed 的 hitTestBox 包围盒预筛（与 overModelRightClick 同语义）。
 *
 * overlay.js 是 classic script（浏览器 IIFE），与 overlay-recovery.test.mjs
 * 同理只能做静态断言。运行：node packages/dsh-l2d-plugin/lib/overlay-hitguard.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const overlaySrc = readFileSync(join(HERE, 'overlay.js'), 'utf8');

const fnStart = overlaySrc.indexOf('function overModel(');
assert.ok(fnStart > 0, 'overModel 缺失');
const fnBody = overlaySrc.slice(fnStart, overlaySrc.indexOf('function overModelRightClick', fnStart));

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

test('overModel：容器矩形外直接判否（不受探针 fail-open 影响）', () => {
  assert.match(fnBody, /root\.getBoundingClientRect\(\)/);
  assert.match(fnBody, /e\.clientX < rr\.left/);
  assert.match(fnBody, /e\.clientX > rr\.right/);
  assert.match(fnBody, /e\.clientY < rr\.top/);
  assert.match(fnBody, /e\.clientY > rr\.bottom/);
  // 矩形外分支必须先于渲染包命中调用
  assert.ok(
    fnBody.indexOf('getBoundingClientRect()') < fnBody.indexOf('hitTestAt('),
    '容器矩形预判必须在 hitTestAt 之前'
  );
});

test('overModel：hitTestBox 同步包围盒预筛先于 alpha 判定（fail-closed）', () => {
  assert.match(fnBody, /if \(L\.hitTestBox\)/);
  assert.match(fnBody, /if \(!L\.hitTestBox\(e\.clientX, e\.clientY\)\) return false/);
  assert.ok(
    fnBody.indexOf('hitTestBox(e.clientX') < fnBody.lastIndexOf('hitTestAt('),
    'hitTestBox 预筛必须在 hitTestAt 之前'
  );
});

test('overModel：旧渲染包/静态兜底仅在容器矩形内放行（整盒语义不扩大）', () => {
  assert.match(fnBody, /if \(!L \|\| !L\.hitTestAt\) return true/);
  assert.ok(
    fnBody.indexOf('return true; // 旧渲染包') > fnBody.indexOf('getBoundingClientRect()'),
    '静态兜底 return true 必须在容器矩形预判之后'
  );
});

test('overModel：alpha 判定的 catch 兜底保留（保持旧渲染包行为）', () => {
  assert.match(fnBody, /catch \(err\) \{ return true; \}/);
});

console.log('\noverlay-hitguard: ' + passed + ' passed, 0 failed');
