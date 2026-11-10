import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAiInbox } from './ai-inbox.mjs';

// ---------------------------------------------------------------- 基线（flag 关 = legacy 行为）
const inbox = createAiInbox();
const queued = inbox.call('l2d_act', { priority: 'FORCE' });
assert.equal(queued.ok, true);
assert.equal(queued.id, 1);
assert.deepEqual(inbox.poll().calls.map((item) => item.name), ['l2d_act']);
assert.deepEqual(inbox.poll().calls, []);

const start = { type: 'action-done', phase: 'start', runId: 1, callId: 1 };
assert.equal(inbox.post({ id: 1, event: start }).ok, true);
const early = inbox.read(1);
assert.equal(early.ready, false);
assert.equal(early.events.length, 1);
assert.equal(early.events[0].phase, 'start');

const accepted = { ok: true, accepted: true, runId: 1, priority: 'FORCE' };
inbox.post({ id: 1, result: accepted });
const end = { type: 'action-done', phase: 'end', runId: 1, callId: 1 };
inbox.post({ id: 1, event: end });
const done = inbox.read(1);
assert.equal(done.ready, true);
assert.equal(done.result.accepted, true);
assert.equal(done.events[0].phase, 'end');
assert.deepEqual(inbox.read(1), { ready: false });

assert.equal(inbox.post({}).ok, false);
console.log('ai-inbox legacy ok');

// ---------------------------------------------------------------- 租约测试矩阵（M1-D3 READY §4）
// 统一用注入时钟（起点取正值，避开 0 哨兵歧义），flag 用闭包变量模拟热切换。
function makeLeaseInbox(t0, overrides = {}) {
  let now = t0;
  let flag = true;
  const diags = [];
  const box = createAiInbox({
    leaseTtlMs: 1000,
    legacyGraceMs: overrides.legacyGraceMs != null ? overrides.legacyGraceMs : 30 * 60 * 1000,
    leaseEnabled: () => flag,
    diag: (msg) => diags.push(msg),
    now: () => now,
    ...overrides,
  });
  return {
    box,
    diags,
    setFlag(v) { flag = v; },
    tick(ms) { now += ms; },
    get now() { return now; },
  };
}

// T1 双消费者竞争：B 在 A 租约期内 poll → 空队列 + held，不瓜分
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  t.box.call('a2', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  assert.equal(pa.calls.length, 2); // 整批发放给持租约者
  assert.equal(pa.lease.token.startsWith('lease-1-'), true);
  assert.equal(pa.lease.epoch, 1);
  const pb = t.box.poll({ consumerId: 'pageB' });
  assert.deepEqual(pb.calls, []);
  assert.equal(pb.lease.status, 'held');
  assert.equal(typeof pb.lease.holder, 'string');
  // R2：A 续期后再 poll 仍归 A
  const pa2 = t.box.poll({ consumerId: 'pageA' });
  assert.deepEqual(pa2.calls, []);
  assert.equal(pa2.lease.token, pa.lease.token);
  console.log('T1 双消费者竞争 ok');
}

// T2 A 断连后 B 接管：epoch 单调 +1、token 轮换
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  t.tick(1001); // 超过 TTL，A 停发
  t.box.call('a2', {});
  const pb = t.box.poll({ consumerId: 'pageB' });
  assert.equal(pb.calls.length, 1);
  assert.equal(pb.lease.epoch, 2);
  assert.notEqual(pb.lease.token, pa.lease.token);
  console.log('T2 断连接管 ok');
}

// T3 旧 epoch 回执拒绝：旧 token POST → fenced，results 不写入
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const callId = pa.calls[0].id;
  t.tick(1001);
  t.box.call('a2', {});
  const pb = t.box.poll({ consumerId: 'pageB' });
  assert.equal(pb.lease.epoch, 2);
  const old = t.box.post({ id: callId, token: pa.lease.token, result: { ok: true, poisoned: true } });
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'fenced');
  // 未被污染回执覆盖：仍是接管时写入的明确失败
  const rd = t.box.read(callId);
  assert.equal(rd.ready, true);
  assert.deepEqual(rd.result, { ok: false, reason: 'lease-taken-over' });
  assert.equal(t.diags.some((d) => d.includes('fenced')), true);
  console.log('T3 旧 epoch 回执拒绝 ok');
}

