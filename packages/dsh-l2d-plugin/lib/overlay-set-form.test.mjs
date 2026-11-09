/**
 * overlay.js `case 'l2d_set_form'` 行为测试（形态直达，含从高形态切回低形态）。
 *
 * overlay.js 是浏览器 IIFE，无法在 node 里整体执行。这里从源码里原样抽出三段：
 *   ① `var BODY_TYPES = [...]` 三形态常量；
 *   ② `function setBodyType(index) {...}` 真实切换实现；
 *   ③ `case 'l2d_set_form': {...}` 分发分支；
 * 在沙箱里用桩（L.setParameter / persist / setSwitch / applyScale / say）拼起来执行，
 * 断言的是回执与副作用（prefs.bodyType、Clothes2 写入值、气泡次数），不是源码字面。
 * 运行：node packages/dsh-l2d-plugin/lib/overlay-set-form.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'overlay.js'), 'utf8');

/** 从 start 处的第一个 open 字符起做括号配对，返回到配对闭合（含）的源码片段。 */
function extractBalanced(marker, open, close) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'overlay.js 缺少片段：' + marker);
  const first = src.indexOf(open, start);
  let depth = 0;
  for (let i = first; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('括号未闭合：' + marker);
}

assert.equal(src.split("case 'l2d_set_form':").length - 1, 1, 'l2d_set_form 分支应且仅应出现一次');
const bodyTypesSrc = extractBalanced('var BODY_TYPES = [', '[', ']');
const setBodyTypeSrc = extractBalanced('function setBodyType(index)', '{', '}');
const caseSrc = extractBalanced("case 'l2d_set_form':", '{', '}');

/** 组装沙箱：返回 exec(args) 与副作用记录。 */
function makeSandbox({ bodyType = 0, hasSetParameter = true, throwOnSwitch = false } = {}) {
  const log = { switches: [], says: [], persists: 0, scales: 0 };
  const prefs = { bodyType };
  const L = hasSetParameter ? { setParameter() {} } : {};
  const window = { DSH_L2D: L };
  const factory = new Function(
    'window', 'prefs', 'log', 'throwOnSwitch',
    `
    ${bodyTypesSrc};
    var settings = { scale: 1 };
    function persist() { log.persists++; }
    function setSwitch(id, value) { if (throwOnSwitch) throw new Error('boom'); log.switches.push([id, value]); }
    function applyScale() { log.scales++; }
    function say(text) { log.says.push(text); }
    ${setBodyTypeSrc}
    return function exec(name, args) {
      var a = args || {};
      var L = window.DSH_L2D;
      switch (name) {
        ${caseSrc}
        default: return { ok: false, reason: 'not-reached' };
      }
    };
    `,
  );
  return { exec: factory(window, prefs, log, throwOnSwitch), prefs, log };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); } catch (err) { console.error('  FAIL -', name); throw err; }
}

test('从体型2 直接切回默认体型（低形态回退）', () => {
  const sb = makeSandbox({ bodyType: 2 });
  const r = sb.exec('l2d_set_form', { index: 0 });
  assert.deepEqual(r, { ok: true, form: { index: 0, label: '默认体型' } });
  assert.equal(sb.prefs.bodyType, 0);
  assert.deepEqual(sb.log.switches, [['Clothes2', 0]]);
  assert.equal(sb.log.says.length, 1);
  assert.equal(sb.log.persists, 1);
});

test('任意两形态互切：0→2、2→1、1→0、0→1', () => {
  const sb = makeSandbox({ bodyType: 0 });
  const labels = ['默认体型', '体型1', '体型2'];
  const values = [0, 0.4, 1.0];
  for (const target of [2, 1, 0, 1]) {
    const r = sb.exec('l2d_set_form', { index: target });
    assert.deepEqual(r, { ok: true, form: { index: target, label: labels[target] } });
    assert.equal(sb.prefs.bodyType, target);
    assert.deepEqual(sb.log.switches.at(-1), ['Clothes2', values[target]]);
  }
});

test('已是目标形态：ok + already-current，不写参数、不弹气泡、不落盘', () => {
  const sb = makeSandbox({ bodyType: 1 });
  const r = sb.exec('l2d_set_form', { index: 1 });
  assert.deepEqual(r, { ok: true, form: { index: 1, label: '体型1' }, notes: ['already-current'] });
  assert.deepEqual(sb.log.switches, []);
  assert.deepEqual(sb.log.says, []);
  assert.equal(sb.log.persists, 0);
});

test('index 缺失 / 非整数 / 越界 / 非数值：invalid-form-index，无副作用', () => {
  for (const args of [undefined, {}, { index: -1 }, { index: 3 }, { index: 0.5 }, { index: '2' }, { index: null }, { index: NaN }, { index: true }]) {
    const sb = makeSandbox({ bodyType: 2 });
    assert.deepEqual(sb.exec('l2d_set_form', args), { ok: false, reason: 'invalid-form-index' }, JSON.stringify(args));
    assert.equal(sb.prefs.bodyType, 2);
    assert.deepEqual(sb.log.switches, []);
  }
});

test('缺 L.setParameter：form-unavailable，不改 prefs', () => {
  const sb = makeSandbox({ bodyType: 2, hasSetParameter: false });
  assert.deepEqual(sb.exec('l2d_set_form', { index: 0 }), { ok: false, reason: 'form-unavailable' });
  assert.equal(sb.prefs.bodyType, 2);
});

test('切换过程抛异常：form-unavailable，不抛出', () => {
  const sb = makeSandbox({ bodyType: 0, throwOnSwitch: true });
  assert.deepEqual(sb.exec('l2d_set_form', { index: 2 }), { ok: false, reason: 'form-unavailable' });
  assert.equal(sb.prefs.bodyType, 0);
  // setBodyType 先 persist 一次，回滚再 persist 一次。
  assert.equal(sb.log.persists, 2);
});

test('l2d_change_form 分支保持原样（仍走 cycleBodyType 单向 +1）', () => {
  const changeSrc = extractBalanced("case 'l2d_change_form':", '{', '}');
  assert.ok(changeSrc.includes('cycleBodyType()'));
  assert.ok(!changeSrc.includes('setBodyType('));
});

console.log(`overlay-set-form ok（${passed} 用例）`);
