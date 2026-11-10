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
  assert.deepEqual(Object.keys(compiled.conversions).sort(), ['前倾', '脱鞋'].sort());
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
test('合法指令归一化：缺省 source=llm priority=NORMAL onBusy=reject', () => {
  const r = v({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }, { region: 'torso', set: { LeanInput: -10 }, durationMs: 400 }, { layer: 'expression', expression: '脸红', on: true }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.command.source, 'llm');
  assert.equal(r.command.priority, 'NORMAL');
  assert.equal(r.command.onBusy, 'reject');
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
test('表情写模块参数与同条模块直写同一参数：模块优先（裙长切换 vs torso Clothes1）', () => {
  const r = v({ steps: [{ region: 'torso', set: { Clothes1: 0.5 } }, { layer: 'expression', expression: '裙长切换' }] });
  assert.equal(r.reason, 'expression-conflict');
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

// ------------------------------------------------------------------ 占用 / 仲裁
const NOW = { now: 1000, slots: {} };
test('空闲时受理：回执 {ok, commandId, accepted, preempted, warnings}', () => {
  const b = createBridge(table);
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
  const b = createBridge(table);
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
  const b = createBridge(table);
  b.act({ priority: 'FORCE', steps: [{ region: 'hands', motion: '竖手指打开' }] }, NOW);
  const r = b.act({ steps: [{ region: 'torso', set: { LeanInput: -5 } }, { region: 'hands', motion: '抚胸手打开' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(b.snapshot(NOW).regions.torso.busy, false);
});
test('更高优先级抢占：只对被抢模块发 interrupted，其余模块不动', () => {
  const b = createBridge(table);
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
  const b = createBridge(table);
  const r = b.act({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, { now: 0, slots: { 抚胸手: 'open', 竖手指: 'open', 狗尾巴草: 'closed' } });
  assert.deepEqual(r.plan[0].closeFirst, ['竖手指关闭']);
  const r2 = createBridge(table).act({ steps: [{ region: 'hands', motion: '抚胸手打开' }] }, { now: 0, slots: { 竖手指: 'open' } });
  assert.deepEqual(r2.plan[0].closeFirst, []);
});
test('注入 shareArm 时用注入实现（overlay 注入渲染端 motionsShareArm）', () => {
  const calls = [];
  const b = createBridge(table, { shareArm: (x, y) => { calls.push([x, y]); return false; } });
  const r = b.act({ steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, { now: 0, slots: { 竖手指: 'open' } });
  assert.deepEqual(r.plan[0].closeFirst, []);
  assert.deepEqual(calls, [['竖手指打开', '狗尾巴草打开']]);
});
test('complete：每模块完成发 action-done 带 commandId 与 region；迟到回调 settled=false', () => {
  const b = createBridge(table);
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
  const b = createBridge(table);
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
  const b = createBridge(table);
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
  const b = createBridge(table);
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
  const b = createBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 1000 }] }, { now: 0 });
  const r = b.act({ steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, { now: 1 });
  assert.equal(r.ok, false);
  assert.equal(b.snapshot({ now: 2 }).queue.length, 0);
});
test('release 排队中的 ticket = 出队', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 1000 }] }, { now: 0 });
  const q = b.act({ onBusy: 'wait', steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, { now: 1 });
  assert.equal(b.release({ commandId: q.ticket }, { now: 2 }).dequeued, q.ticket);
  assert.equal(b.snapshot({ now: 3 }).queue.length, 0);
});

// ------------------------------------------------------------------ set 插值（每帧推进）
test('set 插值：durationMs 内每帧推进，到头发 end 并释放模块；叠加参数从 0 偏移起插', () => {
  const b = createBridge(table);
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
  const b = createBridge(table);
  b.act({ steps: [{ region: 'hair', set: { Param137: 1 }, durationMs: 200 }] }, { now: 0, read: (ids) => ({ [ids[0]]: 0.2 }) });
  assert.equal(b.frame({ now: 0 }).writes.Param137, 0.2);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 1 } }] }, { now: 0 });
  const f = b.frame({ now: 0 });
  assert.equal(f.writes.Clothes4, 1);
  assert.ok(f.events.some((e) => e.region === 'legs' && e.phase === 'end'));
});
test('被抢占的插值立刻停写，新占用者接管', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'torso', set: { PositionX: 5 }, durationMs: 1000 }] }, { now: 0 });
  b.frame({ now: 100 });
  b.act({ priority: 'FORCE', steps: [{ region: 'torso', set: { LeanInput: -3 } }] }, { now: 200 });
  const f = b.frame({ now: 300 });
  assert.equal(f.writes.PositionX, undefined);
  assert.equal(f.writes.LeanInput, -3);
});

