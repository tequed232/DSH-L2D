/**
 * [M1-g / G1] limb 租约 ⇄ injector 粘合层验收（node，无 SDK）。
 *
 * 覆盖 G1 的硬要求：
 *   1. canOwn 三态：物理输出 accept / 姿态层 not-ownable / 共享枢纽 unknown-id（域外）；
 *   2. acquire 成功后同一次调用里 injector.own（否则"回执漂亮、手臂不动"的假通过）；
 *   3. 重复 acquire 同 runId 幂等（size 不增）、release 后 size=0 且 injector 同步释放；
 *   4. 超时自动释放时 injector 联动（LimbController 的 prune 只管自己那张表）；
 *   5. 低优先级不打断高优先级持有；
 *   6. injector 局部拒绝 → 整次回滚（不留半个租约）；
 *   7. flag 关：全部拒绝 + 零 injector 交互（回归安全）。
 *
 * 运行：node --experimental-strip-types packages/renderer/src/app/limb-wiring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LimbController } from '../../../core/src/limb-controller.ts';
import {
  ARM_ALL_PHYSICS,
  ARM_RIGHT_PHYSICS,
  CROSS_DOMAIN,
  MANIFEST_ALL_PHYSICS,
  SHARED_FORBIDDEN,
} from './body-manifest.ts';
import { createLimbWiring } from './limb-wiring.ts';
import { createPhysicsGate } from './motion-adapter.ts';

/** fake injector ownership：记录调用序，可注入"部分拒绝"。 */
function makeSink(options = {}) {
  const owned = new Set();
  const calls = [];
  return {
    owned: () => [...owned],
    calls,
    own(ids, durationMs, phase) {
      calls.push({ op: 'own', ids: [...ids], durationMs, phase });
      const accepted = [];
      for (const id of ids) {
        if (options.reject && options.reject.includes(id)) continue;
        owned.add(id);
        accepted.push(id);
      }
      return accepted;
    },
    release(ids) {
      calls.push({ op: 'release', ids: [...ids] });
      const released = [];
      for (const id of ids) if (owned.delete(id)) released.push(id);
      return released;
    },
  };
}

/** 真实 LimbController + 时钟注入。 */
function makeRig(options = {}) {
  const clock = { t: 1000 };
  const sink = makeSink(options.sink);
  const controller = new LimbController(
    options.limbIds ?? ARM_ALL_PHYSICS,
    {
      enabled: options.enabled !== false,
      isOwnable: options.isOwnable ?? ((id) => MANIFEST_ALL_PHYSICS.has(id)),
      now: () => clock.t,
    },
  );
  const wiring = createLimbWiring({
    controller,
    sink,
    enabled: options.enabled !== false,
    ownedIds: () => sink.owned(),
    now: () => clock.t,
  });
  return { clock, sink, controller, wiring };
}

const ARM_IDS = ['RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2'];

// ---------------------------------------------------------------- 1. canOwn 三态

