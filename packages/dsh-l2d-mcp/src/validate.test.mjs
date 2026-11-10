import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_EXPRESSIONS,
  PLAYABLE_MOTION_GROUPS,
  buildWhitelist,
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
assert.equal(idle.reason, 'idle-not-playable'); // 与 host-guard 同码（两套 code 会让调用方分叉判断）
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


// 并行组字段（Action Chain v2）：group / mode / timeoutMs（整组超时）
const asyncChain = [
  { kind: 'look', x: 0.1, y: 0.1, group: 'g1', mode: 'parallel', timeoutMs: 1200 },
  { kind: 'look', x: -0.1, y: 0, group: 'g1', mode: 'parallel' },
];
assert.equal(validateActChain(asyncChain).ok, true);
assert.match(validateActChain([{ kind: 'look', x: 0, y: 0, mode: 'parallel' }]).errors.join(';'), /必须同时给 group/);
assert.match(validateActChain([{ kind: 'look', x: 0, y: 0, group: 'bad id' }]).errors.join(';'), /group 必须是/);
assert.match(validateActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', mode: 'override' }]).errors.join(';'), /mode 必须是 sequence 或 parallel/);
assert.match(validateActChain([{ kind: 'look', x: 0, y: 0, timeoutMs: 500 }]).errors.join(';'), /整组超时/);
assert.match(validateActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', timeoutMs: 8001 }]).errors.join(';'), /timeoutMs 必须是/);
assert.equal(validateActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', timeoutMs: 0, mode: 'sequence' }]).ok, true);

console.log('validate ok');

// 6. [#28] 动态白名单：模型目录（含目录扫描回退）驱动的表情/动作组。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-validate-'));
  // miku 形态：FileReferences 无 Expressions/Motions，目录里有 exp3 / motion3。
  fs.writeFileSync(
    path.join(dir, 'miku.model3.json'),
    JSON.stringify({ FileReferences: { Moc: 'miku.moc3', Textures: [], Physics: 'miku.physics3.json' } }),
  );
  fs.writeFileSync(path.join(dir, 'miku.physics3.json'), '{}');
  for (const f of ['脸红.exp3.json', '唱歌.exp3.json', 'Scene1.motion3.json']) {
    fs.writeFileSync(path.join(dir, f), '{}');
  }
  const wl = buildWhitelist(dir);
  assert.ok(wl.expressions.includes('脸红'), 'buildWhitelist 应含扫描登记的表情');
  assert.ok(wl.expressions.includes('唱歌'));
  assert.deepEqual(wl.motionGroups, ['Scene1'], '扫描登记的动作组（Idle 过滤后）');
  // 新模型资源过 validateExpressionName / validateMotionGroup / validateActChain
  const dynamicAllowed = { expressions: new Set(wl.expressions), motionGroups: new Set(wl.motionGroups) };
  const chain = [
    { kind: 'expression', name: '脸红' },
    { kind: 'motion', name: 'Scene1' },
  ];
  assert.equal(validateActChain(chain, dynamicAllowed).ok, true, '新模型表情/动作链应放行');
  // 不带 allowed 时用模块级白名单（当前真实模型目录）：新模型独有的名被拒，静态名放行。
  assert.equal(validateActChain([{ kind: 'expression', name: '唱歌' }]).ok, false, '模块白名单不含 miku 独有名');
  assert.equal(validateActChain([{ kind: 'expression', name: '兔牙' }]).ok, true);
  // 注视双名（issue 第 4 点）：look 步骤不写参数名，短名 AngleX 走 keyframes 轨道同样放行结构校验。
  assert.equal(validateActChain([{ kind: 'look', x: 0.5, y: 0 }], dynamicAllowed).ok, true);
  // [#28] 模型绑定语义（chain-e2e 边缘实证）：白名单跟随选定模型，不按名字符串匹配
  // ——大肥鱼独有的「兔牙」在 miku 目录（miku 清单里没有它）必须被拒，
  // 不因「碰巧是大肥鱼合法名」而放行。（validateExpressionName 读模块级白名单，
  // 由 DSH_L2D_MODEL_DIR 启动时决定；模型绑定断言走注入式 validateActChain。）
  assert.equal(
    validateActChain([{ kind: 'expression', name: '兔牙' }], dynamicAllowed).ok,
    false,
    '模型 A 独有名在模型 B 清单下应拒',
  );
  assert.equal(
    validateActChain([{ kind: 'motion', name: '抚胸手打开' }], dynamicAllowed).ok,
    false,
    '模型 A 独有动作组在模型 B 清单下应拒',
  );
  fs.rmSync(dir, { recursive: true, force: true });
}
