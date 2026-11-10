/**
 * 宿主侧 bridge 处理器测试：静态校验在宿主、占用权威在 overlay（这里用同一份 createBridge 模拟 overlay），
 * 转发通道 = aiInbox 的 call/read（与 l2d_act 同一条）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createBridgeApi, loadBodyRegionsForModel, BRIDGE_INBOX_TOOLS } from './body-bridge-api.mjs';
import { createBridge } from './body-bridge.mjs';
import { createAiInbox } from './ai-inbox.mjs';
import { HOST_ALLOWED_TOOLS } from './host-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(here, '../../../docs/nodegraph/models');
const MODEL_ID = '大肥鱼.dsl2d.2048';
const table = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, MODEL_ID, 'body-regions.json'), 'utf8'));

// 分区表加载：带点的 modelId 放行，.. 拒绝，缺表 table-unavailable
{
  const ok = loadBodyRegionsForModel(MODEL_ID, { modelsDir: MODELS_DIR });
  assert.equal(ok.ok, true);
  assert.equal(ok.compiled.regions.legs.writable.size, 1);
  assert.equal(loadBodyRegionsForModel('../etc', { modelsDir: MODELS_DIR }).reason, 'table-unavailable');
  assert.equal(loadBodyRegionsForModel('demo-model', { modelsDir: MODELS_DIR }).reason, 'table-unavailable');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  fs.mkdirSync(path.join(tmp, 'broken'));
  fs.writeFileSync(path.join(tmp, 'broken', 'body-regions.json'), '{"regions":1}');
  assert.match(loadBodyRegionsForModel('broken', { modelsDir: tmp }).message, /解析失败/);
}

// bridge 工具不进 /ai/call 白名单（否则会绕过宿主静态校验）
for (const name of BRIDGE_INBOX_TOOLS) assert.ok(!HOST_ALLOWED_TOOLS.includes(name), name + ' 不应进 /ai/call 白名单');

/** 假 overlay：从 inbox poll 指令，用同一份 createBridge 执行，回写 result 和 action-done。 */
function fakeOverlay(inbox) {
  const bridge = createBridge(table);
  let t = 0;
  const pump = () => {
    const polled = inbox.poll({ consumerId: 'c1' });
    for (const c of polled.calls || []) {
      let res;
      if (c.name === 'l2d_regions_act') {
        res = bridge.act(c.args.command, { now: t, slots: {} });
        if (res.ok && !res.queued) {
          const { plan, events, ...rest } = res;
          inbox.post({ id: c.id, result: rest });
          // 立即「执行完」：每个目标发 end
          for (const target of res.accepted) {
            const d = bridge.complete(res.commandId, target, 'end', undefined, { now: t });
            for (const ev of d.events) inbox.post({ id: c.id, event: { ...ev, callId: c.id } });
          }
          continue;
        }
      } else if (c.name === 'l2d_regions_get') {
        res = { ok: true, ...bridge.snapshot({ now: t }) };
      } else if (c.name === 'l2d_regions_release') {
        res = bridge.release(c.args, { now: t });
      } else {
        res = { ok: false, reason: 'unknown-tool' };
      }
      inbox.post({ id: c.id, result: res });
    }
    t += 100;
  };
  return { bridge, pump };
}

const inbox = createAiInbox({ leaseEnabled: () => false });
const overlay = fakeOverlay(inbox);
let clock = 0;
const api = createBridgeApi({
  getCurrentModelId: () => MODEL_ID,
  modelsDir: MODELS_DIR,
  call: (name, args) => inbox.call(name, args),
  read: (id) => inbox.read(id),
  now: () => clock,
  sleep: async (ms) => {
    clock += ms;
    overlay.pump();
  },
  pollIntervalMs: 50,
  forwardTimeoutMs: 1000,
});

// table
{
  const r = api.handleTable();
  assert.equal(r.status, 200);
  assert.equal(r.payload.modelId, MODEL_ID);
  assert.ok(r.payload.capabilities.regions.hands.motions.includes('竖手指打开'));
  assert.equal(api.handleTable('demo-model').status, 404);
}

