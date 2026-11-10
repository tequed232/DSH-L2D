/**
 * body-bridge 规则核心行为测试（纯函数，用仓库真实分区表 + 小夹具）。
 * 跑法：node packages/dsh-l2d-plugin/lib/body-bridge.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_REASONS,
  createBridge,
  compileBodyTable,
  validateBridgeCommand,
  describeRegions,
  motionSlotBase,
  composeView,
} from './body-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE_FILE = path.resolve(here, '../../../docs/nodegraph/models/大肥鱼.dsl2d.2048/body-regions.json');
const table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
const compiled = compileBodyTable(table);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('✗ ' + name);
    throw e;
  }
}
const v = (cmd) => validateBridgeCommand(compiled, cmd);

// ------------------------------------------------------------------ 表编译
test('五个模块的可写参数与表一致（legs 只开放 Clothes4）', () => {
  assert.deepEqual([...compiled.regions.hair.writable].sort(), ['FrontHairZ', 'LateSideHairXBS', 'LateSideHairYbs', 'Param137', 'Param139'].sort());
  assert.deepEqual([...compiled.regions.legs.writable], ['Clothes4']);
  assert.equal(compiled.regions.torso.writable.size, 14);
  assert.equal(compiled.regions.hands.writable.size, 24);
  // face 80 个可写里去掉口型红线（ParamMouthOpenY / ParamMouthForm）
  assert.equal(compiled.regions.face.writable.has('ParamMouthOpenY'), false);
  assert.equal(compiled.regions.face.writable.has('ParamMouthForm'), false);
});
test('互斥组：眼型 key3–key6 与三个体型；前倾不进互斥组而走转换', () => {
  const eye = compiled.exprGroup.get('圈圈眼');
  assert.ok(eye);
  for (const n of ['屑', '爱心眼', '＞＜']) assert.equal(compiled.exprGroup.get(n), eye);
  const body = compiled.exprGroup.get('体型1');
  assert.ok(body && body !== eye);
  assert.equal(compiled.exprGroup.get('默认体型'), body);
  assert.equal(compiled.exprGroup.get('前倾'), undefined);
  // 前倾 / 脱鞋 固定转换；裙长切换 / 胸口衣服 由饰品表（paramHome=torso）推出转换
  assert.deepEqual(Object.keys(compiled.conversions).sort(), ['前倾', '脱鞋', '裙长切换', '胸口衣服'].sort());
  assert.deepEqual(compiled.conversions['裙长切换'], { region: 'torso', param: 'Clothes1', on: -1, off: 1 });
});
test('motionSlotBase', () => {
  assert.equal(motionSlotBase('竖手指打开'), '竖手指');
  assert.equal(motionSlotBase('狗尾巴草关闭'), '狗尾巴草');
  assert.equal(motionSlotBase('Idle'), '');
});
test('describeRegions 给出每模块动作与可写参数', () => {
  const d = describeRegions(compiled);
  assert.deepEqual(d.regions.hands.motions.length, 6);
  assert.ok(d.regions.torso.writable.includes('LeanInput'));
  assert.deepEqual(d.form.params, ['Clothes2', 'Param']);
  assert.equal(d.expression.converted['前倾'], 'torso.LeanInput');
  assert.ok(!d.expression.expressions.includes('脱鞋'));
});

// ------------------------------------------------------------------ 静态校验
test('合法指令归一化：缺省 source=llm priority=NORMAL onBusy=blend cut=next fadeMs=300', () => {
  const r = v({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }, { region: 'torso', set: { LeanInput: -10 }, durationMs: 400 }, { layer: 'expression', expression: '脸红', on: true }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.command.source, 'llm');
  assert.equal(r.command.priority, 'NORMAL');
  assert.equal(r.command.onBusy, 'blend');
  assert.equal(r.command.cut, 'next');
  assert.equal(r.command.fadeMs, 300);
  assert.equal(r.command.steps[1].durationMs, 400);
});
test('BACKGROUND 作为 LOW 的别名；未知优先级拒绝', () => {
  assert.equal(v({ priority: 'background', steps: [{ layer: 'form', form: 1 }] }).command.priority, 'LOW');
  assert.equal(v({ priority: 'URGENT', steps: [{ layer: 'form', form: 1 }] }).reason, 'invalid-priority');
});
test('unknown-region / unknown-layer / empty-steps / invalid-source', () => {
  assert.equal(v({ steps: [{ region: 'tail', set: { Clothes5: 1 } }] }).reason, 'unknown-region');
  assert.equal(v({ steps: [{ layer: 'blink', x: 1 }] }).reason, 'unknown-layer');
  assert.equal(v({ steps: [] }).reason, 'empty-steps');
  assert.equal(v({ source: 'robot', steps: [{ layer: 'form', form: 0 }] }).reason, 'invalid-source');
  assert.equal(v(null).reason, 'invalid-command');
});
test('动作归属以表为准：写错模块 motion-not-in-region，不存在 unknown-motion', () => {
  const r = v({ steps: [{ region: 'torso', motion: '竖手指打开' }] });
  assert.equal(r.reason, 'motion-not-in-region');
  assert.equal(r.errors[0].expectedRegion, 'hands');
  assert.equal(v({ steps: [{ region: 'hands', motion: '转圈圈' }] }).reason, 'unknown-motion');
});
test('set 只能写本模块可写参数', () => {
  // 物理输出
  assert.equal(v({ steps: [{ region: 'hair', set: { FrontHairX1: 1 } }] }).reason, 'param-not-writable');
  // 别的模块的参数
  const r = v({ steps: [{ region: 'hair', set: { LeanInput: 1 } }] });
  assert.equal(r.reason, 'param-not-writable');
  assert.match(r.errors[0].detail, /torso/);
  // 未分区（尾巴）
  assert.equal(v({ steps: [{ region: 'torso', set: { Clothes5: 1 } }] }).reason, 'param-not-writable');
  // 表情层开关键
  assert.equal(v({ steps: [{ region: 'face', set: { key3: 1 } }] }).reason, 'param-not-writable');
  // 形态参数只能走 form 层
  assert.equal(v({ steps: [{ region: 'torso', set: { Clothes2: 1 } }] }).reason, 'param-not-writable');
  assert.equal(v({ steps: [{ region: 'hair', set: { Param: 1 } }] }).reason, 'param-not-writable');
  // 腿部物理输出 / 只开放 Clothes4
  assert.equal(v({ steps: [{ region: 'legs', set: { Param33: 1 } }] }).reason, 'param-not-writable');
  assert.equal(v({ steps: [{ region: 'legs', set: { Clothes4: 1 } }] }).ok, true);
  // 手部动作借用的 Param56/57 不开放直写
  assert.equal(v({ steps: [{ region: 'hands', set: { Param56: 1 } }] }).reason, 'param-not-writable');
});
test('口型红线 lipsync-redline（ParamMouthOpenY 与同名单参数）', () => {
  assert.equal(v({ steps: [{ region: 'face', set: { ParamMouthOpenY: 1 } }] }).reason, 'lipsync-redline');
  assert.equal(v({ steps: [{ region: 'face', set: { ParamMouthForm: 0 } }] }).reason, 'lipsync-redline');
});
test('invalid-value / durationMs 非法', () => {
  assert.equal(v({ steps: [{ region: 'torso', set: { LeanInput: 'x' } }] }).reason, 'invalid-value');
  assert.equal(v({ steps: [{ region: 'torso', set: { LeanInput: 1 }, durationMs: -1 }] }).reason, 'invalid-value');
});
test('同一条里同模块两步 duplicate-region；前倾转换后与 torso 步撞车也算', () => {
  assert.equal(v({ steps: [{ region: 'torso', set: { LeanInput: 1 } }, { region: 'torso', set: { PositionX: 1 } }] }).reason, 'duplicate-region');
  assert.equal(v({ steps: [{ region: 'torso', set: { PositionX: 1 } }, { layer: 'expression', expression: '前倾' }] }).reason, 'duplicate-region');
});
test('同一条里互斥表情 expression-conflict；不同组可同条', () => {
  const r = v({ steps: [{ layer: 'expression', expression: '圈圈眼' }, { layer: 'expression', expression: '爱心眼' }] });
  assert.equal(r.reason, 'expression-conflict');
  assert.equal(v({ steps: [{ layer: 'expression', expression: '圈圈眼' }, { layer: 'expression', expression: '脸红' }] }).ok, true);
  assert.equal(v({ steps: [{ layer: 'expression', expression: '不存在' }] }).reason, 'unknown-expression');
});
test('前倾 → torso set LeanInput；脱鞋 → legs set Clothes4（on:false 写回 0）', () => {
  const a = v({ steps: [{ layer: 'expression', expression: '前倾', on: true }] });
  assert.deepEqual(a.command.steps[0], { region: 'torso', kind: 'set', set: { LeanInput: -30 }, durationMs: 0, convertedFrom: '前倾' });
  const b = v({ steps: [{ layer: 'expression', expression: '脱鞋', on: false }] });
  assert.deepEqual(b.command.steps[0].set, { Clothes4: 0 });
  assert.equal(b.command.steps[0].region, 'legs');
});
test('裙长切换转成 torso set 后与同条 torso 步撞车：duplicate-region', () => {
  const r = v({ steps: [{ region: 'torso', set: { Clothes1: 0.5 } }, { layer: 'expression', expression: '裙长切换' }] });
  assert.equal(r.reason, 'duplicate-region');
});
test('形态步与体型表情同条：形态优先；form 序号越界 invalid-form', () => {
  assert.equal(v({ steps: [{ layer: 'form', form: 1 }, { layer: 'expression', expression: '体型2' }] }).reason, 'expression-conflict');
  assert.equal(v({ steps: [{ layer: 'form', form: 3 }] }).reason, 'invalid-form');
  assert.equal(v({ steps: [{ layer: 'form', form: 1.5 }] }).reason, 'invalid-form');
});
test('所有失败原因都在 BRIDGE_REASONS 里', () => {
  const samples = [
    v({ steps: [{ region: 'x', set: {} }] }),
    v({ steps: [{ region: 'face', set: { ParamMouthOpenY: 1 } }] }),
    v({ steps: [{ region: 'hands', motion: 'Idle' }] }),
  ];
  for (const s of samples) assert.ok(BRIDGE_REASONS.includes(s.reason), s.reason);
});

// 下面的占用 / 仲裁用例针对 onBusy:'reject' / 'wait' 的语义：没写 onBusy 的指令按 reject 发（缺省已改为 blend，见「衔接」用例）
function rejectBridge(...args) {
  const b = createBridge(...args);
  const act = b.act;
  b.act = (cmd, ctx) => act(cmd && typeof cmd === 'object' && cmd.onBusy === undefined ? { ...cmd, onBusy: 'reject' } : cmd, ctx);
  return b;
}
// ------------------------------------------------------------------ 占用 / 仲裁
const NOW = { now: 1000, slots: {} };
test('空闲时受理：回执 {ok, commandId, accepted, preempted, warnings}', () => {
  const b = rejectBridge(table);
  const r = b.act({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }, { layer: 'expression', expression: '脸红' }] }, NOW);
  assert.equal(r.ok, true);
  assert.match(r.commandId, /^bc-\d+$/);
  assert.deepEqual(r.accepted, ['hands', 'expression']);
  assert.deepEqual(r.preempted, []);
  assert.ok(Array.isArray(r.warnings));
  const s = b.snapshot({ now: 1100 });
  assert.equal(s.regions.hands.busy, true);
  assert.equal(s.regions.hands.commandId, r.commandId);
  assert.deepEqual(s.regions.hands.borrowed.sort(), ['Param56', 'Param57']);
  assert.equal(s.regions.torso.busy, false);
  assert.equal(s.expression.name, '脸红');
});
test('同级或更低 → region-busy 带当前占用者；不动原指令', () => {
  const b = rejectBridge(table);
  const a = b.act({ priority: 'HIGH', source: 'nodegraph', steps: [{ region: 'torso', set: { LeanInput: -10 }, durationMs: 1000 }] }, NOW);
  const same = b.act({ priority: 'HIGH', steps: [{ region: 'torso', set: { PositionX: 1 } }] }, NOW);
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'region-busy');
  assert.deepEqual(same.busy[0], { region: 'torso', holder: { commandId: a.commandId, priority: 'HIGH', source: 'nodegraph' }, convertedFrom: undefined });
  const low = b.act({ priority: 'LOW', steps: [{ region: 'torso', set: { PositionX: 1 } }] }, NOW);
  assert.equal(low.reason, 'region-busy');
  assert.equal(b.snapshot(NOW).regions.torso.commandId, a.commandId);
});
test('原子：一个模块拿不到就整条拒绝，其余模块不被占', () => {
  const b = rejectBridge(table);
  b.act({ priority: 'FORCE', steps: [{ region: 'hands', motion: '竖手指打开' }] }, NOW);
  const r = b.act({ steps: [{ region: 'torso', set: { LeanInput: -5 } }, { region: 'hands', motion: '抚胸手打开' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(b.snapshot(NOW).regions.torso.busy, false);
});
test('更高优先级抢占：只对被抢模块发 interrupted，其余模块不动', () => {
  const b = rejectBridge(table);
  const a = b.act({ priority: 'NORMAL', steps: [{ region: 'hands', motion: '竖手指打开' }, { region: 'torso', set: { LeanInput: -10 }, durationMs: 5000 }] }, NOW);
  const c = b.act({ priority: 'HIGH', steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, { now: 1200, slots: { 竖手指: 'open', 狗尾巴草: 'closed', 抚胸手: 'closed' } });
  assert.equal(c.ok, true);
  assert.deepEqual(c.preempted, [{ region: 'hands', commandId: a.commandId, priority: 'NORMAL', source: 'llm' }]);
  assert.equal(c.events.length, 1);
  assert.deepEqual(
    { type: c.events[0].type, phase: c.events[0].phase, commandId: c.events[0].commandId, region: c.events[0].region, reason: c.events[0].reason },
    { type: 'action-done', phase: 'interrupted', commandId: a.commandId, region: 'hands', reason: 'preempted' },
  );
  // 按手臂收尾：只关共用右臂的竖手指
  assert.deepEqual(c.plan[0].closeFirst, ['竖手指关闭']);
  const s = b.snapshot({ now: 1300 });
  assert.equal(s.regions.hands.commandId, c.commandId);
  assert.equal(s.regions.torso.commandId, a.commandId);
});
test('收尾只关共用手臂的：抚胸手（左臂）开着时打开狗尾巴草不关它', () => {
  const b = rejectBridge(table);
  const r = b.act({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, { now: 0, slots: { 抚胸手: 'open', 竖手指: 'open', 狗尾巴草: 'closed' } });
  assert.deepEqual(r.plan[0].closeFirst, ['竖手指关闭']);
  const r2 = rejectBridge(table).act({ steps: [{ region: 'hands', motion: '抚胸手打开' }] }, { now: 0, slots: { 竖手指: 'open' } });
  assert.deepEqual(r2.plan[0].closeFirst, []);
});
test('注入 shareArm 时用注入实现（overlay 注入渲染端 motionsShareArm）', () => {
  const calls = [];
  const b = rejectBridge(table, { shareArm: (x, y) => { calls.push([x, y]); return false; } });
  const r = b.act({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, { now: 0, slots: { 竖手指: 'open' } });
  assert.deepEqual(r.plan[0].closeFirst, []);
  assert.deepEqual(calls, [['竖手指打开', '狗尾巴草打开']]);
});
test('complete：每模块完成发 action-done 带 commandId 与 region；迟到回调 settled=false', () => {
  const b = rejectBridge(table);
  const a = b.act({ steps: [{ region: 'hands', motion: '竖手指打开' }, { layer: 'expression', expression: '脸红' }] }, NOW);
  const d1 = b.complete(a.commandId, 'expression', 'end');
  assert.equal(d1.settled, true);
  assert.deepEqual(d1.events[0], { type: 'action-done', phase: 'end', commandId: a.commandId, runId: a.commandId, layer: 'expression' });
  const d2 = b.complete(a.commandId, 'hands', 'end');
  assert.equal(d2.events[0].region, 'hands');
  assert.equal(b.snapshot(NOW).regions.hands.busy, false);
  assert.equal(b.complete(a.commandId, 'hands', 'end').settled, false);
  // 被抢占后的迟到完成不结算、不误释放新占用者
  const x = b.act({ steps: [{ region: 'hands', motion: '抚胸手打开' }] }, NOW);
  const y = b.act({ priority: 'FORCE', steps: [{ region: 'hands', motion: '抚胸手关闭' }] }, NOW);
  assert.equal(b.complete(x.commandId, 'hands', 'end').settled, false);
  assert.equal(b.snapshot(NOW).regions.hands.commandId, y.commandId);
});
test('release 按 commandId 一次释放该指令全部模块；按 region 只释放一个', () => {
  const b = rejectBridge(table);
  const a = b.act({ steps: [{ region: 'torso', set: { LeanInput: -1 }, durationMs: 9000 }, { region: 'hair', set: { Param137: 1 }, durationMs: 9000 }, { region: 'legs', set: { Clothes4: 1 }, durationMs: 9000 }] }, NOW);
  const r1 = b.release({ region: 'legs' }, NOW);
  assert.deepEqual(r1.released, [{ target: 'legs', commandId: a.commandId }]);
  assert.equal(r1.events[0].reason, 'released');
  assert.equal(r1.events[0].phase, 'interrupted');
  const r2 = b.release({ commandId: a.commandId }, NOW);
  assert.deepEqual(r2.released.map((x) => x.target).sort(), ['hair', 'torso']);
  const s = b.snapshot(NOW);
  for (const n of ['torso', 'hair', 'legs']) assert.equal(s.regions[n].busy, false);
  assert.equal(b.release({ commandId: 'bc-999' }, NOW).reason, 'not-found');
  assert.equal(b.release({ region: 'tail' }, NOW).reason, 'unknown-region');
  assert.equal(b.release({}, NOW).reason, 'invalid-command');
});

// ------------------------------------------------------------------ onBusy wait
test("onBusy:'wait'：排队，前一条完成后出队执行", () => {
  const b = rejectBridge(table);
  const a = b.act({ steps: [{ region: 'hands', motion: '竖手指打开' }] }, { now: 0 });
  const q = b.act({ onBusy: 'wait', waitMs: 2000, steps: [{ region: 'hands', motion: '竖手指关闭' }] }, { now: 10 });
  assert.equal(q.ok, true);
  assert.equal(q.queued, true);
  assert.match(q.ticket, /^bw-/);
  assert.equal(b.snapshot({ now: 20 }).queue.length, 1);
  const done = b.complete(a.commandId, 'hands', 'end', undefined, { now: 500, slots: { 竖手指: 'open' } });
  assert.equal(done.admitted.length, 1);
  assert.equal(done.admitted[0].ticket, q.ticket);
  assert.equal(done.admitted[0].waitedMs, 490);
  assert.equal(b.snapshot({ now: 600 }).regions.hands.commandId, done.admitted[0].commandId);
});
test("onBusy:'wait' 超时：frame 推进到 waitMs 后判 region-busy timeout", () => {
  const b = rejectBridge(table);
  b.act({ priority: 'FORCE', steps: [{ region: 'torso', set: { LeanInput: -1 }, durationMs: 9000 }] }, { now: 0 });
  const q = b.act({ onBusy: 'wait', waitMs: 300, steps: [{ region: 'torso', set: { PositionX: 1 } }] }, { now: 0 });
  assert.equal(b.frame({ now: 200 }).expired.length, 0);
  const f = b.frame({ now: 301 });
  assert.equal(f.expired.length, 1);
  assert.equal(f.expired[0].ticket, q.ticket);
  assert.equal(f.expired[0].reason, 'region-busy');
  assert.equal(f.expired[0].timeout, true);
  assert.equal(b.snapshot({ now: 302 }).queue.length, 0);
});
test("onBusy 缺省 reject：不排队", () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 1000 }] }, { now: 0 });
  const r = b.act({ steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, { now: 1 });
  assert.equal(r.ok, false);
  assert.equal(b.snapshot({ now: 2 }).queue.length, 0);
});
test('release 排队中的 ticket = 出队', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 1000 }] }, { now: 0 });
  const q = b.act({ onBusy: 'wait', steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, { now: 1 });
  assert.equal(b.release({ commandId: q.ticket }, { now: 2 }).dequeued, q.ticket);
  assert.equal(b.snapshot({ now: 3 }).queue.length, 0);
});

// ------------------------------------------------------------------ set 插值（每帧推进）
test('set 插值：durationMs 内每帧推进，到头发 end 并释放模块；叠加参数从 0 偏移起插', () => {
  const b = rejectBridge(table);
  const a = b.act({ steps: [{ region: 'torso', set: { LeanInput: -10 }, durationMs: 1000 }] }, { now: 0 });
  const f0 = b.frame({ now: 0 });
  assert.equal(f0.writes.LeanInput, 0);
  const f1 = b.frame({ now: 500 });
  assert.ok(Math.abs(f1.writes.LeanInput - -5) < 1e-9, String(f1.writes.LeanInput));
  assert.equal(f1.events.length, 0);
  const f2 = b.frame({ now: 1000 });
  assert.equal(f2.writes.LeanInput, -10);
  assert.equal(f2.events[0].phase, 'end');
  assert.equal(f2.events[0].region, 'torso');
  assert.equal(f2.events[0].commandId, a.commandId);
  assert.equal(b.snapshot({ now: 1001 }).regions.torso.busy, false);
  // 到头后不再每帧写（渲染端粘滞保持）
  assert.deepEqual(b.frame({ now: 1100 }).writes, {});
  // 下一条从上一次写出的偏移 -10 起插
  b.act({ steps: [{ region: 'torso', set: { LeanInput: 0 }, durationMs: 100 }] }, { now: 2000 });
  assert.equal(b.frame({ now: 2000 }).writes.LeanInput, -10);
});
test('set 插值：非叠加参数从当前读数起插；durationMs=0 当帧到位', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'hair', set: { Param137: 1 }, durationMs: 200 }] }, { now: 0, read: (ids) => ({ [ids[0]]: 0.2 }) });
  assert.equal(b.frame({ now: 0 }).writes.Param137, 0.2);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 } }] }, { now: 0 });
  const f = b.frame({ now: 0 });
  assert.equal(f.writes.Clothes4, 1);
  assert.ok(f.events.some((e) => e.region === 'legs' && e.phase === 'end'));
});
test('被抢占的插值立刻停写，新占用者接管', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'torso', set: { PositionX: 5 }, durationMs: 1000 }] }, { now: 0 });
  b.frame({ now: 100 });
  b.act({ priority: 'FORCE', steps: [{ region: 'torso', set: { LeanInput: -3 } }] }, { now: 200 });
  const f = b.frame({ now: 300 });
  assert.equal(f.writes.PositionX, undefined);
  assert.equal(f.writes.LeanInput, -3);
});

// ------------------------------------------------------------------ 表情层 / 前倾 / 脱鞋
test('表情层只在互斥组内判冲突：仍在执行的同级指令持有眼型 → expression-conflict', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'hands', motion: '竖手指打开' }, { layer: 'expression', expression: '圈圈眼' }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '爱心眼' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expression-conflict');
  // 不同组（脸红）不冲突，但渲染端是单槽 → 警告
  const ok = b.act({ steps: [{ layer: 'expression', expression: '脸红' }] }, NOW);
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some((w) => w.startsWith('expression-single-slot')));
  // 更高优先级可以换掉眼型
  const b2 = rejectBridge(table);
  b2.act({ steps: [{ region: 'hands', motion: '竖手指打开' }, { layer: 'expression', expression: '圈圈眼' }] }, NOW);
  const hi = b2.act({ priority: 'HIGH', steps: [{ layer: 'expression', expression: '爱心眼' }] }, NOW);
  assert.equal(hi.ok, true);
  assert.equal(hi.plan[0].replaces, '圈圈眼');
});
test('持有眼型的指令已结束 → 同级可以替换（先淡出旧的由渲染端单槽完成）', () => {
  const b = rejectBridge(table);
  const a = b.act({ steps: [{ layer: 'expression', expression: '圈圈眼' }] }, NOW);
  b.complete(a.commandId, 'expression', 'end');
  const r = b.act({ steps: [{ layer: 'expression', expression: '＞＜' }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.plan[0].replaces, '圈圈眼');
});
test('前倾 vs 躯干直写：躯干优先（同级时前倾被拒，原因 expression-conflict）', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'torso', set: { LeanInput: -5 }, durationMs: 2000 }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '前倾' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expression-conflict');
  assert.equal(r.busy[0].convertedFrom, '前倾');
});
test('脱鞋 vs 腿部直写：腿部优先', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 0 }, durationMs: 2000 }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '脱鞋' }] }, NOW);
  assert.equal(r.reason, 'expression-conflict');
  // 腿部空闲时脱鞋就是一条 legs 指令
  const b2 = rejectBridge(table);
  const ok = b2.act({ steps: [{ layer: 'expression', expression: '脱鞋' }] }, NOW);
  assert.deepEqual(ok.accepted, ['legs']);
  assert.deepEqual(ok.plan[0].set, { Clothes4: 1 });
});
test('裙长切换 vs 躯干正在直写 Clothes1：模块优先', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ region: 'torso', set: { Clothes1: 0.3 }, durationMs: 2000 }] }, NOW);
  assert.equal(b.act({ steps: [{ layer: 'expression', expression: '裙长切换' }] }, NOW).reason, 'expression-conflict');
  // 参数归躯干：躯干被占（哪怕在写别的参数）时裙长切换也要等躯干，高优先级可抢
  const b2 = rejectBridge(table);
  b2.act({ steps: [{ region: 'torso', set: { PositionX: 1 }, durationMs: 2000 }] }, NOW);
  assert.equal(b2.act({ steps: [{ layer: 'expression', expression: '裙长切换' }] }, NOW).reason, 'expression-conflict');
  assert.equal(b2.act({ priority: 'HIGH', steps: [{ layer: 'expression', expression: '裙长切换' }] }, NOW).ok, true);
});
test('形态层：当前是体型表情时，形态指令清掉它（形态优先）', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '体型1' }] }, NOW);
  const r = b.act({ steps: [{ layer: 'form', form: 2 }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.plan[0].clearExpression, true);
  assert.equal(b.snapshot(NOW).expression, null);
});
test('表情 on:false：只在它是当前表情时标记 wasActive', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '脸红' }] }, NOW);
  const off = b.act({ steps: [{ layer: 'expression', expression: '流泪', on: false }] }, NOW);
  assert.equal(off.plan[0].wasActive, false);
  const off2 = b.act({ steps: [{ layer: 'expression', expression: '脸红', on: false }] }, NOW);
  assert.equal(off2.plan[0].wasActive, true);
  assert.equal(b.snapshot(NOW).expression, null);
});

// ------------------------------------------------------------------ 饰品层（全部可同时穿戴）
test('饰品：只暴露有可切换项的槽；兽耳、翅膀、uncertain、体型不暴露', () => {
  const slots = compiled.accessorySlots.map((s) => s.id);
  assert.ok(!slots.includes('ears') && !slots.includes('wings'));
  for (const s of ['glasses', 'headwear', 'tail', 'shoes', 'skirt', 'chest-clothes', 'flowers', 'glints']) assert.ok(slots.includes(s), s);
  for (const it of compiled.accessoryItems.values()) assert.ok(!['体型1', '体型2', '默认体型'].includes(it.expression));
  const uncertain = table.accessories.uncertain.flatMap((u) => u.params);
  for (const it of compiled.accessoryItems.values()) assert.ok(!uncertain.includes(it.param), it.id);
  // 鞋 / 裙长 / 胸口衣服 参数归模块；眼镜 / 钢盆 / 尾巴 走表情层；飘花等直写参数
  assert.equal(compiled.accessoryItems.get('shoes-off').via, 'region');
  assert.equal(compiled.accessoryItems.get('shoes-off').region, 'legs');
  assert.equal(compiled.accessoryItems.get('skirt-toggle').region, 'torso');
  assert.equal(compiled.accessoryItems.get('chest-clothes').region, 'torso');
  for (const id of ['monocle', 'black-glasses', 'basin', 'tail']) assert.equal(compiled.accessoryItems.get(id).via, 'expression', id);
  assert.equal(compiled.accessoryItems.get('flower-1').via, 'param');
  const d = describeRegions(compiled);
  assert.equal(d.accessory.compatibility, 'all-compatible');
  assert.ok(d.accessory.slots.every((s) => s.items.length > 0));
});
test('饰品参数不能经模块 set 直写；未知饰品 / 槽不符拒绝', () => {
  assert.equal(v({ steps: [{ region: 'face', set: { LittleFlower2: 1 } }] }).reason, 'param-not-writable');
  assert.equal(v({ steps: [{ layer: 'accessory', item: 'wings' }] }).reason, 'unknown-accessory');
  assert.equal(v({ steps: [{ layer: 'accessory', item: 'monocle', slot: 'headwear' }] }).reason, 'unknown-accessory');
  assert.equal(v({ steps: [{ layer: 'accessory', item: 'monocle', on: 'yes' }] }).reason, 'invalid-step');
});
test('多件同时佩戴：两副眼镜 + 钢盆 + 两朵飘花同一条全部受理，互不摘除', () => {
  const b = rejectBridge(table);
  const r = b.act({ steps: [
    { layer: 'accessory', slot: 'glasses', item: 'monocle' },
    { layer: 'accessory', slot: 'glasses', item: 'black-glasses' },
    { layer: 'accessory', item: 'basin' },
    { layer: 'accessory', item: 'flower-1' },
    { layer: 'accessory', item: 'flower-2' },
  ] }, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.filter((p) => p.kind === 'accessory' && p.on === false).length, 0, '戴新的不摘旧的');
  const f = b.frame({ now: 1000 + 400 });
  assert.equal(f.writes.key12, 1);
  assert.equal(f.writes.key11, 1);
  assert.equal(f.writes.key10, 1);
  assert.equal(f.writes.LittleFlower2, 1);
  assert.equal(f.writes.LittleFlower4, 1);
  const snap = b.snapshot({ now: 1400 });
  const glasses = snap.accessories.find((s) => s.slot === 'glasses');
  assert.deepEqual(glasses.worn.sort(), ['black-glasses', 'monocle']);
  // 再分两条戴：后一条不影响前一条
  const b2 = rejectBridge(table);
  b2.act({ steps: [{ layer: 'accessory', item: 'monocle' }] }, NOW);
  b2.frame({ now: 1400 });
  const r2 = b2.act({ steps: [{ layer: 'accessory', item: 'black-glasses' }] }, { now: 1500 });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.plan.map((p) => p.item), ['black-glasses']);
  assert.deepEqual(b2.snapshot({ now: 1500 }).accessories.find((s) => s.slot === 'glasses').worn.sort(), ['black-glasses', 'monocle']);
});
test('单件关闭：只写它自己的 off 值（表情类淡出），其他饰品不动', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ layer: 'accessory', item: 'monocle' }, { layer: 'accessory', item: 'black-glasses' }, { layer: 'accessory', item: 'flower-1' }] }, NOW);
  b.frame({ now: 1400 });
  const off = b.act({ steps: [{ layer: 'accessory', item: 'monocle', on: false }] }, { now: 2000, read: () => ({ key12: 1 }) });
  assert.equal(off.ok, true);
  const mid = b.frame({ now: 2150 });
  assert.deepEqual(Object.keys(mid.writes), ['key12'], '只写被关的那件');
  assert.ok(mid.writes.key12 > 0 && mid.writes.key12 < 1, '表情类饰品淡出');
  const end = b.frame({ now: 2300 });
  assert.equal(end.writes.key12, 0);
  assert.ok(end.events.some((e) => e.type === 'action-done' && e.layer === 'accessory' && e.item === 'monocle' && e.phase === 'end'));
  const snap = b.snapshot({ now: 2300 });
  assert.deepEqual(snap.accessories.find((s) => s.slot === 'glasses').worn, ['black-glasses']);
  assert.deepEqual(snap.accessories.find((s) => s.slot === 'flowers').worn, ['flower-1']);
  // 参数开关类缺省不淡出
  const p = b.act({ steps: [{ layer: 'accessory', item: 'flower-1', on: false }] }, { now: 3000 });
  assert.equal(p.plan[0].durationMs, 0);
  assert.equal(b.frame({ now: 3000 }).writes.LittleFlower2, 0);
});
test('饰品不判冲突、不占模块：与脸部表情、眼型表情、模块动作同时成立', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '圈圈眼' }, { region: 'face', set: { EyeSmile: 1 }, durationMs: 2000 }] }, NOW);
  const r = b.act({ steps: [{ layer: 'accessory', item: 'monocle' }, { layer: 'accessory', item: 'tail', on: false }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(b.snapshot(NOW).expression.name, '圈圈眼', '饰品表情不替换脸部表情');
  assert.equal(b.snapshot(NOW).regions.face.busy, true);
});
test('旧表情名（单片眼镜 / 尾巴开关）按饰品处理：不进单槽表情，尾巴开关=尾巴 off', () => {
  const b = rejectBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '脸红' }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '单片眼镜' }, { layer: 'expression', expression: '黑框眼镜' }, { layer: 'expression', expression: '尾巴开关' }] }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.map((p) => p.kind), ['accessory', 'accessory', 'accessory']);
  assert.equal(r.plan[2].item, 'tail');
  assert.equal(r.plan[2].on, false);
  assert.equal(r.plan[2].value, -1);
  assert.equal(b.snapshot(NOW).expression.name, '脸红');
  assert.ok(!describeRegions(compiled).expression.expressions.includes('单片眼镜'));
});
test('鞋 / 裙长 / 胸口衣服：转成腿部 / 躯干 set，模块仲裁照旧；佩戴状态同步', () => {
  const b = rejectBridge(table);
  const r = b.act({ steps: [{ layer: 'accessory', item: 'shoes-off' }, { layer: 'accessory', item: 'chest-clothes' }] }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.accepted.sort(), ['legs', 'torso']);
  assert.deepEqual(r.plan.find((p) => p.region === 'legs').set, { Clothes4: 1 });
  assert.deepEqual(r.plan.find((p) => p.region === 'torso').set, { Clothes3: 1 });
  // 躯干被同级占着：裙长要等躯干
  const b2 = rejectBridge(table);
  b2.act({ steps: [{ region: 'torso', set: { PositionX: 1 }, durationMs: 2000 }] }, NOW);
  const busy = b2.act({ steps: [{ layer: 'accessory', item: 'skirt-toggle' }] }, NOW);
  assert.equal(busy.ok, false);
  // 腿部直写 Clothes4=1 也会同步「脱鞋」佩戴状态
  const b3 = rejectBridge(table);
  b3.act({ steps: [{ region: 'legs', set: { Clothes4: 1 } }] }, NOW);
  assert.deepEqual(b3.snapshot(NOW).accessories.find((s) => s.slot === 'shoes').worn, ['shoes-off']);
});
test('state：无记录时按读数判断佩戴（尾巴默认 Clothes5=1 视为戴着）', () => {
  const b = rejectBridge(table);
  const snap = b.snapshot({ now: 0, read: () => ({ Clothes5: 1, key12: 0 }) });
  const tail = snap.accessories.find((s) => s.slot === 'tail').items[0];
  assert.equal(tail.worn, true);
  assert.equal(tail.stateFrom, 'read');
  assert.equal(snap.accessories.find((s) => s.slot === 'glasses').items[0].worn, false);
});

// ------------------------------------------------------------------ 神态组合（face-units.json / face-vocab.json）
import { pickFaceUnitsFile, compileFaceUnits, composeFace, describeFace, FACE_UNITS_FILES } from './body-bridge.mjs';
const MODEL_DIR = path.resolve(here, '../../../docs/nodegraph/models/大肥鱼.dsl2d.2048');
const faceFileName = pickFaceUnitsFile((n) => fs.existsSync(path.join(MODEL_DIR, n)));
const faceFile = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, faceFileName), 'utf8'));
const fc = compileFaceUnits(compiled, faceFile);
const fb = (opts = {}) => rejectBridge(table, { faceUnits: faceFile, random: () => 0, ...opts });
const val = (c, id) => (c.params.find((p) => p.id === id) || {}).value;

test('pickFaceUnitsFile：先 face-units.json，没有再 face-vocab.json，都没有 null', () => {
  assert.deepEqual(FACE_UNITS_FILES, ['face-units.json', 'face-vocab.json']);
  assert.equal(pickFaceUnitsFile((n) => n === 'face-vocab.json'), 'face-vocab.json');
  assert.equal(pickFaceUnitsFile(() => true), 'face-units.json');
  assert.equal(pickFaceUnitsFile(() => false), null);
  assert.ok(faceFileName, '仓库里应有神态数据文件');
});
test('部件表编译：20 参数、20 部件 + 3 表情型、13 维度；路由按 body-regions', () => {
  assert.equal(fc.params.size, 20);
  assert.equal(fc.units.size, 20);
  assert.equal(fc.exprUnits.size, 3);
  assert.equal(fc.dimensions.size, 13);
  assert.ok(fc.negativeUnits.has('head_turn'));
  for (const id of ['AngleX', 'AngleY', 'AngleZ']) assert.equal(fc.routeOf(id).region, 'face', id + ' 在 body-regions 里归 face');
  assert.equal(fc.routeOf('LeanInput').region, 'torso');
  assert.equal(fc.routeOf('ParamMouthForm').blocked, 'lipsync-redline');
  for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ']) assert.ok(fc.neverWrite.has(id));
  assert.equal(fc.routeOf('ParamMouthOpenY').blocked, 'lipsync-redline');
});
test('compose：加权叠加、限幅、相反部件抵消；written 带 meaning 与 contributions', () => {
  const c = composeFace(fc, { units: { eye_narrow: 1 } });
  assert.equal(val(c, 'ParamEyeLOpen'), 0.5);
  const both = composeFace(fc, { units: { brow_up: 0.5, brow_down: 0.5 } });
  assert.ok(Math.abs(val(both, 'ParamBrowLY')) < 1e-12, '扬眉与压眉同权抵消');
  const big = composeFace(fc, { units: { eye_wide: 1, eye_smile: 1 } });
  assert.ok(val(big, 'ParamEyeLOpen') <= 1.5);
  const sat = composeFace(fc, { units: { brow_up: 1 }, dimensions: { 惊讶: 1 } });
  assert.equal(sat.units.brow_up, 1, '部件权重夹到 1');
  const v = composeView(composeFace(fc, { units: { eye_smile: 0.5, eye_narrow: 0.5 } }));
  const eye = v.written.find((x) => x.param === 'ParamEyeLOpen');
  assert.equal(eye.meaning, '左眼睁开程度');
  assert.deepEqual(eye.contributions.map((x) => x.unit).sort(), ['eye_narrow', 'eye_smile']);
  assert.ok(Math.abs(eye.value - (1 + 0.5 * (0.7 - 1) + 0.5 * (0.5 - 1))) < 1e-12);
});
test('compose：smile 写 ParamMouthForm 被 blocked（lipsync-redline），同部件其余参数照写', () => {
  const v = composeView(composeFace(fc, { units: { smile: 1 } }));
  assert.deepEqual(v.blocked.map((b) => [b.param, b.reason]), [['ParamMouthForm', 'lipsync-redline']]);
  assert.ok(v.written.some((x) => x.param === 'MouthSmile_L'));
  assert.ok(!v.written.some((x) => x.param === 'ParamMouthForm' || x.param === 'ParamMouthOpenY'));
});
test('compose：side 统一侧向；R 时 lateral 取反、mirror 交换左右', () => {
  const L = composeFace(fc, { units: { gaze_side: 1, smirk: 1, head_tilt: 1 }, side: 'L' });
  const R = composeFace(fc, { units: { gaze_side: 1, smirk: 1, head_tilt: 1 }, side: 'R' });
  assert.equal(val(L, 'ParamEyeBallX'), 0.7);
  assert.equal(val(R, 'ParamEyeBallX'), -0.7);
  assert.equal(val(L, 'AngleZ'), 15);
  assert.equal(val(R, 'AngleZ'), -15);
  assert.equal(val(L, 'MouthSmile_L'), 0.7);
  assert.equal(val(R, 'MouthSmile_R'), 0.7, 'mirror：R 时左右交换');
  assert.ok(Math.abs(val(R, 'MouthSmile_L') - 0.1) < 1e-12);
  assert.equal(val(R, 'MouthX'), -0.3);
  assert.equal(composeFace(fc, { units: { gaze_side: 1 }, side: 'X' }).ok, false);
});
test('compose：维度对象形式 {慵懒:0.6, 挑逗:0.7}；部件权重 = Σ 强度 × 维度权重；energy 加权平均', () => {
  const c = composeFace(fc, { dimensions: { 慵懒: 0.6, 挑逗: 0.7 } });
  assert.equal(c.ok, true);
  assert.ok(Math.abs(c.units.eye_narrow - 0.36) < 1e-12);
  assert.ok(Math.abs(c.units.head_tilt - (0.6 * 0.4 + 0.7 * 0.4)) < 1e-12);
  assert.ok(Math.abs(c.energy - (0.6 * 0.15 + 0.7 * 0.4) / 1.3) < 1e-12);
  // 数组形式等价
  const arr = composeFace(fc, { dimensions: [{ dimension: '慵懒', intensity: 0.6 }, { dimension: '挑逗', intensity: 0.7 }] });
  assert.deepEqual(arr.units, c.units);
  // units 数组形式 + 与维度相加
  const mix = composeFace(fc, { units: [{ unit: 'pout', intensity: 0.5 }], dimensions: { 撒娇: 0.2 } });
  assert.ok(Math.abs(mix.units.pout - (0.5 + 0.2 * 0.8)) < 1e-12);
  assert.equal(composeFace(fc, { dimensions: { 不存在: 1 } }).errors[0].reason, 'unknown-dimension');
  assert.equal(composeFace(fc, { units: { nope: 1 } }).errors[0].reason, 'unknown-face-unit');
  // 显式 energy 以调用方为准
  assert.equal(composeFace(fc, { dimensions: { 慵懒: 1 }, energy: 0.9 }).energy, 0.9);
});
test('compose：维度强度 ≥ expressionAt 自动开表情；表情型部件转表情层；配方按比例混合', () => {
  assert.deepEqual(composeFace(fc, { dimensions: { 害羞: 0.2 } }).expressions.map((e) => e.name), ['脸红']);
  assert.deepEqual(composeFace(fc, { dimensions: { 害羞: 0.1 } }).expressions, []);
  assert.deepEqual(composeFace(fc, { dimensions: { 委屈: 0.7 } }).expressions, []);
  assert.deepEqual(composeFace(fc, { units: { tears: 1 } }).expressions.map((e) => e.name), ['流泪']);
  const mix = composeFace(fc, { recipes: { 害羞: 0.7, 得意: 0.3 } });
  assert.ok(Math.abs(mix.units.gaze_down - 0.7 * 0.8) < 1e-12);
  assert.ok(Math.abs(mix.units.smirk - 0.3 * 0.8) < 1e-12);
  assert.ok(Math.abs(mix.energy - (0.7 * 0.5 + 0.3 * 0.4)) < 1e-12);
});
test('compose：energy 越高摆幅越大、周期越短', () => {
  const lo = composeFace(fc, { units: { eye_smile: 1 }, energy: 0 });
  const hi = composeFace(fc, { units: { eye_smile: 1 }, energy: 1 });
  const a = lo.params.find((p) => p.id === 'EyeSmile');
  const b = hi.params.find((p) => p.id === 'EyeSmile');
  assert.ok(Math.abs(a.amp - 1 * 0.03 * 0.5) < 1e-12);
  assert.ok(b.amp > a.amp && b.periodMs < a.periodMs);
});
test('compose 步骤：占 face；lean_in（LeanInput）一起占 torso；表情走表情层', () => {
  const b = fb();
  const r = b.act({ steps: [{ region: 'face', compose: { dimensions: { 着迷: 1 } } }] }, { now: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.accepted.sort(), ['expression', 'face', 'torso']);
  assert.ok(r.compose.written.some((x) => x.param === 'LeanInput' && x.region === 'torso'));
  assert.equal(r.plan.find((p) => p.kind === 'expression').expression, '爱心眼');
  const snap = b.snapshot({ now: 0 });
  assert.equal(snap.regions.torso.busy, true);
  assert.equal(snap.compose.face.label, 'compose');
});
test('compose 步骤：torso 被更高优先级占着 → 跳过 LeanInput 记 blocked，face 其余照常', () => {
  const b = fb();
  b.act({ priority: 'HIGH', steps: [{ region: 'torso', set: { PositionX: 1 }, durationMs: 5000 }] }, { now: 0 });
  const r = b.act({ steps: [{ region: 'face', compose: { dimensions: { 着迷: 1 } } }] }, { now: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.accepted.sort(), ['expression', 'face']);
  const lb = r.compose.blocked.find((x) => x.param === 'LeanInput');
  assert.equal(lb.reason, 'region-busy');
  assert.equal(lb.region, 'torso');
  assert.deepEqual(lb.units, ['lean_in']);
  assert.ok(r.compose.written.some((x) => x.param === 'MouthSmile_L'));
  assert.ok(!r.compose.written.some((x) => x.param === 'LeanInput'));
  // 低优先级占着 torso → 抢过来
  const b2 = fb();
  b2.act({ priority: 'LOW', steps: [{ region: 'torso', set: { PositionX: 1 }, durationMs: 5000 }] }, { now: 0 });
  const r2 = b2.act({ steps: [{ region: 'face', compose: { units: { lean_in: 1 } } }] }, { now: 0 });
  assert.deepEqual(r2.preempted.map((p) => p.region), ['torso']);
  // 同条显式 torso 步 → LeanInput 记 duplicate-region
  const r3 = fb().act({ steps: [{ region: 'face', compose: { units: { lean_in: 1, smile: 1 } } }, { region: 'torso', set: { PositionX: 1 } }] }, { now: 0 });
  assert.equal(r3.ok, true);
  assert.equal(r3.compose.blocked.find((x) => x.param === 'LeanInput').reason, 'duplicate-region');
});
test('compose 运行：1000ms 渐入，之后 value + amp·sin；眨眼乘在睁眼值上不拉回全睁', () => {
  const b = fb();
  const r = b.act({ steps: [{ region: 'face', compose: { units: { eye_narrow: 1, eye_smile: 0.2 }, energy: 0.5 } }] }, { now: 0, read: () => ({ ParamEyeLOpen: 1, EyeSmile: 0 }) });
  const target = r.compose.written.find((x) => x.param === 'ParamEyeLOpen').value;
  const half = b.frame({ now: 500 });
  assert.ok(half.writes.ParamEyeLOpen < 1 && half.writes.ParamEyeLOpen > target);
  assert.equal(b.frame({ now: 1000 }).writes.ParamEyeLOpen, target);
  const amp = 1.5 * 0.03 * 1;
  let min = Infinity;
  let max = 0;
  for (let t = 1000; t <= 5000; t += 10) {
    const w = b.frame({ now: t }).writes.ParamEyeLOpen;
    assert.ok(w <= target + amp + 1e-9, '不能超过 value+amp（不会拉回全睁）');
    min = Math.min(min, w);
    max = Math.max(max, w);
  }
  assert.equal(min, 0, '眨眼闭到 0');
  assert.ok(max > target);
});
test('compose 持续到 release；退出 600ms 渐回 neutral 后 neutral 中和；holdMs 到点自动结束', () => {
  const b = fb();
  const r = b.act({ steps: [{ region: 'face', compose: { units: { eye_smile: 1 }, energy: 0 } }] }, { now: 0, read: () => ({ EyeSmile: 0 }) });
  for (let t = 0; t <= 20000; t += 1000) b.frame({ now: t });
  assert.equal(b.snapshot({ now: 20000 }).regions.face.busy, true);
  const rel = b.release({ commandId: r.commandId }, { now: 20000 });
  assert.ok(rel.events.some((e) => e.region === 'face' && e.phase === 'interrupted' && e.compose === 'compose'));
  const mid = b.frame({ now: 20300 });
  assert.ok(mid.writes.EyeSmile > 0 && mid.writes.EyeSmile < 1);
  const end = b.frame({ now: 20600 });
  assert.ok(end.neutral.includes('EyeSmile'));
  assert.equal(b.busy(), false);
  const b2 = fb();
  b2.act({ steps: [{ region: 'face', compose: { units: { smile: 1 }, holdMs: 2000 } }] }, { now: 0 });
  b2.frame({ now: 1000 });
  const done = b2.frame({ now: 3000 });
  assert.ok(done.events.some((e) => e.region === 'face' && e.phase === 'end'));
});
test('compose 被更高优先级 face 指令抢占：只收尾 face（torso 部分不动）', () => {
  const b = fb();
  b.act({ steps: [{ region: 'face', compose: { units: { lean_in: 1, eye_smile: 1 } } }] }, { now: 0 });
  b.frame({ now: 1500 });
  const r = b.act({ priority: 'HIGH', steps: [{ region: 'face', set: { EyeSmile: 0 } }] }, { now: 1500 });
  assert.deepEqual(r.preempted.map((p) => p.region), ['face']);
  const snap = b.snapshot({ now: 1500 });
  assert.equal(snap.regions.torso.busy, true);
  assert.ok(snap.compose.torso);
  assert.ok(!snap.compose.face);
});
test('mood 步骤映射到配方：{mood:"妩媚"} = compose:{recipes:{妩媚:1}}', () => {
  const b = fb();
  const r = b.act({ steps: [{ region: 'face', mood: '妩媚' }] }, { now: 0 });
  assert.equal(r.ok, true);
  assert.equal(b.snapshot({ now: 0 }).compose.face.label, '妩媚');
  assert.ok(r.plan.some((p) => p.expression === '脸红'));
  assert.equal(fb().act({ steps: [{ region: 'face', mood: '不存在' }] }, { now: 0 }).reason, 'unknown-mood');
  assert.equal(rejectBridge(table).act({ steps: [{ region: 'face', compose: { units: { smile: 1 } } }] }, { now: 0 }).reason, 'face-units-unavailable');
});
test('describe：由 compose 结果反推部件强度（非负最小二乘，侧向自动判断）', () => {
  const c = composeFace(fc, { units: { eye_narrow: 0.7, gaze_side: 0.6, chin_down: 0.5 }, side: 'R' });
  const values = Object.fromEntries(c.params.map((p) => [p.id, p.value]));
  for (const [id, m] of fc.params) if (!(id in values)) values[id] = m.neutral;
  const d = describeFace(fc, values, { activeExpressions: ['脸红'] });
  assert.equal(d.ok, true);
  assert.equal(d.side, 'R');
  const w = Object.fromEntries(d.units.map((x) => [x.unit, x.weight]));
  assert.ok(Math.abs(w.gaze_side - 0.6) < 0.02, JSON.stringify(d.units));
  assert.ok(Math.abs(w.chin_down - 0.5) < 0.02);
  assert.ok(w.eye_narrow > 0.5);
  assert.equal(w.blush, 1);
  assert.ok(d.summary.includes('斜睨'));
});

// ------------------------------------------------------------------ 动作衔接（onBusy:'blend'，cut: now|next|after）
import { compileMotionCuts } from './body-bridge.mjs';
const cutsFile = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'motion-cutpoints.json'), 'utf8'));
const cb = (opts = {}) => createBridge(table, { motionCuts: cutsFile, ...opts });
const handsAct = (b, motion, now, extra = {}, slots) => b.act({ ...extra, steps: [{ region: 'hands', motion }] }, { now, slots: slots || {} });

test('motion-cutpoints.json 编译：毫秒、手势状态图；cut 只认 now|next|after', () => {
  const c = compileMotionCuts(cutsFile);
  assert.deepEqual([c.motions.get('抚胸手关闭').abortBeforeMs, c.motions.get('抚胸手关闭').chainFromMs], [550, 550]);
  assert.equal(c.motions.get('Idle').anytime, true);
  assert.deepEqual(c.gestures.states, ['默认', '抚胸', '竖手指', '狗尾巴草']);
  assert.deepEqual(c.gestures.edges.get('抚胸→竖手指'), ['抚胸手关闭', '竖手指打开']);
  assert.deepEqual(c.gestures.motionEdge.get('竖手指打开'), { from: '默认', to: '竖手指' });
  assert.equal(v({ cut: 'next-cut', steps: [{ region: 'hands', motion: '竖手指打开' }] }).reason, 'invalid-command');
  assert.equal(v({ when: 'now', steps: [{ region: 'hands', motion: '竖手指打开' }] }).command.cut, 'next', 'when 不是别名');
  assert.equal(v({ fadeMs: 1000, steps: [{ region: 'hands', motion: '竖手指打开' }] }).command.fadeMs, 400);
  assert.equal(v({ fadeMs: 50, steps: [{ region: 'hands', motion: '竖手指打开' }] }).command.fadeMs, 200);
  // 缺数据文件安全降级
  assert.equal(compileMotionCuts(null).gestures, null);
});
test('手势路径：抚胸→竖手指必经「抚胸手关闭」，在它的 chainFrom(550ms) 接「竖手指打开」；从默认直接开', () => {
  const b = cb();
  const r = handsAct(b, '竖手指打开', 0, {}, { 抚胸手: 'open' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.plan[0].chain, [{ motion: '抚胸手关闭', offsetMs: 0 }, { motion: '竖手指打开', offsetMs: 550 }]);
  assert.deepEqual(r.gesture, { from: '抚胸', to: '竖手指' });
  const b2 = cb();
  assert.deepEqual(handsAct(b2, '竖手指打开', 0).plan[0].chain, [{ motion: '竖手指打开', offsetMs: 0 }]);
  // state 返回手势：过了「竖手指关闭」... 这里看 b：550+370 之后才算竖手指
  assert.equal(b.snapshot({ now: 100 }).gesture.current, '抚胸');
  assert.equal(b.snapshot({ now: 600 }).gesture.current, '默认');
  assert.equal(b.snapshot({ now: 1000 }).gesture.current, '竖手指');
  b.complete(r.commandId, 'hands', 'end', undefined, { now: 2000 });
  assert.equal(b.snapshot({ now: 2000 }).gesture.settled, '竖手指');
});
test("blend next：abortBefore 之前立即中止，手势不变（从默认直接开）", () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0);
  const r = handsAct(b, '竖手指打开', 100);
  assert.equal(r.ok, true);
  assert.equal(r.cut.reason, 'abort-before-switch');
  assert.equal(r.cut.atMs, 100);
  assert.equal(r.cut.mode, 'next');
  assert.deepEqual(r.plan[0].chain.map((c) => c.motion), ['竖手指打开']);
  assert.equal(r.plan[0].interrupt, true);
});
test('blend next：abortBefore..chainFrom 之间 NORMAL 等到 chainFrom；手势按已切换算，先补关闭', () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0);
  const q = handsAct(b, '竖手指打开', 400);
  assert.equal(q.queued, true);
  assert.equal(q.readyInMs, 300);
  const st = b.snapshot({ now: 400 }).regions.hands;
  assert.equal(st.nextCutInMs, 300);
  assert.equal(st.pending.ticket, q.ticket);
  assert.ok(st.remainingMs > 0);
  assert.equal(b.frame({ now: 600 }).admitted.length, 0);
  const f = b.frame({ now: 700 });
  assert.equal(f.admitted.length, 1);
  const res = f.admitted[0];
  assert.equal(res.cut.reason, 'chain-point');
  assert.equal(res.cut.waitedMs, 300);
  assert.deepEqual(res.plan[0].chain.map((c) => c.motion), ['抚胸手关闭', '竖手指打开']);
});
test('blend next：同区间 HIGH/FORCE 立即切；cut:now 立即切但也按路径先关', () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0);
  const r = handsAct(b, '竖手指打开', 400, { priority: 'HIGH' });
  assert.equal(r.cut.reason, 'strong-priority');
  assert.deepEqual(r.plan[0].chain.map((c) => c.motion), ['抚胸手关闭', '竖手指打开']);
  const b2 = cb();
  handsAct(b2, '抚胸手打开', 0);
  const n = handsAct(b2, '竖手指打开', 400, { cut: 'now' });
  assert.equal(n.cut.reason, 'now');
  assert.deepEqual(n.plan[0].chain.map((c) => c.motion), ['抚胸手关闭', '竖手指打开'], 'now 也不在两个非默认手势间直接淡变');
});
test('手部等待超过 600ms 强切：按高优先级处理，手势按已切换，先补关闭', () => {
  const b = cb();
  handsAct(b, '狗尾巴草打开', 0); // abortBefore 280，chainFrom 930
  const q = handsAct(b, '抚胸手打开', 300);
  assert.equal(q.queued, true);
  assert.equal(q.readyInMs, 600, '930 晚于 300+600，按 600ms 上限');
  assert.equal(b.frame({ now: 899 }).admitted.length, 0);
  const f = b.frame({ now: 900 });
  assert.equal(f.admitted[0].cut.reason, 'cap-600ms');
  assert.deepEqual(f.admitted[0].plan[0].chain.map((c) => c.motion), ['狗尾巴草关闭', '抚胸手打开']);
});
test('优先级：低优先级不能 now/next 打断高优先级 → 等播完（after）；超 waitMs 判 region-busy', () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0, { priority: 'HIGH' });
  const q = handsAct(b, '竖手指打开', 100, { cut: 'now' });
  assert.equal(q.queued, true);
  assert.equal(q.readyInMs, null);
  assert.equal(q.cut.regions.hands.reason, 'lower-priority-after');
  assert.equal(b.frame({ now: 5000 }).admitted.length, 0, '低优先级不会被 600ms 上限强切');
  const done = b.complete('bc-1', 'hands', 'end', undefined, { now: 5000 });
  assert.equal(done.admitted.length, 1);
  assert.deepEqual(done.admitted[0].plan[0].chain.map((c) => c.motion), ['抚胸手关闭', '竖手指打开']);
  const b2 = cb();
  handsAct(b2, '抚胸手打开', 0, { priority: 'HIGH' });
  handsAct(b2, '竖手指打开', 0, { waitMs: 200 });
  assert.equal(b2.frame({ now: 200 }).expired[0].reason, 'region-busy');
});
test('同模块只留最新 pending：旧的 superseded', () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0);
  const q1 = handsAct(b, '竖手指打开', 400);
  const q2 = handsAct(b, '狗尾巴草打开', 450);
  assert.equal(q2.queued, true);
  assert.deepEqual(q2.superseded.map((x) => [x.ticket, x.reason]), [[q1.ticket, 'superseded']]);
  assert.equal(b.snapshot({ now: 450 }).queue.length, 1);
  const f = b.frame({ now: 700 });
  assert.equal(f.admitted.length, 1);
  assert.equal(f.admitted[0].ticket, q2.ticket);
  // onBusy:wait 也只留一条
  const b2 = rejectBridge(table, { motionCuts: cutsFile });
  b2.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 1000 }] }, { now: 0 });
  const w1 = b2.act({ onBusy: 'wait', steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, { now: 0 });
  const w2 = b2.act({ onBusy: 'wait', steps: [{ region: 'legs', set: { Clothes4: 1 } }] }, { now: 0 });
  assert.equal(w2.superseded[0].ticket, w1.ticket);
});
test("cut:after 等旧动作播完；Idle 任何时候可切；神态 / set 直接渐变到新目标", () => {
  const b = cb();
  handsAct(b, '抚胸手打开', 0);
  const q = handsAct(b, '抚胸手关闭', 800, { cut: 'after' });
  assert.equal(q.queued, true);
  assert.equal(b.frame({ now: 3000 }).admitted.length, 0);
  assert.equal(b.complete('bc-1', 'hands', 'end', undefined, { now: 3000 }).admitted[0].cut.reason, 'after-finish');
  const f = cb();
  f.act({ steps: [{ region: 'face', motion: 'Idle' }] }, { now: 0 });
  const r = f.act({ steps: [{ region: 'face', set: { EyeSmile: 1 }, durationMs: 300 }] }, { now: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.cut.reason, 'anytime');
  const r2 = f.act({ steps: [{ region: 'face', set: { EyeSmile: 0 }, durationMs: 300 }] }, { now: 100 });
  assert.equal(r2.cut.reason, 'continuous');
  assert.deepEqual(r2.preempted.map((x) => x.region), ['face'], '同级 blend 直接接管持续写值');
});
test('没有衔接数据的动作：自动衔接点兜底，最长 600ms', () => {
  const b = createBridge(table, { autoCuts: { 竖手指打开: { durationMs: 1250, cutPointsMs: [0, 1000] } } });
  handsAct(b, '竖手指打开', 0);
  const q = handsAct(b, '抚胸手打开', 100);
  assert.equal(q.readyInMs, 600);
  assert.equal(b.snapshot({ now: 100 }).regions.hands.nextCutInMs, 600);
  assert.equal(b.frame({ now: 700 }).admitted[0].cut.reason, 'fallback-600ms');
  const b2 = createBridge(table, { autoCuts: { 竖手指打开: { durationMs: 1250, cutPointsMs: [0, 300] } } });
  handsAct(b2, '竖手指打开', 0);
  assert.equal(handsAct(b2, '抚胸手打开', 100).readyInMs, 200);
});

console.log('body-bridge ok (' + passed + ' cases)');