test('canOwn 三态：物理输出 accept / 姿态层 not-ownable / 共享枢纽 unknown-id', () => {
  // 姿态层要走到 isOwnable 才会被拒 not-ownable，因此白名单里故意多放两个 id，
  // 模拟"调用方把姿态参数/共享枢纽也传进来"的情形——两条防线各自都要给出明确原因。
  const rig = makeRig({ limbIds: [...ARM_ALL_PHYSICS, 'Param36', 'ParamBodyAngleX'] });

  const okRec = rig.wiring.admit({ ids: ARM_IDS });
  assert.equal(okRec.accepted, true);
  assert.deepEqual(okRec.acquired, ARM_IDS);
  rig.wiring.release();

  const poseRec = rig.wiring.admit({ ids: ['Param36'] });
  assert.equal(poseRec.accepted, false);
  assert.deepEqual(poseRec.rejected, [{ id: 'Param36', reason: 'not-ownable' }]);
  assert.equal(poseRec.reason, 'rejected');

  const sharedRec = rig.wiring.admit({ ids: ['ParamBodyAngleX'] });
  assert.equal(sharedRec.accepted, false);
  assert.deepEqual(sharedRec.rejected, [{ id: 'ParamBodyAngleX', reason: 'not-ownable' }]);

  // 而生产配置（白名单=manifest 30 个）下，这两个 id 连白名单都进不去 → unknown-id
  const strict = makeRig();
  const poseOut = strict.wiring.admit({ ids: ['Param36'] });
  assert.deepEqual(poseOut.rejected, [{ id: 'Param36', reason: 'unknown-id' }]);
  const sharedOut = strict.wiring.admit({ ids: ['ParamBodyAngleX'] });
  assert.deepEqual(sharedOut.rejected, [{ id: 'ParamBodyAngleX', reason: 'unknown-id' }]);
  // 共享域里的开关同理
  assert.deepEqual(strict.wiring.admit({ ids: ['Movement1'] }).rejected, [
    { id: 'Movement1', reason: 'unknown-id' },
  ]);

  // 原子：一好一坏 → 整次失败且不留租约
  const mix = strict.wiring.admit({ ids: ['RArm', 'Param36'] });
  assert.equal(mix.accepted, false);
  assert.equal(mix.acquired.length, 0);
  assert.equal(strict.controller.size, 0);
  assert.equal(strict.sink.owned().length, 0, '失败请求必须零 injector 残留');
});

test('CROSS_DOMAIN / SHARED_FORBIDDEN 全部被拒（Param42 不得进 own 通道）', () => {
  const rig = makeRig({ limbIds: [...ARM_ALL_PHYSICS, ...CROSS_DOMAIN, ...SHARED_FORBIDDEN] });
  for (const id of [...CROSS_DOMAIN, ...SHARED_FORBIDDEN]) {
    const rec = rig.wiring.admit({ ids: [id] });
    assert.equal(rec.accepted, false, id + ' 不应被接管');
    assert.equal(rec.acquired.length, 0);
  }
  assert.equal(rig.controller.size, 0);
  assert.equal(rig.sink.owned().length, 0);
});

// ---------------------------------------------------------------- 2. acquire → own → 写

test('acquire 成功即 injector.own(ids, durationMs, post)：先 own 后写（gate.post 顺序）', () => {
  const rig = makeRig();
  const rec = rig.wiring.admit({ ids: ARM_IDS, runId: 'run-A', durationMs: 800 });
  assert.equal(rec.accepted, true);
  assert.equal(rec.runId, 'run-A');
  assert.deepEqual(rig.sink.calls, [{ op: 'own', ids: ARM_IDS, durationMs: 800, phase: 'post' }]);
  assert.deepEqual(rig.sink.owned().sort(), [...ARM_IDS].sort());

  // 登记本帧写值（LimbController.set 的语义），gate.post 才能取到
  rig.controller.set('run-A', { RArm: 0.7, RHand: 0.3 });

  const staged = [];
  const gate = createPhysicsGate(
    { 'embodied.limb': true },
    {
      limb: rig.wiring.control,
      limbWrite: (core, id, value) => staged.push({ core, id, value }),
      // 时钟必须与 wiring/controller 同源，否则 gate 用真实 Date.now 会把租约判成已到期
      now: () => rig.clock.t,
    },
  );
  gate.post({ tag: 'core' });
  assert.deepEqual(staged, [
    { core: { tag: 'core' }, id: 'RArm', value: 0.7 },
    { core: { tag: 'core' }, id: 'RHand', value: 0.3 },
  ]);
  // injector.own 必须早于任何写（否则 injector 会以"物理输出未授权"拒写）
  assert.equal(rig.sink.calls[0].op, 'own');
});

test('admit.values 登记初始目标值；wiring.set 更新（未持有 id 被忽略）', () => {
  const rig = makeRig();
  const rec = rig.wiring.admit({ ids: ARM_IDS, runId: 'run-V', values: { RArm: 0.4, LArm: 1 } });
  assert.equal(rec.accepted, true);
  assert.deepEqual(rec.written, ['RArm'], 'LArm 未持有 → 不得被登记');
  assert.deepEqual([...rig.wiring.resolve()], [['RArm', 0.4]]);

  assert.deepEqual(rig.wiring.set('run-V', { RForearm: -0.25 }), ['RForearm']);
  assert.deepEqual(
    [...rig.wiring.resolve()].sort(),
    [['RArm', 0.4], ['RForearm', -0.25]],
  );
  // 错误 runId 不得改到别人的租约
  assert.deepEqual(rig.wiring.set('other', { RArm: 1 }), []);
  assert.equal(rig.wiring.resolve().get('RArm'), 0.4);
});

