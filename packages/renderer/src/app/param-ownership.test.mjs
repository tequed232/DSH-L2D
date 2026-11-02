import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OWN_DURATION_MS, ParamOwnership, selectOwnableIds } from './param-ownership.ts';

test('own / isOwned / release：认领、持有、主动释放', () => {
  const o = new ParamOwnership();
  const t0 = 1_000_000;
  assert.deepEqual(o.own(['RArm', 'LArm'], { durationMs: 1000, now: t0 }), ['RArm', 'LArm']);
  assert.equal(o.isOwned('RArm', t0 + 10), true);
  assert.equal(o.isOwned('RHand', t0 + 10), false);
  assert.deepEqual(o.release(['RArm']), ['RArm']);
  assert.equal(o.isOwned('RArm', t0 + 10), false);
  assert.deepEqual(o.list(t0 + 10), ['LArm']);
});

test('到期：到点自动释放，物理接管（expire 返回并清除）', () => {
  const o = new ParamOwnership();
  const t0 = 2_000_000;
  o.own(['ShoulderX'], { durationMs: DEFAULT_OWN_DURATION_MS, now: t0 });
  assert.equal(o.isOwned('ShoulderX', t0 + DEFAULT_OWN_DURATION_MS - 1), true);
  assert.equal(o.isOwned('ShoulderX', t0 + DEFAULT_OWN_DURATION_MS), false);
  assert.equal(o.size(t0 + DEFAULT_OWN_DURATION_MS), 0);

  o.own(['ShoulderY'], { durationMs: 1000, now: t0 });
  assert.deepEqual(o.expire(t0 + 1000), ['ShoulderY']);
  assert.equal(o.isOwned('ShoulderY', t0 + 1000), false);
});

test('被抢/续期：重复认领只延长不缩短；永久持有优先', () => {
  const o = new ParamOwnership();
  const t0 = 3_000_000;
  o.own(['RArm'], { durationMs: 5000, now: t0 }); // 到期 3_005_000
  o.own(['RArm'], { durationMs: 100, now: t0 + 1000 }); // 新请求更短，不应缩短
  assert.equal(o.isOwned('RArm', t0 + 4000), true);
  assert.equal(o.isOwned('RArm', t0 + 5000), false);

  o.own(['RArm'], { durationMs: 0, now: t0 + 5000 }); // 升级为长期持有
  assert.equal(o.isOwned('RArm', t0 + 9_999_999), true);
  o.own(['RArm'], { durationMs: 100, now: t0 + 9_999_999 }); // 长期持有不会被短请求降级
  assert.equal(o.isOwned('RArm', t0 + 9_999_999 + 10_000), true);
});

test('边界：非法 id 跳过；duration<=0 表示长期；releaseAll 清空', () => {
  const o = new ParamOwnership();
  const t0 = 4_000_000;
  assert.deepEqual(o.own(['', '  ', null, undefined, 'RArm '], { durationMs: 1000, now: t0 }), ['RArm']);
  o.own(['LArm'], { durationMs: 0, now: t0 });
  assert.equal(o.isOwned('LArm', t0 + 999_999_999), true);
  assert.deepEqual(o.releaseAll().sort(), ['LArm', 'RArm']);
  assert.equal(o.size(t0), 0);
  assert.deepEqual(o.release(['not-owned']), []);
});

test('相位：默认 post；pre 认领保留相位，供 M1-b 的 Hip 类参数使用', () => {
  const o = new ParamOwnership();
  const t0 = 6_000_000;
  o.own(['RArm'], { durationMs: 1000, now: t0 });
  assert.equal(o.phaseOf('RArm', t0), 'post');
  assert.equal(o.ownerOf('RArm', t0), 'limb');
  o.own(['HipAngleX'], { durationMs: 1000, phase: 'pre', now: t0, runId: 'run-1' });
  const entry = o.snapshot(t0).find((e) => e.id === 'HipAngleX');
  assert.equal(entry.phase, 'pre');
  assert.equal(entry.owner, 'limb');
  assert.equal(entry.runId, 'run-1');
  o.own(['HipAngleX'], { durationMs: 1000, phase: 'pre', now: t0 });
  assert.equal(o.phaseOf('HipAngleX', t0), 'pre');
  assert.equal(o.isOwned('HipAngleX', t0 + 1000), false);
});

test('snapshot：给出 id 与到期时间（0 = 长期）', () => {
  const o = new ParamOwnership();
  const t0 = 5_000_000;
  o.own(['RArm'], { durationMs: 1200, now: t0 });
  o.own(['LArm'], { durationMs: 0, now: t0 });
  const snap = Object.fromEntries(o.snapshot(t0).map((e) => [e.id, e.expiresAt]));
  assert.equal(snap.RArm, t0 + 1200);
  assert.equal(snap.LArm, 0);
});

test('selectOwnableIds：只登记物理输出，非物理/口型/空值被过滤', () => {
  const physics = new Set(['RArm', 'LArm', 'ShoulderX', 'ParamBodyAngleX']);
  const picked = selectOwnableIds(
    ['RArm', ' AngleX ', 'LArm', '', null, undefined, 'ShoulderX', 'ParamBodyAngleX', 'ParamMouthOpenY'],
    (id) => physics.has(id),
  );
  assert.deepEqual(picked, ['RArm', 'LArm', 'ShoulderX', 'ParamBodyAngleX']);
  // 非物理参数不会被 own，保持普通 setParameters(add/set) 语义
  assert.deepEqual(selectOwnableIds(['AngleX', 'PositionX'], () => false), []);
});
