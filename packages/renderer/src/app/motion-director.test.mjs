import assert from 'node:assert/strict';
import {
  MotionDirector,
  motionsShareArm,
  closesToPlayBefore,
  poseParamsForGroup,
} from './motion-director.ts';
import { PoseController } from './pose-controller.ts';

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('  ok  ' + name))
    .catch((err) => {
      console.error('  FAIL ' + name);
      throw err;
    });
}

async function yieldSharedArmThenPlay(director, play, group, opts = {}) {
  const closes = closesToPlayBefore(group, director.slotStates());
  for (const name of closes) {
    await play(name, { awaitFinish: true, interrupt: true });
  }
  const result = await play(group, opts);
  return Object.assign(result, { yieldedCloses: closes });
}

function makePlayer(director, hooks = {}) {
  const played = [];
  const play = (group, opts = {}) => {
    const decision = director.decide(group);
    if (decision.status === 'skipped' || decision.status === 'conflict') {
      played.push({ group, status: decision.status, reason: decision.reason, opts });
      return Promise.resolve({
        status: decision.status,
        reason: decision.reason,
        slot: decision.slot,
        dir: decision.dir,
        group: decision.targetGroup,
      });
    }
    director.commit(decision.targetGroup || group);
    played.push({ group, status: 'ok', opts });
    if (typeof hooks.onPlay === 'function') hooks.onPlay(group);
    return Promise.resolve({
      status: 'ok',
      slot: decision.slot,
      dir: decision.dir,
      group: decision.targetGroup || group,
    });
  };
  return { played, play };
}

console.log('motion-director 手臂让位');

await test('motionsShareArm：竖手指与狗尾巴草共用右臂，与抚胸手不共用', () => {
  assert.equal(motionsShareArm('竖手指打开', '狗尾巴草打开'), true);
  assert.equal(motionsShareArm('竖手指关闭', '狗尾巴草打开'), true);
  assert.equal(motionsShareArm('抚胸手打开', '竖手指打开'), false);
  assert.equal(motionsShareArm('抚胸手打开', '狗尾巴草打开'), false);
  assert.equal(motionsShareArm('竖手指打开', '竖手指关闭'), true);
});

await test('closesToPlayBefore：共用手臂 → 先收尾前一个关闭动作', () => {
  const states = { 抚胸手: 'closed', 竖手指: 'open', 狗尾巴草: 'closed' };
  assert.deepEqual(closesToPlayBefore('狗尾巴草打开', states), ['竖手指关闭']);
  assert.deepEqual(closesToPlayBefore('抚胸手打开', states), []);
});

await test('closesToPlayBefore：不共用手臂 → 不收尾，允许叠加', () => {
  const states = { 抚胸手: 'open', 竖手指: 'closed', 狗尾巴草: 'closed' };
  assert.deepEqual(closesToPlayBefore('竖手指打开', states), []);
  assert.deepEqual(closesToPlayBefore('狗尾巴草打开', states), []);
});

await test('closesToPlayBefore：同槽打开/关闭不先关掉自己', () => {
  const states = { 抚胸手: 'closed', 竖手指: 'open', 狗尾巴草: 'closed' };
  assert.deepEqual(closesToPlayBefore('竖手指打开', states), []);
  assert.deepEqual(closesToPlayBefore('竖手指关闭', states), []);
});

await test('poseParamsForGroup：只返回该槽姿态骨', () => {
  const right = poseParamsForGroup('竖手指打开');
  const left = poseParamsForGroup('抚胸手打开');
  assert.ok(right.includes('Param36'));
  assert.ok(!right.includes('Param59'));
  assert.ok(left.includes('Param59'));
  assert.ok(!left.includes('Param36'));
  assert.deepEqual(poseParamsForGroup('未知动作'), []);
});

await test('播放序列：共用手臂 → 先关闭再打开，槽位正确切换', async () => {
  const director = new MotionDirector();
  const { played, play } = makePlayer(director);
  assert.equal((await play('竖手指打开')).status, 'ok');
  const second = await yieldSharedArmThenPlay(director, play, '狗尾巴草打开');
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.yieldedCloses, ['竖手指关闭']);
  assert.deepEqual(
    played.map((item) => item.group),
    ['竖手指打开', '竖手指关闭', '狗尾巴草打开'],
  );
  assert.equal(played[1].opts.interrupt, true);
  assert.equal(played[1].opts.awaitFinish, true);
  const slots = director.slotStates();
  assert.equal(slots['竖手指'], 'closed');
  assert.equal(slots['狗尾巴草'], 'open');
  assert.equal(slots['抚胸手'], 'closed');
});

await test('播放序列：不共用手臂 → 直接叠加，两槽都 open', async () => {
  const director = new MotionDirector();
  const { played, play } = makePlayer(director);
  assert.equal((await play('抚胸手打开')).status, 'ok');
  const second = await yieldSharedArmThenPlay(director, play, '竖手指打开');
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.yieldedCloses, []);
  assert.deepEqual(
    played.map((item) => item.group),
    ['抚胸手打开', '竖手指打开'],
  );
  const slots = director.slotStates();
  assert.equal(slots['抚胸手'], 'open');
  assert.equal(slots['竖手指'], 'open');
});

await test('播放序列：共用手臂切换时保持表情，不走全身重置', async () => {
  const director = new MotionDirector();
  const flags = { expression: '兔牙', form: 1, reset: 0, cleared: 0 };
  const { play } = makePlayer(director, {
    onPlay() {
      /* 播放路径不得清表情/体型 */
    },
  });
  await play('竖手指打开');
  await yieldSharedArmThenPlay(director, play, '狗尾巴草打开');
  assert.equal(flags.expression, '兔牙');
  assert.equal(flags.form, 1);
  assert.equal(flags.reset, 0);
  assert.equal(flags.cleared, 0);
});

await test('adoptPreset：只覆盖点名一侧，另一侧姿势保留', () => {
  const pose = new PoseController({ idleReturnSec: 0 });
  pose.adoptPreset({ left: 'chest' });
  const afterLeft = pose.describe();
  assert.equal(afterLeft.left, 'chest');
  pose.adoptPreset({ right: 'finger' });
  const afterBoth = pose.describe();
  assert.equal(afterBoth.right, 'finger', '右臂应换成竖手指终态');
  assert.equal(afterBoth.left, 'chest', '左臂抚胸姿势必须保留');
});

console.log('motion-director 手臂让位 ok');