// T4 接管后旧任务明确失败：A poll 未回执即断连，B 接管时写 lease-taken-over，调用方 read 得明确失败
// （真机事故形态：旧页已 poll 未回执、新页接管的竞态）
{
  const t = makeLeaseInbox(1000);
  t.box.call('l2d_act', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const callId = pa.calls[0].id;
  t.tick(1001); // A 断连
  const pb = t.box.poll({ consumerId: 'pageB' }); // B 接管
  assert.equal(pb.lease.epoch, 2);
  const read = t.box.read(callId);
  assert.equal(read.ready, true);
  assert.equal(read.result.ok, false);
  assert.equal(read.result.reason, 'lease-taken-over');
  // 旧 A 迟到回执：连 token 轮换带已有结果，双重拒绝
  assert.equal(t.box.post({ id: callId, token: pa.lease.token, result: { ok: true } }).ok, false);
  console.log('T4 接管后旧任务明确失败 ok');
}

// T5 token 优先于 epoch：伪造旧 epoch + 旧 token 拒绝；新 token + 旧 epoch 通过
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const id1 = pa.calls[0].id;
  t.tick(1001);
  t.box.call('a2', {});
  const pb = t.box.poll({ consumerId: 'pageB' });
  const id2 = pb.calls[0].id;
  // 报对旧 epoch 号但 token 对不上 → 拒
  assert.equal(t.box.post({ id: id1, epoch: 1, token: pa.lease.token, result: { ok: true } }).ok, false);
  // token 正确、epoch 字段错误（诊断字段不参与判定）→ 收
  assert.equal(t.box.post({ id: id2, epoch: 999, token: pb.lease.token, result: { ok: true } }).ok, true);
  console.log('T5 token 优先于 epoch ok');
}

// T6 flag 关 = 现行为：双页并发 poll 整批发放、无 token 任意回执照收
{
  const t = makeLeaseInbox(1000);
  t.setFlag(false);
  t.box.call('a1', {});
  const p1 = t.box.poll({ consumerId: 'pageA' });
  assert.equal(p1.calls.length, 1);
  assert.equal(p1.lease, undefined); // 无租约字段
  t.box.call('a2', {});
  const p2 = t.box.poll({ consumerId: 'pageB' });
  assert.equal(p2.calls.length, 1); // 不拦截，整批 splice 语义
  // 任意 id（含没 poll 过的）无 token 回执照收
  assert.equal(t.box.post({ id: p1.calls[0].id, result: { ok: true } }).ok, true);
  assert.equal(t.box.post({ id: 999, result: { ok: true } }).ok, true);
  console.log('T6 flag 关等价 ok');
}

// T7 旧版本 overlay 降级：无 consumerId poll → 空队列不 403；其无 token 回执走宽容期
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  t.box.poll({ consumerId: 'pageA' }); // 新页持租约
  const legacy = t.box.poll(); // 旧 overlay：无 consumerId
  assert.deepEqual(legacy.calls, []);
  assert.equal(legacy.lease.status, 'held');
  // 旧页对「没被自己 poll 过」的 id 回执：宽容期内真 id 照收
  const t2 = makeLeaseInbox(1000);
  const q = t2.box.call('a1', {});
  assert.equal(t2.box.post({ id: q.id, result: { ok: true } }).ok, true);
  assert.equal(t2.diags.some((d) => d.includes('legacy-grace')), true);
  console.log('T7 旧 overlay 降级 ok');
}

// T8 断连 TTL 清理：任持期内超 4×TTL 未回执条目被清写 lease-taken-over，Map 不无界增长
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const staleId = pa.calls[0].id;
  // A 持续续期（间隔 < TTL），但该 call 始终不回执 → 条目老化超过 4×TTL
  for (let i = 0; i < 10; i++) {
    t.tick(500);
    t.box.poll({ consumerId: 'pageA' }); // R2 续期 + 清扫检查
  }
  const read = t.box.read(staleId);
  assert.equal(read.ready, true);
  assert.equal(read.result.reason, 'lease-taken-over');
  // 接管时全量清写：剩余未回执条目也拿到明确失败
  t.box.call('a2', {});
  const pa2 = t.box.poll({ consumerId: 'pageA' });
  assert.equal(pa2.lease.epoch, 1); // 全程未被接管
  t.tick(1001);
  t.box.poll({ consumerId: 'pageB' });
  assert.deepEqual(t.box.read(pa2.calls[0].id).result, { ok: false, reason: 'lease-taken-over' });
  console.log('T8 断连 TTL 清理 ok');
}