test('clamp 钩子在 resolve 出口生效（量程来自 moc3，不在这里猜）', () => {
  const clock = { t: 0 };
  const sink = makeSink();
  const controller = new LimbController(['RArm'], {
    enabled: true,
    isOwnable: () => true,
    clamp: (id, v) => Math.max(-1, Math.min(1, v)),
    now: () => clock.t,
  });
  const wiring = createLimbWiring({ controller, sink, enabled: true, now: () => clock.t });
  const rec = wiring.admit({ ids: ['RArm'], runId: 'run-C' });
  assert.equal(rec.accepted, true);
  controller.set('run-C', { RArm: 5 });
  assert.deepEqual([...wiring.resolve()], [['RArm', 1]]);
});

// ---------------------------------------------------------------- 3. 幂等 / 释放

test('重复 acquire 同 runId 幂等：size 不增、injector 不重复登记；release 清两侧', () => {
  const rig = makeRig();
  rig.wiring.admit({ ids: ARM_IDS, runId: 'run-B' });
  assert.equal(rig.controller.size, ARM_IDS.length);
  const sizeAfterFirst = rig.controller.size;

  const again = rig.wiring.admit({ ids: ARM_IDS, runId: 'run-B' });
  assert.equal(again.accepted, true);
  assert.equal(rig.controller.size, sizeAfterFirst, '同 runId 重复 acquire 不得增长 size');
  assert.equal(rig.sink.owned().length, ARM_IDS.length, 'injector 侧也不得重复登记');

  const rel = rig.wiring.release('run-B');
  assert.equal(rel.ok, true);
  assert.deepEqual([...rel.released].sort(), [...ARM_IDS].sort());
  assert.equal(rig.controller.size, 0);
  assert.equal(rig.sink.owned().length, 0);
  // 释放后 resolve 空表（下一帧物理自然接管，无恢复逻辑）
  assert.equal(rig.wiring.resolve().size, 0);

  // 重复 release 幂等
  const rel2 = rig.wiring.release('run-B');
  assert.deepEqual(rel2.released, []);
  assert.equal(rel2.ok, true);
});

test('release() 无参 = 全释放（reset 语义）', () => {
  const rig = makeRig();
  rig.wiring.admit({ ids: ['RArm'], runId: 'r1' });
  rig.wiring.admit({ ids: ['LArm'], runId: 'r2' });
  assert.equal(rig.controller.size, 2);
  const rel = rig.wiring.release();
  assert.deepEqual([...rel.released].sort(), ['LArm', 'RArm']);
  assert.equal(rig.controller.size, 0);
  assert.equal(rig.sink.owned().length, 0);
});

// ---------------------------------------------------------------- 4. 超时

test('超时自动释放：resolve 把 controller 的到期项同步给 injector（不留漂移）', () => {
  const rig = makeRig();
  rig.wiring.admit({ ids: ['RArm', 'RHand'], runId: 'run-T', durationMs: 500 });
  rig.controller.set('run-T', { RArm: 0.5 });
  rig.clock.t += 400;
  assert.equal(rig.wiring.resolve().size, 1, '未到期仍有写值');
  assert.equal(rig.sink.owned().length, 2);

  rig.clock.t += 200; // 越过 expiresAt
  assert.equal(rig.wiring.resolve().size, 0, '到期后不得再写');
  assert.equal(rig.controller.size, 0);
  assert.equal(rig.sink.owned().length, 0, 'injector 必须跟着到期释放');
  assert.ok(
    rig.sink.calls.some((c) => c.op === 'release' && c.ids.includes('RArm')),
    '到期释放必须显式通知 injector',
  );
});

// ---------------------------------------------------------------- 5. 优先级

