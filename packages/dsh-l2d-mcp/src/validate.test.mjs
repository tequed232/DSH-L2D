import assert from 'node:assert/strict';
import {
  ALLOWED_EXPRESSIONS,
  PLAYABLE_MOTION_GROUPS,
  findReservedParams,
  validateActChain,
  validateExpressionName,
  validateMotionGroup,
} from './validate.mjs';

// 1. 表情白名单：模型真实存在的 21 个名字放行，其余拒绝。
assert.equal(ALLOWED_EXPRESSIONS.length, 21);
for (const name of ['兔牙', '脸红', '流冷汗', '体型1', '前倾']) {
  assert.equal(validateExpressionName(name).ok, true, name);
}
const badExpr = validateExpressionName('不存在的表情');
assert.equal(badExpr.ok, false);
assert.equal(badExpr.reason, 'unknown-expression');
assert.ok(Array.isArray(badExpr.allowed));
assert.equal(validateExpressionName('').ok, false);
assert.equal(validateExpressionName(null).ok, false);

// 2. 动作组白名单：6 个成对组放行；Idle 与未索引组拒绝（Idle 由引擎自播，不是遗漏）。
assert.equal(PLAYABLE_MOTION_GROUPS.length, 6);
for (const group of PLAYABLE_MOTION_GROUPS) {
  assert.equal(validateMotionGroup(group).ok, true, group);
}
const idle = validateMotionGroup('Idle');
assert.equal(idle.ok, false);
assert.equal(idle.reason, 'unknown-motion-group');
assert.equal(validateMotionGroup('跳舞').ok, false);
assert.equal(validateMotionGroup('').ok, false);

// 3. 动作链：结构 + 名字 + 范围。
const valid = [
  { kind: 'expression', name: '兔牙' },
  { kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 2800 },
  { kind: 'pose', pose: { right: 'finger' } },
  { kind: 'look', x: 0.2, y: -0.1, delayMs: 100 },
];
const okChain = validateActChain(valid);
assert.equal(okChain.ok, true, JSON.stringify(okChain.errors));
assert.deepEqual(okChain.errors, []);

assert.equal(validateActChain([{ kind: 'motion', name: '跳舞' }]).ok, false, '未索引动作组');
assert.equal(validateActChain([{ kind: 'expression', name: '假表情' }]).ok, false, '未索引表情');
assert.equal(validateActChain([{ kind: 'look', x: 2, y: 0 }]).ok, false, 'look 越界');
assert.equal(validateActChain([{ kind: 'pose', pose: { right: 'wave' } }]).ok, false, 'pose 非法值');
assert.equal(validateActChain([{ kind: 'look', x: 0, y: 0, delayMs: 9000 }]).ok, false, 'delayMs 越界');
assert.equal(validateActChain([{ kind: 'look', x: 0, y: 0, extra: 1 }]).ok, false, '未知字段');
assert.equal(validateActChain('not-an-array').ok, false);
assert.equal(validateActChain([]).ok, true, '空链结构合法（由调用方另行处理 empty-chain）');

// 4. 口型守卫：动作链里出现口型参数名 → 拒绝并列出。
const mouthChain = [{ kind: 'expression', name: 'ParamMouthOpenY' }];
const mouth = validateActChain(mouthChain);
assert.equal(mouth.ok, false);
assert.ok(mouth.reserved.includes('ParamMouthOpenY'));
assert.ok(mouth.errors.some((e) => e.includes('口型')));

// 5. 任意入参扫描（未来新增工具复用）。
assert.deepEqual(findReservedParams({ chain: mouthChain }), ['ParamMouthOpenY']);
assert.deepEqual(findReservedParams({ chain: valid }), []);

console.log('validate ok');