// T9 同版本双页不互踩：同 ?v= 两页各生成 consumerId，先者持租约期内后者恒空，TTL 到后后者接管
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const p1 = t.box.poll({ consumerId: 'c-1111' }); // 同一 ?v= 的页面 1
  assert.equal(p1.calls.length, 1);
  const p2 = t.box.poll({ consumerId: 'c-2222' }); // 页面 2（同版本，仅 id 不同）
  assert.deepEqual(p2.calls, []);
  assert.equal(p2.lease.status, 'held');
  t.tick(1001);
  t.box.call('a2', {});
  const p2b = t.box.poll({ consumerId: 'c-2222' }); // 页面 1 关页后页面 2 接管
  assert.equal(p2b.calls.length, 1);
  assert.equal(p2b.lease.epoch, 2);
  console.log('T9 同版本双页 ok');
}

// T10 宽容期边界：期内真 id 照收 + diag、未来 id 拒；期后一律 fenced
{
  const grace = 100;
  const t = makeLeaseInbox(1000, { legacyGraceMs: grace });
  const real = t.box.call('a1', {}).id;
  const future = t.box.call('a2', {}).id + 100; // 伪造未来 id（call 也行，id 只增）
  assert.equal(t.box.post({ id: real, result: { ok: true } }).ok, true);
  assert.equal(t.box.post({ id: future, result: { ok: true } }).ok, false);
  t.tick(grace + 1);
  const real2 = t.box.call('a3', {}).id;
  assert.equal(t.box.post({ id: real2, result: { ok: true } }).ok, false);
  assert.equal(t.box.post({ id: real2, token: 'lease-9-forged', result: { ok: true } }).ok, false);
  console.log('T10 宽容期边界 ok');
}

// T11 先到先得：同 id 两次合法 result，第二次 fenced
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const id = pa.calls[0].id;
  assert.equal(t.box.post({ id, token: pa.lease.token, result: { ok: true, v: 1 } }).ok, true);
  assert.equal(t.box.post({ id, token: pa.lease.token, result: { ok: true, v: 2 } }).ok, false);
  // read 消费后也不得覆盖（污染回执封堵）
  assert.equal(t.box.read(id).result.v, 1);
  assert.equal(t.box.post({ id, token: pa.lease.token, result: { ok: true, v: 3 } }).ok, false);
  console.log('T11 先到先得 ok');
}

// T12 flag 热切换：开→关 立即恢复基线；关→开 重新记 grace 起点
{
  const grace = 100;
  const t = makeLeaseInbox(1000, { legacyGraceMs: grace });
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const id = pa.calls[0].id;
  t.tick(50);
  t.setFlag(false); // 关：立即基线
  t.box.call('a2', {});
  assert.equal(t.box.poll().calls.length, 1); // 无租约字段拦截，整批 splice
  assert.equal(t.box.post({ id: 42, result: { ok: true } }).ok, true); // 任意 id 照收
  t.tick(200); // 已越过原 grace 窗口
  t.setFlag(true); // 再开：grace 重新计时
  const real = t.box.call('a3', {}).id;
  assert.equal(t.box.post({ id: real, result: { ok: true } }).ok, true); // 新窗口内照收
  // 旧 token 已不被认（token 属旧 flag 期的归属记录，id 早已无主）
  t.tick(grace + 1);
  const real2 = t.box.call('a4', {}).id;
  assert.equal(t.box.post({ id: real2, result: { ok: true } }).ok, false); // 新窗口过期 fenced
  assert.equal(id, 1); // 顺序 sanity
  console.log('T12 flag 热切换 ok');
}

// 补充：接管必须携带 consumerId——无 consumerId 的 poll 不能借过期「无主」状态抢到调用
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  t.box.poll({ consumerId: 'pageA' });
  t.tick(1001); // 租约过期
  const anon = t.box.poll(); // 旧 overlay 赶上过期窗口
  assert.deepEqual(anon.calls, []);
  assert.equal(anon.lease.status, 'held');
  // 随后合法消费者仍能接管
  t.box.call('a2', {});
  assert.equal(t.box.poll({ consumerId: 'pageB' }).calls.length, 1);
  console.log('补充 无 consumerId 不可接管 ok');
}

