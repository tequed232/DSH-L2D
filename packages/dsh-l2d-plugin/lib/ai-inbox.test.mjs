import assert from 'node:assert/strict';
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

console.log('ai-inbox ok');