// ------------------------------------------------------------------ 表情层 / 前倾 / 脱鞋
test('表情层只在互斥组内判冲突：仍在执行的同级指令持有眼型 → expression-conflict', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'hands', motion: '竖手指打开' }, { layer: 'expression', expression: '圈圈眼' }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '爱心眼' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expression-conflict');
  // 不同组（脸红）不冲突，但渲染端是单槽 → 警告
  const ok = b.act({ steps: [{ layer: 'expression', expression: '脸红' }] }, NOW);
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some((w) => w.startsWith('expression-single-slot')));
  // 更高优先级可以换掉眼型
  const b2 = createBridge(table);
  b2.act({ steps: [{ region: 'hands', motion: '竖手指打开' }, { layer: 'expression', expression: '圈圈眼' }] }, NOW);
  const hi = b2.act({ priority: 'HIGH', steps: [{ layer: 'expression', expression: '爱心眼' }] }, NOW);
  assert.equal(hi.ok, true);
  assert.equal(hi.plan[0].replaces, '圈圈眼');
});
test('持有眼型的指令已结束 → 同级可以替换（先淡出旧的由渲染端单槽完成）', () => {
  const b = createBridge(table);
  const a = b.act({ steps: [{ layer: 'expression', expression: '圈圈眼' }] }, NOW);
  b.complete(a.commandId, 'expression', 'end');
  const r = b.act({ steps: [{ layer: 'expression', expression: '＞＜' }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.plan[0].replaces, '圈圈眼');
});
test('前倾 vs 躯干直写：躯干优先（同级时前倾被拒，原因 expression-conflict）', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'torso', set: { LeanInput: -5 }, durationMs: 2000 }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '前倾' }] }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expression-conflict');
  assert.equal(r.busy[0].convertedFrom, '前倾');
});
test('脱鞋 vs 腿部直写：腿部优先', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'legs', set: { Clothes4: 0 }, durationMs: 2000 }] }, NOW);
  const r = b.act({ steps: [{ layer: 'expression', expression: '脱鞋' }] }, NOW);
  assert.equal(r.reason, 'expression-conflict');
  // 腿部空闲时脱鞋就是一条 legs 指令
  const b2 = createBridge(table);
  const ok = b2.act({ steps: [{ layer: 'expression', expression: '脱鞋' }] }, NOW);
  assert.deepEqual(ok.accepted, ['legs']);
  assert.deepEqual(ok.plan[0].set, { Clothes4: 1 });
});
test('裙长切换 vs 躯干正在直写 Clothes1：模块优先', () => {
  const b = createBridge(table);
  b.act({ steps: [{ region: 'torso', set: { Clothes1: 0.3 }, durationMs: 2000 }] }, NOW);
  assert.equal(b.act({ steps: [{ layer: 'expression', expression: '裙长切换' }] }, NOW).reason, 'expression-conflict');
  // 躯干在写别的参数时不冲突
  const b2 = createBridge(table);
  b2.act({ steps: [{ region: 'torso', set: { PositionX: 1 }, durationMs: 2000 }] }, NOW);
  assert.equal(b2.act({ steps: [{ layer: 'expression', expression: '裙长切换' }] }, NOW).ok, true);
});
test('形态层：当前是体型表情时，形态指令清掉它（形态优先）', () => {
  const b = createBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '体型1' }] }, NOW);
  const r = b.act({ steps: [{ layer: 'form', form: 2 }] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.plan[0].clearExpression, true);
  assert.equal(b.snapshot(NOW).expression, null);
});
test('表情 on:false：只在它是当前表情时标记 wasActive', () => {
  const b = createBridge(table);
  b.act({ steps: [{ layer: 'expression', expression: '脸红' }] }, NOW);
  const off = b.act({ steps: [{ layer: 'expression', expression: '流泪', on: false }] }, NOW);
  assert.equal(off.plan[0].wasActive, false);
  const off2 = b.act({ steps: [{ layer: 'expression', expression: '脸红', on: false }] }, NOW);
  assert.equal(off2.plan[0].wasActive, true);
  assert.equal(b.snapshot(NOW).expression, null);
});

console.log('body-bridge ok (' + passed + ' cases)');
