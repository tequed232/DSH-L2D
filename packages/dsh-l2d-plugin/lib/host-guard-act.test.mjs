/**
 * l2d_act 链守卫 + 模型变体并集（host-guard.mjs）。
 *
 * 背景：MCP 侧一直有 validateActChain，HTTP `/dsh-l2d/ai/call` 直连却没有——
 * 同一个工具面不能有两套准入标准，否则调试通道就是绕过白名单的旁路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_STEP_KINDS,
  MODEL_FILE,
  MODEL_FILES,
  PHYSICS_FILE,
  checkActChain,
  createModelIndexCache,
  guardAiCall,
  loadModelIndex,
} from './host-guard.mjs';

// ---------------------------------------------------------------------------
// 0) 模型变体：主窗（4096）与桌宠窗（2048）都加载，索引取并集
// ---------------------------------------------------------------------------
assert.equal(MODEL_FILES.length, 2);
assert.equal(MODEL_FILE, MODEL_FILES[0]);
assert.ok(MODEL_FILES.some((f) => f.includes('.2048.')), '2048 降档变体必须在列表里（pet.html 加载它）');

const dirs = [];
function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-act-'));
  dirs.push(dir);
  for (const [file, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

// 两个变体各给一个对方没有的表情/动作组：并集后都可用。
const unionDir = tempDir({
  [MODEL_FILES[0]]: { FileReferences: { Expressions: [{ Name: '高清专属' }], Motions: { 高清组: [] } } },
  [MODEL_FILES[1]]: { FileReferences: { Expressions: [{ Name: '降档专属' }], Motions: { 降档组: [] } } },
  [PHYSICS_FILE]: { PhysicsSettings: [] },
});
const union = loadModelIndex(unionDir);
assert.deepEqual(union.warnings, []);
assert.ok(union.expressions.has('高清专属') && union.expressions.has('降档专属'), '两变体表情应取并集');
assert.ok(union.motionGroups.has('高清组') && union.motionGroups.has('降档组'), '两变体动作组应取并集');
// 静态名单 + 运行时并集：两边的名字都能过守卫
assert.equal(guarded('l2d_set_expression', { name: '高清专属' }, union).ok, true);
assert.equal(guarded('l2d_set_expression', { name: '降档专属' }, union).ok, true);

// 只有 2048 变体（桌宠窗场景）也必须可用：不能因为写死主文件名而误拒。
const petOnly = loadModelIndex(tempDir({
  [MODEL_FILES[1]]: { FileReferences: { Expressions: [{ Name: '桌宠表情' }], Motions: { 桌宠组: [] } } },
  [PHYSICS_FILE]: { PhysicsSettings: [] },
}));
assert.deepEqual(petOnly.warnings, []);
assert.equal(guarded('l2d_set_expression', { name: '桌宠表情' }, petOnly).ok, true);

// 两个变体都读不到 → 退回静态名单（安全侧，不 fail-open）
const noneDir = tempDir({ [PHYSICS_FILE]: { PhysicsSettings: [] } });
const none = loadModelIndex(noneDir);
assert.equal(none.expressions, null);
assert.ok(none.warnings.some((w) => w.startsWith('model3-unavailable')));
assert.equal(guarded('l2d_set_expression', { name: '兔牙' }, none).ok, true);
assert.equal(guarded('l2d_set_expression', { name: '高清专属' }, none).reason, 'unknown-expression');

// 缓存读到的也是并集（TTL 内复用同一个对象）
const cache = createModelIndexCache(unionDir, { ttlMs: 10_000 });
assert.ok(cache.get().expressions.has('高清专属') && cache.get().expressions.has('降档专属'));

// ---------------------------------------------------------------------------
// 1) checkActChain：与 MCP validateActChain 同规则（结构/名字/范围/口型）
// ---------------------------------------------------------------------------
function guarded(name, args, index) {
  return guardAiCall({ name, args }, { index: index || null });
}

assert.deepEqual([...HOST_STEP_KINDS].sort(), ['expression', 'keyframes', 'look', 'motion', 'pose']);

// 不传 chain 视为空（phase 内置链靠 phase 字段，不算非法）
assert.equal(checkActChain(undefined).ok, true);
assert.equal(checkActChain([]).ok, true);

// 合法 4 类 + keyframes（HTTP 调试专用步骤）
const goodChain = [
  { kind: 'expression', name: '兔牙' },
  { kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 2800 },
  { kind: 'pose', pose: { right: 'finger' }, delayMs: 120 },
  { kind: 'look', x: 0.2, y: -0.1, delayMs: 80 },
  { kind: 'keyframes', tracks: [{ param: 'AngleX', keys: [[0, 0], [500, 5]] }], duration: 1000 },
];
assert.deepEqual(checkActChain(goodChain), { ok: true, errors: [] });
assert.equal(guarded('l2d_act', { chain: goodChain }).ok, true);
// 只给 phase 的调用不受 chain 守卫影响
assert.equal(guarded('l2d_act', { phase: 'thinking' }).ok, true);

// 非数组 / 超步数
assert.equal(checkActChain('nope').ok, false);
assert.match(checkActChain('nope').errors[0], /必须是数组/);
assert.equal(checkActChain(new Array(9).fill({ kind: 'look', x: 0, y: 0 })).ok, false);
assert.match(checkActChain(new Array(9).fill({ kind: 'look', x: 0, y: 0 })).errors[0], /超过 8 步/);
// 8 步正好放行
assert.equal(checkActChain(new Array(8).fill({ kind: 'look', x: 0, y: 0 })).ok, true);

// 未知 kind（含 step 不是对象）
for (const badStep of [{ kind: 'bubble', text: 'hi' }, { kind: 'say' }, null, 42, 'look']) {
  const result = checkActChain([badStep]);
  assert.equal(result.ok, false, 'kind 非法应拒：' + JSON.stringify(badStep));
  assert.match(result.errors[0], /kind 非法/);
}
// 表情名 / 动作组不在静态表
assert.match(checkActChain([{ kind: 'expression', name: '不存在的表情' }]).errors[0], /表情名不存在/);
assert.match(checkActChain([{ kind: 'motion', name: '不存在的组' }]).errors[0], /动作组不存在/);
// pose / look 越界
assert.match(checkActChain([{ kind: 'pose', pose: { right: 'jump' } }]).errors[0], /取值非法/);
assert.match(checkActChain([{ kind: 'look', x: 5, y: 0 }]).errors[0], /-1~1/);
// 未知字段（防止外部塞任意结构）
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, evil: 1 }]).errors[0], /未知字段/);

// keyframes 步骤：缺 tracks / 关键帧不足
assert.match(checkActChain([{ kind: 'keyframes' }]).errors[0], /缺 tracks/);
assert.match(checkActChain([{ kind: 'keyframes', tracks: [{ param: 'AngleX', keys: [[0, 0]] }] }]).errors[0], /少于 2 个关键帧/);
assert.match(checkActChain([{ kind: 'keyframes', tracks: [{}] }]).errors[0], /缺 param/);

// ---------------------------------------------------------------------------
// 2) 口型：任何通道永拒（含动作链 / keyframes 步骤 / 嵌套文本）
// ---------------------------------------------------------------------------
const mouthChains = [
  [{ kind: 'keyframes', tracks: [{ param: 'ParamMouthOpenY', keys: [[0, 0], [100, 1]] }] }],
  [{ kind: 'expression', name: '兔牙' }, { kind: 'look', x: 0, y: 0, extra: { ParamMouthForm: 1 } }],
  [{ kind: 'pose', pose: { right: 'finger' }, note: 'ParamMouthOpen' }],
];
for (const chain of mouthChains) {
  const result = checkActChain(chain);
  assert.equal(result.ok, false, '口型应拒：' + JSON.stringify(chain));
  assert.match(result.errors.join('; '), /口型参数/);
  const viaGuard = guarded('l2d_act', { chain });
  assert.equal(viaGuard.ok, false);
  assert.equal(viaGuard.reason, 'invalid-chain');
  assert.equal(viaGuard.status, 400);
  assert.match(viaGuard.message, /invalid-chain/);
}

// ---------------------------------------------------------------------------
// 3) 守卫不抛：畸形 chain / 环引用
// ---------------------------------------------------------------------------
const cyclicStep = { kind: 'look', x: 0, y: 0 };
cyclicStep.self = cyclicStep;
for (const weird of [undefined, null, 42, 'x', [], [cyclicStep], [{ kind: 'expression' }]]) {
  const result = guarded('l2d_act', { chain: weird });
  assert.equal(typeof result.ok, 'boolean', '畸形 chain 不应抛：' + String(weird));
}

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 4) Action Chain v2 字段：group / mode / timeoutMs 在 host 守卫里同样放行且校验
// ---------------------------------------------------------------------------
assert.equal(checkActChain([
  { kind: 'look', x: 0.1, y: 0.1, group: 'g1', mode: 'parallel', timeoutMs: 1200 },
  { kind: 'pose', pose: { right: 'finger' }, group: 'g1', mode: 'parallel' },
]).ok, true);
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, mode: 'parallel' }]).errors.join(';'), /必须同时给 group/);
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, group: 'bad id' }]).errors.join(';'), /group 必须是/);
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', mode: 'override' }]).errors.join(';'), /mode 必须是/);
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, timeoutMs: 500 }]).errors.join(';'), /整组超时/);
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', timeoutMs: 9000 }]).errors.join(';'), /timeoutMs 必须是/);
// 仍拒绝真正的未知字段（防止并行组成为任意 payload 的口子）
assert.match(checkActChain([{ kind: 'look', x: 0, y: 0, group: 'g1', priority: 1 }]).errors.join(';'), /未知字段/);

console.log('host-guard-act ok');
