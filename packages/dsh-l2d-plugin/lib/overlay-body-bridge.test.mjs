/**
 * overlay.js 部位联动 bridge 接线测试（占用权威在 overlay）。
 *
 * overlay.js 是浏览器 IIFE，无法整体执行。这里从源码里原样抽出：
 *   ① 「部位联动 bridge」整段（到「AI 指令轮询」之前）；
 *   ② `function bindPhysics()`（preLateUpdateHook 接线）；
 * 在沙箱里接上假渲染端（按 lappmodel.update 的真实帧顺序调用 setPreUpdate 钩子），
 * 并 import 真正的 body-bridge.mjs（同一份规则）。断言：
 *   - bridge 写参数只发生在 preLateUpdateHook 里（save 之后、调度器之前），set 插值逐帧推进；
 *   - 前倾 → torso LeanInput、脱鞋 → legs Clothes4，不调 setExpression；
 *   - 旧接口 l2d_play_motion / l2d_set_expression 回执形状不变，第二个手部动作 region-busy；
 *   - 抢占只按手臂收尾（先播共用手臂的关闭动作）；action-done 带 commandId、region、callId；
 *   - onBusy:'wait' 出队与超时。
 * 运行：node packages/dsh-l2d-plugin/lib/overlay-body-bridge.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as bridgeModule from './body-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'overlay.js'), 'utf8');
const table = JSON.parse(readFileSync(resolve(HERE, '../../../docs/nodegraph/models/大肥鱼.dsl2d.2048/body-regions.json'), 'utf8'));

const START = '  // ---------------------------------------------------------------- 部位联动 bridge（占用状态权威）';
const END = '  // ---------------------------------------------------------------- AI 指令轮询';
const a = src.indexOf(START);
const b = src.indexOf(END);
assert.ok(a > 0 && b > a, 'overlay.js 缺少 bridge 段');
const blockSrc = src.slice(a, b);

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
const bindPhysicsSrc = extractBalanced('function bindPhysics()', '{', '}');

// 规则单源：overlay 不得自带一份冲突规则，必须动态加载 body-bridge.mjs
assert.ok(blockSrc.includes("versioned('/dsh-l2d/body-bridge.mjs')"), 'overlay 应 import /dsh-l2d/body-bridge.mjs');
for (const literal of ["'竖手指关闭'", "'LeanInput'", "'Clothes4'", 'BRIDGE_PRIORITY_RANK']) {
  assert.ok(!blockSrc.includes(literal), 'overlay bridge 段不应写死规则字面量：' + literal);
}
// 旧接口与新工具都接到 bridge
for (const marker of ["case 'l2d_regions_act'", "case 'l2d_regions_get'", "case 'l2d_regions_release'", 'legacyExpressionViaBridge(expName', 'legacyMotionViaBridge(motionGroup']) {
  assert.ok(src.includes(marker), 'overlay.js 缺少：' + marker);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox() {
  const log = { writes: [], posted: [], played: [], expressions: [], cleared: 0, outsideHookWrites: 0, forms: [] };
  let inPreLate = false;
  let now = 0;
  const slots = { 抚胸手: 'closed', 竖手指: 'closed', 狗尾巴草: 'closed' };
  const completionSubs = [];
  let preUpdate = null;
  const L = {
    isReady: () => true,
    setPreUpdate(fn) { preUpdate = fn; },
    setParametersRuntime(values) {
      if (!inPreLate) log.outsideHookWrites++;
      log.writes.push({ t: now, values: { ...values } });
      return { ok: Object.keys(values), failed: [] };
    },
    readParameters(ids) { const o = {}; for (const id of ids) o[id] = 0; return o; },
    getMotionSlots: () => ({ ...slots }),
    motionsShareArm: (x, y) => {
      const base = (n) => String(n).replace(/(打开|关闭)$/, '');
      const right = new Set(['竖手指', '狗尾巴草']);
      return base(x) === base(y) || (right.has(base(x)) && right.has(base(y)));
    },
    onActionCompletion(cb) { completionSubs.push(cb); },
    playMotionAsync(group, opts) {
      log.played.push({ group, opts: { ...opts } });
      const m = String(group).match(/^(.+?)(打开|关闭)$/);
      if (m) slots[m[1]] = m[2] === '打开' ? 'open' : 'closed';
      return Promise.resolve({ status: 'ok', group, slot: m ? m[1] : undefined, dir: m && m[2] === '打开' ? 'open' : 'close' });
    },
    setExpression(name) { log.expressions.push(name); return true; },
    clearExpression() { log.cleared++; return true; },
  };
  const window = {
    DSH_L2D: L,
    DSH_L2D_AI: { exec(name, args) { log.forms.push(args.index); return { ok: true, form: { index: args.index } }; } },
  };
  const fetchStub = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, table }) });
  const factory = new Function(
    'window', 'log', 'fetch', 'performance', 'bridgeModule', 'physicsTickSpy', 'setTimeout', 'setInterval',
    `
    var physics = { bound: false };
    function versioned(p) { return p + '?v=test'; }
    function physicsTick() { physicsTickSpy(); }
    function postActEvent(ev) { log.posted.push(ev); }
    ${blockSrc}
    bodyBridgeImport = function () { return Promise.resolve(bridgeModule); };
    ${bindPhysicsSrc}
    return {
      bindPhysics: bindPhysics,
      act: bodyBridgeAct,
      legacyMotion: legacyMotionViaBridge,
      legacyExpression: legacyExpressionViaBridge,
      load: loadBodyBridge,
      state: function () { return bodyBridge; },
    };
    `,
  );
  let physicsTicks = 0;
  // 看门狗 / 排队泵的定时器不拖住测试进程退出
  const unrefTimeout = (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; };
  const unrefInterval = (fn, ms) => { const h = setInterval(fn, ms); if (h && h.unref) h.unref(); return h; };
  const api = factory(window, log, fetchStub, { now: () => now }, bridgeModule, () => { physicsTicks++; }, unrefTimeout, unrefInterval);
  /** 按 lappmodel.update() 的真实顺序跑一帧：load → motion → save → preLateUpdateHook → scheduler → post。 */
  function frame(dt = 16) {
    now += dt;
    // loadParameters / updateMotion / saveParameters（此时写参数会被下一帧 load 抹掉）
    inPreLate = true;
    try { if (preUpdate) preUpdate(); } finally { inPreLate = false; }
    // onLateUpdate（眨眼/表情/物理…）与 postLateUpdateHook：bridge 不在这里写
  }
  return {
    api, log, L, slots, frame,
    advance(ms) { now += ms; },
    complete(executionId, phase = 'end') { for (const cb of completionSubs) cb({ kind: 'motion', executionId, phase, group: '' }); },
    get physicsTicks() { return physicsTicks; },
    get now() { return now; },
  };
}

