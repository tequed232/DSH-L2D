/**
 * 运行时参数槽测试（ACTION-PROGRAM-SPEC-DRAFT.md §2）。
 * 直跑：node packages/mcp-bridge/tests/program-slots.test.mjs
 */
import assert from 'node:assert/strict';
import { defineSlots, resolveParams } from '../program-slots.mjs';

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

const SLOTS = defineSlots({
  gazeX: { type: 'number', min: -1, max: 1, default: 0 },
  gazeY: { type: 'number', min: -1, max: 1, default: 0.3 },
  moodLevel: { type: 'enum', values: ['low', 'mid', 'high'], default: 'mid' },
  loop: { type: 'bool', default: false },
});

console.log('运行时参数槽');

it('defineSlots 合法定义原样通过；非法类型 / min>max / enum 越界 default 全部抛错', () => {
  assert.throws(() => defineSlots({ a: { type: 'number', min: 1, max: 0, default: 0 } }), /min<=max/);
  assert.throws(() => defineSlots({ a: { type: 'expression' } }), /number\/enum\/bool/);
  assert.throws(() => defineSlots({ a: { type: 'enum', values: ['a'], default: 'b' } }), /values 内/);
  assert.throws(() => defineSlots({ a: { type: 'bool', default: 'yes' } }), /布尔/);
  assert.deepEqual(defineSlots(undefined), {});
});

it('$slot 命中 args → 取调用值；未提供 → default；number 越界 → 钳制', () => {
  const params = { x: { $slot: 'gazeX' }, y: { $slot: 'gazeY' }, level: { $slot: 'moodLevel' } };
  const r1 = resolveParams(params, SLOTS, { gazeX: 0.5, gazeY: -2, moodLevel: 'high' });
  assert.deepEqual(r1.params, { x: 0.5, y: -1, level: 'high' });
  const r2 = resolveParams(params, SLOTS, {});
  assert.deepEqual(r2.params, { x: 0, y: 0.3, level: 'mid' });
});

it('bool 槽：非布尔输入一律回落 default（不做 truthy 猜测）', () => {
  const r = resolveParams({ loop: { $slot: 'loop' } }, SLOTS, { loop: 'yes' });
  assert.equal(r.params.loop, false);
  assert.equal(resolveParams({ loop: { $slot: 'loop' } }, SLOTS, { loop: true }).params.loop, true);
});

it('引用未声明的槽 → 明确报 unknown-slot（绝不静默放 0）', () => {
  const r = resolveParams({ x: { $slot: 'nope' } }, SLOTS, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-slot');
  assert.match(r.message, /nope/);
});

it('常量参数原样透传，不做任何加工', () => {
  const r = resolveParams({ name: 'happy', weight: 2, nested: { a: 1 } }, SLOTS, {});
  assert.deepEqual(r.params, { name: 'happy', weight: 2, nested: { a: 1 } });
});

console.log('');
if (process.exitCode) {
  console.error('program-slots: 存在失败');
  process.exit(1);
}
console.log(`program-slots: ${passed} 项全部通过`);