// ---------------------------------------------------------------- main 侧回执语义（CODE-REVIEW-1 #13/#14/#15，与租约路径融合）

// CODE-REVIEW-1 #13：event 与 result 同一条 post 都要落，result 不得被静默丢弃
{
  const b2 = createAiInbox();
  b2.call('l2d_act', {});
  const id2 = b2.poll().calls[0].id;
  b2.post({ id: id2, event: { phase: 'start' }, result: { ok: true } });
  const r2 = b2.read(id2);
  assert.equal(r2.ready, true, 'event+result 并存时 result 必须落库');
  assert.equal(r2.result.ok, true);
  assert.equal(r2.events.length, 1);
}

// CODE-REVIEW-1 #14：result 为合法 falsy（false/0）时原样保留，不得被篡改
{
  const b3 = createAiInbox();
  b3.call('l2d_get_state', {});
  const id3 = b3.poll().calls[0].id;
  b3.post({ id: id3, result: false });
  assert.equal(b3.read(id3).result, false, 'false 结果不得被替换');
  b3.call('l2d_get_state', {});
  const id4 = b3.poll().calls[0].id;
  b3.post({ id: id4, result: 0 });
  assert.equal(b3.read(id4).result, 0, '0 结果不得被替换');
}

// CODE-REVIEW-1 #15：队列溢出必须显式带 dropped 计数
{
  const b5 = createAiInbox({ maxQueue: 2 });
  b5.call('l2d_act', { n: 1 });
  b5.call('l2d_act', { n: 2 });
  const overflow = b5.call('l2d_act', { n: 3 });
  assert.equal(overflow.ok, true);
  assert.equal(overflow.dropped, 1, '溢出丢弃必须反馈 dropped 计数');
  assert.deepEqual(b5.poll().calls.map((c) => c.args.n), [2, 3]);
}

// ---------------------------------------------------------------- 回执时序修复回归（ownedCalls 过早删除）
// TL1：result 受理后，end/interrupted event 晚到（带受理时 token）→ 放行落库
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const token = pa.lease.token;
  const callId = pa.calls[0].id;
  assert.equal(t.box.post({ id: callId, token, result: { ok: true } }).ok, true);
  // 晚到 event：归属已删，但 answeredTokens 仍记着受理时 token → 必须放行
  const late = t.box.post({ id: callId, token, event: { phase: 'end' } });
  assert.equal(late.ok, true, '晚到 end event 凭受理时 token 必须放行（不得 stale-token fence）');
  const r = t.box.read(callId);
  assert.equal(r.result.ok, true);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { phase: 'end' });
  console.log('TL1 result 后晚到 event ok');
}

// TL2：仅 event 的 post 不得销毁归属 → 随后 result 正常受理（修复前会被 stale-token fence）
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const token = pa.lease.token;
  const callId = pa.calls[0].id;
  assert.equal(t.box.post({ id: callId, token, event: { phase: 'start' } }).ok, true);
  assert.equal(t.box.post({ id: callId, token, result: { ok: true } }).ok, true,
    'event 先到后 result 必须正常受理（不得被 stale-token fence）');
  const r = t.box.read(callId);
  assert.equal(r.ready, true);
  assert.equal(r.result.ok, true);
  assert.equal(r.events.length, 1);
  console.log('TL2 event 先到不销毁归属 ok');
}

// TL3：接管后 token 轮换，旧 token 的晚到 event 仍被 fence（answeredTokens 随 takeover 清空）
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const oldToken = pa.lease.token;
  const callId = pa.calls[0].id;
  assert.equal(t.box.post({ id: callId, token: oldToken, result: { ok: true } }).ok, true);
  t.tick(1001);
  t.box.call('a2', {});
  const pb = t.box.poll({ consumerId: 'pageB' });
  assert.equal(pb.lease.epoch, 2);
  const stale = t.box.post({ id: callId, token: oldToken, event: { phase: 'end' } });
  assert.equal(stale.ok, false, '接管后旧 token 晚到 event 必须拒绝');
  assert.equal(stale.reason, 'fenced');
  console.log('TL3 接管后旧 token 晚到 event 拒绝 ok');
}