// ---------------------------------------------------------------- 1) 帧相位：只在 preLateUpdateHook 里写，插值逐帧推进
{
  const sb = makeSandbox();
  sb.api.bindPhysics();
  await sleep(5); // setTimeout(loadBodyBridge, 0)
  await sb.api.load();
  const r = await sb.api.act({ source: 'nodegraph', steps: [{ region: 'torso', set: { LeanInput: -10 }, durationMs: 160 }] }, 7);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan, undefined, '回执不带内部计划');
  assert.equal(sb.log.writes.length, 0, 'act 本身不写参数（写入只在帧钩子里）');
  for (let i = 0; i < 12; i++) sb.frame(16);
  assert.equal(sb.log.outsideHookWrites, 0, 'bridge 写参数必须全部发生在 preLateUpdateHook 里');
  const series = sb.log.writes.map((w) => w.values.LeanInput);
  assert.ok(series.length >= 9, '插值应逐帧推进：' + series.join(','));
  for (let i = 1; i < series.length; i++) assert.ok(series[i] <= series[i - 1] + 1e-9, '单调趋近目标');
  assert.equal(series[series.length - 1], -10);
  assert.ok(sb.physicsTicks >= 12, '拖拽物理仍每帧运行（同一钩子，bridge 先写）');
  const done = sb.log.posted.find((e) => e.region === 'torso');
  assert.deepEqual(
    { type: done.type, phase: done.phase, commandId: done.commandId, callId: done.callId },
    { type: 'action-done', phase: 'end', commandId: r.commandId, callId: 7 },
  );
  // 到头后不再写
  const n = sb.log.writes.length;
  sb.frame(16);
  assert.equal(sb.log.writes.length, n);
}