// 静态校验在宿主：不合格不入队
{
  const before = inbox.poll({ consumerId: 'c1' }).calls.length;
  assert.equal(before, 0);
  const bad = await api.handleAct({ steps: [{ region: 'face', set: { ParamMouthOpenY: 1 } }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.reason, 'lipsync-redline');
  const bad2 = await api.handleAct({ steps: [{ region: 'torso', motion: '竖手指打开' }] });
  assert.equal(bad2.payload.reason, 'motion-not-in-region');
  const bad3 = await api.handleAct(null);
  assert.equal(bad3.payload.reason, 'invalid-command');
  assert.equal(inbox.poll({ consumerId: 'c1' }).calls.length, 0, '静态拒绝不应入队');
}

// 合法指令：经 inbox 转发，overlay 回执原样带回，callId 可回查
{
  const r = await api.handleAct({ source: 'nodegraph', steps: [{ region: 'hands', motion: '狗尾巴草打开' }, { layer: 'expression', expression: '前倾' }] });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.ok, true);
  assert.match(r.payload.commandId, /^bc-/);
  assert.deepEqual(r.payload.accepted, ['hands', 'torso']);
  assert.ok(r.payload.callId > 0);
  assert.ok(r.payload.warnings.includes('expression-converted:前倾->torso'));
}

// awaitDone：等每个模块的 action-done（带 commandId 与 region）
{
  const r = await api.handleAct({ awaitDone: true, steps: [{ region: 'legs', set: { Clothes4: 1 } }, { region: 'hair', set: { Param137: 1 } }] });
  assert.equal(r.payload.ok, true);
  assert.equal(r.payload.settled, true);
  const regions = r.payload.events.filter((e) => e.phase === 'end').map((e) => e.region).sort();
  assert.deepEqual(regions, ['hair', 'legs']);
  for (const e of r.payload.events) assert.equal(e.commandId, r.payload.commandId);
}

// state / release 走同一通道
{
  const s = await api.handleState();
  assert.equal(s.status, 200);
  assert.equal(s.payload.regions.hands.busy, false);
  assert.ok(s.payload.capabilities);
  const rel = await api.handleRelease({ region: 'tail' });
  assert.equal(rel.payload.reason, 'unknown-region');
  const rel2 = await api.handleRelease({});
  assert.equal(rel2.status, 400);
  const rel3 = await api.handleRelease({ commandId: 'bc-404' });
  assert.equal(rel3.status, 404);
}

// overlay 不在：超时 504，不伪造成功
{
  const deadInbox = createAiInbox({ leaseEnabled: () => false });
  let c2 = 0;
  const dead = createBridgeApi({
    getCurrentModelId: () => MODEL_ID,
    modelsDir: MODELS_DIR,
    call: (n, a) => deadInbox.call(n, a),
    read: (id) => deadInbox.read(id),
    now: () => c2,
    sleep: async (ms) => { c2 += ms; },
    forwardTimeoutMs: 300,
  });
  const r = await dead.handleAct({ steps: [{ region: 'legs', set: { Clothes4: 1 } }] });
  assert.equal(r.status, 504);
  assert.equal(r.payload.reason, 'timeout');
  // onBusy:wait 时预算 = waitMs + 基础预算
  c2 = 0;
  await dead.handleAct({ onBusy: 'wait', waitMs: 2000, steps: [{ region: 'legs', set: { Clothes4: 1 } }] });
  assert.ok(c2 >= 2300 && c2 < 2500, String(c2));
}

// 缺表：503 table-unavailable
{
  const none = createBridgeApi({ getCurrentModelId: () => 'demo-model', modelsDir: MODELS_DIR, call: () => ({ ok: true, id: 1 }), read: () => ({ ready: false }) });
  const r = await none.handleAct({ steps: [{ layer: 'form', form: 1 }] });
  assert.equal(r.status, 503);
  assert.equal(r.payload.reason, 'table-unavailable');
}

console.log('body-bridge-api ok');