test('低优先级不打断高优先级持有（且整次原子失败）', () => {
  const rig = makeRig();
  const high = rig.wiring.admit({ ids: ['RArm'], runId: 'high', priority: 90 });
  assert.equal(high.accepted, true);

  const low = rig.wiring.admit({ ids: ['RArm'], runId: 'low', priority: 10 });
  assert.equal(low.accepted, false);
  assert.deepEqual(low.rejected, [{ id: 'RArm', reason: 'priority-blocked' }]);
  // 高优先级持有不被破坏，injector 仍由 high 持有
  assert.equal(rig.controller.size, 1);
  assert.deepEqual(rig.wiring.snapshot().ownership.RArm.runId, 'high');
  assert.deepEqual(rig.sink.owned(), ['RArm']);

  // 同级/更高可抢占（S-04）
  const force = rig.wiring.admit({ ids: ['RArm'], runId: 'force', priority: 90 });
  assert.equal(force.accepted, true);
  assert.deepEqual(rig.wiring.snapshot().ownership.RArm.runId, 'force');
});

// ---------------------------------------------------------------- 6. injector 回滚

test('injector 局部拒绝 → 整次回滚，不留半个租约（injector-rejected）', () => {
  const rig = makeRig({ sink: { reject: ['RSleeveX2'] } });
  const rec = rig.wiring.admit({ ids: ['RArm', 'RSleeveX2'], runId: 'run-R' });
  assert.equal(rec.accepted, false);
  assert.equal(rec.reason, 'injector-rejected');
  assert.deepEqual(rec.injectorRejected, ['RSleeveX2']);
  assert.equal(rig.controller.size, 0, 'controller 侧必须一起回滚');
  assert.equal(rig.sink.owned().length, 0, 'injector 侧不得残留');
  assert.deepEqual(rig.wiring.resolve().size, 0);
});

// ---------------------------------------------------------------- 7. flag 关

test('flag 关：全部拒绝（limb-disabled）+ 零 injector 交互 + resolve 空表', () => {
  const rig = makeRig({ enabled: false });
  const rec = rig.wiring.admit({ ids: ARM_RIGHT_PHYSICS, runId: 'run-off' });
  assert.equal(rec.accepted, false);
  assert.equal(rec.reason, 'limb-disabled');
  assert.equal(rec.flagEnabled, false);
  assert.equal(rec.acquired.length, 0);
  assert.equal(rec.rejected.length, ARM_RIGHT_PHYSICS.length);
  assert.ok(rec.rejected.every((r) => r.reason === 'disabled'));

  assert.deepEqual(rig.sink.calls, [], 'flag 关必须零 injector 交互');
  assert.equal(rig.wiring.resolve().size, 0);
  assert.deepEqual(rig.sink.calls, [], 'resolve 也不得碰 injector');

  const rel = rig.wiring.release();
  assert.deepEqual(rel.released, []);
  assert.equal(rel.flagEnabled, false);
  assert.deepEqual(rig.sink.calls, []);

  const snap = rig.wiring.snapshot();
  assert.equal(snap.flagEnabled, false);
  assert.equal(snap.size, 0);
  assert.deepEqual(snap.drift, { controllerOnly: [], injectorOnly: [] });

  // flag 关的 PhysicsGate.post 同样零交互
  const gate = createPhysicsGate(
    { 'embodied.limb': false },
    { limb: rig.wiring.control, limbWrite: () => assert.fail('flag 关不得写') },
  );
  gate.post({});
});

// ---------------------------------------------------------------- 8. 漂移诊断

test('snapshot.drift 能发现"只在一侧"的残留（诊断面不能静默）', () => {
  const rig = makeRig();
  rig.wiring.admit({ ids: ['RArm'], runId: 'run-D' });
  assert.deepEqual(rig.wiring.snapshot().drift, { controllerOnly: [], injectorOnly: [] });

  // 模拟 injector 侧被别处释放（例如 reset 只清了 injector）
  rig.sink.release(['RArm']);
  const drift = rig.wiring.snapshot();
  assert.deepEqual(drift.drift.controllerOnly, ['RArm']);
  assert.equal(drift.size, 1);
});