// ---------------------------------------------------------------- 2) 前倾 / 脱鞋 改走模块指令
{
  const sb = makeSandbox();
  sb.api.bindPhysics();
  await sleep(5);
  await sb.api.load();
  const r1 = await sb.api.legacyExpression('前倾', () => ({ ok: false, error: 'direct-should-not-run' }));
  assert.deepEqual(r1, { ok: true });
  const r2 = await sb.api.legacyExpression('脱鞋', () => ({ ok: false, error: 'direct-should-not-run' }));
  assert.deepEqual(r2, { ok: true });
  assert.deepEqual(sb.log.expressions, [], '前倾/脱鞋不进表情层');
  sb.frame(16);
  const last = Object.assign({}, ...sb.log.writes.map((w) => w.values));
  assert.equal(last.LeanInput, -30);
  assert.equal(last.Clothes4, 1);
  // 普通表情仍走 setExpression，回执形状不变
  assert.deepEqual(await sb.api.legacyExpression('脸红', () => ({ ok: false })), { ok: true });
  assert.deepEqual(sb.log.expressions, ['脸红']);
  // 表里没有的表情走原直连路径（由原路径给出 unknown-expression）
  assert.deepEqual(await sb.api.legacyExpression('不存在', () => ({ ok: false, error: 'unknown-expression: 不存在' })), { ok: false, error: 'unknown-expression: 不存在' });
  // 腿部被高优先级直写占着时，脱鞋被拒（腿部优先）
  const hold = await sb.api.act({ priority: 'HIGH', steps: [{ region: 'legs', set: { Clothes4: 0 }, durationMs: 5000 }] }, 9);
  assert.equal(hold.ok, true);
  const r3 = await sb.api.legacyExpression('脱鞋', () => ({ ok: true }));
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'expression-conflict: 脱鞋');
}

// ---------------------------------------------------------------- 3) 旧接口 l2d_play_motion：形状不变、占用、awaitFinish、按手臂收尾
{
  const sb = makeSandbox();
  sb.api.bindPhysics();
  await sleep(5);
  await sb.api.load();
  const r1 = await sb.api.legacyMotion('竖手指打开', 0, false, () => ({ ok: false, reason: 'direct' }));
  assert.deepEqual(r1, { ok: true, status: 'ok', group: '竖手指打开', slot: '竖手指', dir: 'open' });
  assert.equal(sb.log.played[0].opts.executionId.indexOf('bridge:'), 0);
  // 手部还被占着（动作没播完）：第二个同级手部动作 region-busy，回执仍是旧形状
  const r2 = await sb.api.legacyMotion('抚胸手打开', 0, false, () => ({ ok: false }));
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'region-busy');
  assert.equal(r2.group, '抚胸手打开');
  assert.equal(r2.busy[0].region, 'hands');
  // 渲染端自然完成 → hands end，带 commandId / region
  sb.complete(sb.log.played[0].opts.executionId, 'end');
  const ev = sb.log.posted.find((e) => e.region === 'hands');
  assert.equal(ev, undefined, '旧接口没有 callId 时不回写 /ai/result');
  // 狗尾巴草打开：竖手指（共用右臂）开着 → 先播竖手指关闭，再开狗尾巴草；awaitFinish 等完成
  const p = sb.api.legacyMotion('狗尾巴草打开', 0, true, () => ({ ok: false }));
  await sleep(5);
  const groups = sb.log.played.map((x) => x.group);
  assert.deepEqual(groups.slice(-2), ['竖手指关闭', '狗尾巴草打开']);
  let settled = false;
  p.then(() => { settled = true; });
  await sleep(5);
  assert.equal(settled, false, 'awaitFinish 应等到 action-done');
  sb.complete(sb.log.played[sb.log.played.length - 1].opts.executionId, 'end');
  const r3 = await p;
  assert.deepEqual(r3, { ok: true, status: 'ok', group: '狗尾巴草打开', slot: '狗尾巴草', dir: 'open' });
  // 抚胸手（左臂）开着时打开竖手指不关它
  await sb.api.legacyMotion('抚胸手打开', 0, false, () => ({}));
  sb.complete(sb.log.played[sb.log.played.length - 1].opts.executionId, 'end');
  const before = sb.log.played.length;
  await sb.api.legacyMotion('竖手指打开', 0, false, () => ({}));
  const after = sb.log.played.slice(before).map((x) => x.group);
  assert.deepEqual(after, ['狗尾巴草关闭', '竖手指打开'], '只关共用右臂的狗尾巴草，不碰左臂抚胸手');
}

