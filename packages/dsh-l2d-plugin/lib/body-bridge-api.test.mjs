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

// 神态部件表加载：先 face-units.json，没有再 face-vocab.json；face/vocab 与 face/compose 静态校验
{
  const real = loadBodyRegionsForModel(MODEL_ID, { modelsDir: MODELS_DIR });
  assert.ok(['face-units.json', 'face-vocab.json'].includes(real.faceFile), real.faceFile);
  assert.ok(real.compiled.face && real.compiled.face.dimensions.size === 13);
  const faceSrc = fs.readFileSync(path.join(MODELS_DIR, MODEL_ID, real.faceFile), 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-face-'));
  const dir = path.join(tmp, 'm1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'body-regions.json'), JSON.stringify(table));
  assert.equal(loadBodyRegionsForModel('m1', { modelsDir: tmp }).compiled.face, null, '没有部件表 → 不开放 compose');
  fs.writeFileSync(path.join(dir, 'face-vocab.json'), faceSrc);
  assert.equal(loadBodyRegionsForModel('m1', { modelsDir: tmp }).faceFile, 'face-vocab.json');
  fs.writeFileSync(path.join(dir, 'face-units.json'), faceSrc);
  assert.equal(loadBodyRegionsForModel('m1', { modelsDir: tmp }).faceFile, 'face-units.json', '两个都在时用 face-units.json');
  const api = createBridgeApi({ getCurrentModelId: () => MODEL_ID, modelsDir: MODELS_DIR, call: () => ({ ok: false, reason: 'no' }), read: () => ({ ready: false }) });
  const v = api.handleFaceVocab('');
  assert.equal(v.status, 200);
  assert.equal(Object.keys(v.payload.vocab.params).length, 20);
  assert.ok(v.payload.summary.params.find((x) => x.id === 'LeanInput').region === 'torso');
  assert.equal((await api.handleFaceCompose({ compose: { dimensions: { 不存在: 1 } } })).payload.reason, 'unknown-dimension');
  assert.equal((await api.handleFaceCompose({ compose: { dimensions: { 慵懒: 0.6 } } })).payload.reason, 'overlay-unavailable', '合法组合才转发 overlay');
  assert.equal((await api.handleFaceCompose({ mood: '妩媚' })).payload.reason, 'overlay-unavailable');
  const none = createBridgeApi({ getCurrentModelId: () => 'm1', modelsDir: path.join(tmp, 'nope'), call: () => ({ ok: true, id: 1 }), read: () => ({ ready: false }) });
  assert.equal(none.handleFaceVocab('').status, 404);
}

// 动作衔接点：motion-cutpoints.json 随表下发；未标注动作由 modelDir 现算兜底（手写最小样例，不用模型文件）
{
  const real = loadBodyRegionsForModel(MODEL_ID, { modelsDir: MODELS_DIR });
  assert.ok(real.motionCuts && real.motionCuts.motions && real.motionCuts.motions['抚胸手关闭'], '仓库内 motion-cutpoints.json 已加载');
  assert.deepEqual(real.autoCuts, {}, '没给 modelDir 不现算');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cuts-'));
  const models = path.join(tmp, 'models');
  fs.mkdirSync(path.join(models, 'm2'), { recursive: true });
  fs.writeFileSync(path.join(models, 'm2', 'body-regions.json'), JSON.stringify(table));
  const mdir = path.join(tmp, 'modelfiles');
  fs.mkdirSync(path.join(mdir, 'motions'), { recursive: true });
  fs.writeFileSync(path.join(mdir, 'm2.model3.json'), JSON.stringify({ FileReferences: { Motions: { 竖手指打开: [{ File: 'motions/x.motion3.json', FadeInTime: 0.3 }] } } }));
  fs.writeFileSync(path.join(mdir, 'motions', 'x.motion3.json'), JSON.stringify({ Meta: { Duration: 1 }, Curves: [] }));
  const t2 = loadBodyRegionsForModel('m2', { modelsDir: models, modelDir: mdir });
  assert.equal(t2.motionCuts, null);
  assert.deepEqual(t2.autoCuts['竖手指打开'], { durationMs: 1000, loop: false, cutPointsMs: [], fadeInMs: 300 });
  const api = createBridgeApi({ getCurrentModelId: () => 'm2', modelsDir: models, modelDir: mdir, call: () => ({ ok: false }), read: () => ({ ready: false }) });
  const tp = api.handleTable('');
  assert.equal(tp.status, 200);
  assert.ok(tp.payload.autoCuts['竖手指打开']);
  assert.equal(tp.payload.motionCuts, null);
}

console.log('body-bridge-api ok');