// TL4：伪造 token / 无 token 的晚到 event 不走放行分支
{
  const t = makeLeaseInbox(1000);
  t.box.call('a1', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const token = pa.lease.token;
  const callId = pa.calls[0].id;
  assert.equal(t.box.post({ id: callId, token, result: { ok: true } }).ok, true);
  const forged = t.box.post({ id: callId, token: 'lease-99-forged', event: { phase: 'end' } });
  assert.equal(forged.ok, false, '伪造 token 晚到 event 必须拒绝');
  const noToken = t.box.post({ id: callId, event: { phase: 'end' } });
  assert.equal(noToken.ok, false, '无 token 落宽容期分支，但 id 已有 result → already-answered fence（既有设计）');
  console.log('TL4 伪造/无 token 分流 ok');
}

// CODE-REVIEW-1 #13 伴随收紧：既无 event 也无 result 的 post 拒绝（原为静默 ok:true）
assert.equal(inbox.post({ id: 999 }).ok, false);

// ---------------------------------------------------------------- 完成事件订阅（PR-D，issue #33）

// SB1：observe 旁路通知——event/result 落账即推送，且不消费数据（read 语义不变）
{
  const box = createAiInbox();
  const got = [];
  const unsub = box.observe(7, (entry) => got.push(entry));
  box.call('l2d_act', {});
  box.post({ id: 7, event: { type: 'action-done', phase: 'start' } });
  box.post({ id: 7, result: { ok: true, accepted: true } });
  box.post({ id: 7, event: { type: 'action-done', phase: 'end', completionSource: 'runtime-event' } });
  assert.equal(got.length, 3, '三次落账三次通知');
  assert.equal(got[0].kind, 'event');
  assert.equal(got[1].kind, 'result');
  assert.equal(got[2].event.phase, 'end');
  // 数据未被消费：read 仍拿到完整 result + events（旁路语义的关键）
  const drained = box.read(7);
  assert.equal(drained.ready, true);
  assert.equal(drained.result.accepted, true);
  assert.equal(drained.events.length, 2);
  unsub();
  box.post({ id: 7, event: { type: 'action-done', phase: 'interrupted' } });
  assert.equal(got.length, 3, '退订后不再通知');
  console.log('SB1 observe 旁路通知/不消费/退订 ok');
}

// SB2：subscribeCompletion 终态 resolve——end 携带 completionSource/ownedParams，onEvent 透传
{
  const box = createAiInbox();
  const seen = [];
  const p = box.subscribeCompletion(11, (e) => seen.push(e));
  box.post({ id: 11, result: { ok: true, accepted: true } });
  box.post({ id: 11, event: { type: 'action-done', phase: 'end', completionSource: 'runtime-event', ownedParams: [] } });
  const r = await p;
  assert.equal(r.phase, 'end');
  assert.equal(r.completionSource, 'runtime-event');
  assert.equal(seen.length, 1, 'start 缺席时 onEvent 只收终态一次');
  console.log('SB2 终态 resolve + onEvent 透传 ok');
}

// SB3：interrupted / failed 三态都 resolve 终态（PR-A）
{
  const box = createAiInbox();
  const pInt = box.subscribeCompletion(22, () => {});
  box.post({ id: 22, event: { type: 'action-done', phase: 'interrupted', reason: 'stop-called' } });
  assert.equal((await pInt).phase, 'interrupted');
  const pFail = box.subscribeCompletion(23, () => {});
  box.post({ id: 23, event: { type: 'action-done', phase: 'failed', reason: 'start-rejected' } });
  assert.equal((await pFail).phase, 'failed');
  console.log('SB3 interrupted/failed 三态 ok');
}

// SB4：拒绝 result 落账（订阅已注册）→ 立即 resolve null（拒绝无 event，免白等）
{
  const box = createAiInbox();
  const t0 = Date.now();
  const p = box.subscribeCompletion(31, () => {}, { deadlineMs: 5000 });
  box.post({ id: 31, result: { ok: false, accepted: false, reason: 'priority-blocked' } });
  const r = await p;
  assert.equal(r, null, '拒绝 → null 落轮询降级');
  assert.ok(Date.now() - t0 < 1000, '拒绝必须即时放行，不等 deadline');
  console.log('SB4 拒绝即时放行 ok');
}

// SB5：拒绝 result 已落账（订阅晚到竞态）→ 注册时 peek 立即 resolve null
{
  const box = createAiInbox();
  box.post({ id: 41, result: { ok: false, accepted: false, reason: 'empty-chain' } });
  const p = box.subscribeCompletion(41, () => {}, { deadlineMs: 5000 });
  assert.equal(await p, null, '注册时 peek 到拒绝立即放行');
  console.log('SB5 存量拒绝 peek ok');
}

// SB6：存量 events 补交付——订阅晚于事件到达的竞态窗口
{
  const box = createAiInbox();
  box.call('l2d_act', {});
  box.post({ id: 51, event: { type: 'action-done', phase: 'end', completionSource: 'runtime-event', ownedParams: ['Param4'] } });
  const seen = [];
  const r = await box.subscribeCompletion(51, (e) => seen.push(e), { deadlineMs: 5000 });
  assert.equal(r.phase, 'end');
  assert.deepEqual(r.ownedParams, ['Param4']);
  assert.equal(seen.length, 1, '存量事件补交付触发终态');
  console.log('SB6 存量事件补交付 ok');
}

// SB7：signal abort → resolve null；deadline 超时 → resolve null（fail-closed 兜底）
{
  const box = createAiInbox();
  const ac = new AbortController();
  const p1 = box.subscribeCompletion(61, () => {}, { signal: ac.signal, deadlineMs: 30000 });
  ac.abort();
  assert.equal(await p1, null, 'abort → null');
  const t0 = Date.now();
  const p2 = box.subscribeCompletion(62, () => {}, { deadlineMs: 30 });
  assert.equal(await p2, null, 'deadline → null');
  assert.ok(Date.now() - t0 < 1000, 'deadline 生效，不挂死');
  console.log('SB7 abort/deadline 兜底 ok');
}

// SB8：lease 接管写失败回执 → 订阅立即 resolve null（等待者不悬到 deadline）
{
  const t = makeLeaseInbox(1000);
  t.box.call('l2d_act', {});
  const pa = t.box.poll({ consumerId: 'pageA' });
  const callId = pa.calls[0].id;
  const p = t.box.subscribeCompletion(callId, () => {}, { deadlineMs: 5000 });
  t.box.poll({ consumerId: 'pageB' }); // pageB 接管 → pageA 未回执 call 写 lease-taken-over
  assert.equal(await p, null, '接管失败回执 → null 落轮询');
  console.log('SB8 接管失败回执通知 ok');
}


// ---------------------------------------------------------------- 指令派发租约（多标签页 / 前台抢占 / 过期转移）
function makeTabs(overrides = {}) {
  let now = 5000;
  const diags = [];
  const box = createAiInbox({ leaseTtlMs: 3000, leaseEnabled: () => true, now: () => now, diag: (m) => diags.push(m), ...overrides });
  return { box, diags, tick(ms) { now += ms; }, poll: (id, fg) => box.poll({ consumerId: id, foreground: fg }) };
}

// L1 三个标签页：同一时刻只有一个持有者，其余返回空 + no-lease；指令只发给持有者
{
  const t = makeTabs();
  const a = t.poll('tabA', false);
  assert.ok(a.lease.token);
  for (let i = 0; i < 5; i++) {
    t.box.call('l2d_act', { i });
    t.tick(400);
    const b = t.poll('tabB', false);
    const c = t.poll('tabC', false);
    assert.deepEqual([b.calls.length, b.reason, c.calls.length, c.reason], [0, 'no-lease', 0, 'no-lease']);
    assert.equal(b.lease.status, 'held');
    assert.ok(b.lease.expiresInMs > 0 && b.lease.expiresInMs <= 3000);
    const got = t.poll('tabA', false);
    assert.equal(got.calls.length, 1, '持有者心跳续期并取到指令');
    assert.equal(got.lease.token, a.lease.token);
  }
  assert.equal(t.box.leaseInfo().epoch, 1);
  console.log('L1 多标签页单一持有者 ok');
}

// L2 前台抢占后台：后台持有者已领出未回执的指令写明确失败；旧 token 回执被 fence；前台之间不互抢
{
  const t = makeTabs();
  const bg = t.poll('bgTab', false);
  t.box.call('l2d_regions_act', {});
  const issued = t.poll('bgTab', false).calls;
  assert.equal(issued.length, 1);
  t.box.call('l2d_act', {}); // 还在队列里、没领出
  const fg = t.poll('fgTab', true);
  assert.equal(fg.lease.epoch, 2, '前台页立即接管');
  assert.deepEqual(fg.calls.map((c) => c.name), ['l2d_act'], '队列里的指令发给新持有者');
  assert.deepEqual(t.box.read(issued[0].id).result, { ok: false, reason: 'lease-taken-over' }, '已领出未回执 → 明确失败');
  assert.equal(t.box.post({ id: issued[0].id, token: bg.lease.token, result: { ok: true } }).reason, 'fenced');
  assert.equal(t.poll('bgTab', false).reason, 'no-lease', '后台页不能抢回');
  assert.equal(t.poll('fg2', true).reason, 'no-lease', '前台页不抢前台持有者');
  // 持有者切到后台 → 另一个前台页可抢
  t.poll('fgTab', false);
  assert.equal(t.poll('fg2', true).lease.epoch, 3);
  assert.ok(t.diags.some((d) => /foreground-preempt/.test(d)));
  console.log('L2 前台抢占后台 ok');
}

// L3 过期转移：约 3 秒没续期 → 下一个页面接手；未过期前不转移
{
  const t = makeTabs();
  t.poll('tabA', true);
  t.box.call('x', {});
  const pending = t.poll('tabA', true).calls[0];
  t.tick(2900);
  assert.equal(t.poll('tabB', true).reason, 'no-lease', '2.9s 内仍归 A');
  t.tick(200);
  const b = t.poll('tabB', false);
  assert.equal(b.lease.epoch, 2, '超过 3s 未续期 → 交给 B（后台页也能接）');
  assert.deepEqual(t.box.read(pending.id).result, { ok: false, reason: 'lease-taken-over' });
  assert.ok(t.diags.some((d) => /lease expired/.test(d)));
  console.log('L3 过期转移 ok');
}

// L4 持有者过期后回来、期间没人接手：同 token 续上，已领出的指令照常回执
{
  const t = makeTabs();
  const a = t.poll('tabA', false);
  t.box.call('slow', {});
  const c = t.poll('tabA', false).calls[0];
  t.tick(10000); // 后台节流，很久没 poll
  const back = t.poll('tabA', false);
  assert.equal(back.lease.token, a.lease.token);
  assert.equal(t.box.post({ id: c.id, token: a.lease.token, result: { ok: true } }).ok, true);
  assert.deepEqual(t.box.read(c.id).result, { ok: true });
  console.log('L4 过期后原持有者续上 ok');
}

// L5 回执晚到不误判失联：ownedStaleMs 单独配置（宿主 60s）；超过才写失败
{
  const t = makeTabs({ ownedStaleMs: 60000 });
  t.poll('tabA', true);
  t.box.call('awaitDone', {});
  const c = t.poll('tabA', true).calls[0];
  for (let i = 0; i < 40; i++) { t.tick(1000); t.poll('tabA', true); }
  assert.deepEqual(t.box.read(c.id), { ready: false }, '40s 仍在等回执，没有误判');
  for (let i = 0; i < 25; i++) { t.tick(1000); t.poll('tabA', true); }
  assert.equal(t.box.read(c.id).result.reason, 'lease-taken-over');
  console.log('L5 回执晚到保留期 ok');
}

// L6 旧 overlay（不带 foreground）视作后台：不抢占；无 consumerId 永远 no-lease
{
  const t = makeTabs();
  t.poll('tabA', false);
  assert.equal(t.box.poll({ consumerId: 'legacy' }).reason, 'no-lease');
  assert.equal(t.box.poll().reason, 'no-lease');
  console.log('L6 旧 overlay 降级 ok');
}

// L7 接线：宿主默认开租约（只有显式 false 才关）、TTL 3s；/ai/poll 读 fg；overlay 带 visibilityState
{
  const idx = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const ov = fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');
  assert.match(idx, /leaseEnabled: \(\) => readSettings\(\)\.consumerLeaseEnabled !== false/);
  assert.match(idx, /leaseTtlMs: 3000/);
  assert.match(idx, /consumerLeaseEnabled: \{ type: 'boolean', default: true/);
  assert.match(idx, /foreground = sp\.get\('fg'\) === '1'/);
  assert.match(ov, /'&fg=' \+ \(aiPageForeground\(\) \? '1' : '0'\)/);
  assert.match(ov, /document\.visibilityState === 'visible'/);
  console.log('L7 宿主 / overlay 接线 ok');
}

console.log('ai-inbox ok');