// ---------------------------------------------------------------- 4) 抢占：只对被抢模块发 interrupted；其他模块继续
{
  const sb = makeSandbox();
  sb.api.bindPhysics();
  await sleep(5);
  await sb.api.load();
  const low = await sb.api.act({ priority: 'NORMAL', steps: [{ region: 'hands', motion: '竖手指打开' }, { region: 'torso', set: { PositionX: 2 }, durationMs: 1000 }] }, 21);
  const high = await sb.api.act({ priority: 'FORCE', source: 'user', steps: [{ region: 'hands', motion: '狗尾巴草打开' }] }, 22);
  assert.equal(high.ok, true);
  assert.deepEqual(high.preempted.map((p) => [p.region, p.commandId]), [['hands', low.commandId]]);
  const intr = sb.log.posted.find((e) => e.phase === 'interrupted');
  assert.deepEqual([intr.region, intr.commandId, intr.callId, intr.reason], ['hands', low.commandId, 21, 'preempted']);
  for (let i = 0; i < 70; i++) sb.frame(16);
  const torsoDone = sb.log.posted.find((e) => e.region === 'torso' && e.phase === 'end');
  assert.equal(torsoDone.commandId, low.commandId, '躯干插值不受手部抢占影响');
}

// ---------------------------------------------------------------- 5) onBusy:'wait' 出队与超时
{
  const sb = makeSandbox();
  sb.api.bindPhysics();
  await sleep(5);
  await sb.api.load();
  await sb.api.act({ steps: [{ region: 'legs', set: { Clothes4: 1 }, durationMs: 100 }] }, 31);
  const queued = sb.api.act({ onBusy: 'wait', waitMs: 2000, steps: [{ region: 'legs', set: { Clothes4: 0 } }] }, 32);
  await sleep(1); // 让 act 先落账（loadBodyBridge 之后的微任务）再跑帧
  assert.equal(sb.api.state().core.snapshot({ now: sb.now }).queue.length, 1);
  for (let i = 0; i < 10; i++) sb.frame(16);
  await sleep(5);
  const q = await queued;
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.ok(q.waitedMs > 0, JSON.stringify(q));
  assert.match(q.commandId, /^bc-/);
  // 超时：占着不放，wait 100ms 后 region-busy timeout
  await sb.api.act({ priority: 'FORCE', steps: [{ region: 'hair', set: { Param137: 1 }, durationMs: 9000 }] }, 33);
  const late = sb.api.act({ onBusy: 'wait', waitMs: 100, steps: [{ region: 'hair', set: { Param139: 1 } }] }, 34);
  await sleep(1);
  for (let i = 0; i < 10; i++) sb.frame(16);
  const t = await late;
  assert.equal(t.ok, false);
  assert.equal(t.reason, 'region-busy');
  assert.equal(t.timeout, true);
}

console.log('overlay-body-bridge ok');
