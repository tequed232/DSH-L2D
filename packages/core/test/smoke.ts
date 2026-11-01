/**
 * ParamMixer 冒烟测试（零依赖，不需要测试框架）
 * 运行：node --experimental-strip-types packages/core/test/smoke.ts
 */
import assert from 'node:assert/strict';
import { ParamMixer, CHANNEL_PRIORITY } from '../src/index.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
};

console.log('\nParamMixer 冒烟测试\n');

test('口型硬覆盖：压过面捕写入', () => {
  const mixer = new ParamMixer({
    ranges: { ParamMouthOpenY: { min: 0, max: 1 } },
    timeConstants: { ParamMouthOpenY: 0 },
  });
  mixer.upsert({
    id: 'tracking',
    priority: CHANNEL_PRIORITY.tracking,
    mode: 'override',
    values: { ParamMouthOpenY: 0.2 },
  });
  mixer.upsert({
    id: 'lipsync',
    priority: CHANNEL_PRIORITY.lipsync,
    mode: 'override',
    hardLock: true,
    values: { ParamMouthOpenY: 0.9 },
  });

  const snap = mixer.step(16);
  assert.equal(snap.values.ParamMouthOpenY, 0.9, '口型应胜出');
  assert.equal(snap.owners.ParamMouthOpenY, 'lipsync');
});

test('动作锁：高优先级硬锁后，低优先级写入被跳过', () => {
  const mixer = new ParamMixer({ timeConstants: { ParamAngleX: 0 } });
  mixer.upsert({
    id: 'motion',
    priority: CHANNEL_PRIORITY.motion,
    mode: 'override',
    hardLock: true,
    values: { ParamAngleX: 25 },
  });
  mixer.upsert({
    id: 'tracking',
    priority: CHANNEL_PRIORITY.tracking,
    mode: 'override',
    values: { ParamAngleX: -30 },
  });

  const snap = mixer.step(16);
  assert.equal(snap.values.ParamAngleX, 25);
  assert.ok(snap.skippedWrites >= 1, '应记录被跳过的写入');
});

test('add 模式在已有值上叠加', () => {
  const mixer = new ParamMixer({ timeConstants: { ParamBreath: 0 } });
  mixer.upsert({
    id: 'idle',
    priority: CHANNEL_PRIORITY.idle,
    mode: 'override',
    values: { ParamBreath: 0.4 },
  });
  mixer.upsert({
    id: 'procedural',
    priority: CHANNEL_PRIORITY.procedural,
    mode: 'add',
    weight: 0.5,
    values: { ParamBreath: 0.4 },
  });

  const snap = mixer.step(16);
  assert.ok(Math.abs(snap.values.ParamBreath - 0.6) < 1e-9, `期望 0.6，实际 ${snap.values.ParamBreath}`);
});

test('范围裁剪生效', () => {
  const mixer = new ParamMixer({
    ranges: { ParamAngleX: { min: -30, max: 30 } },
    timeConstants: { ParamAngleX: 0 },
  });
  mixer.upsert({
    id: 'tracking',
    priority: CHANNEL_PRIORITY.tracking,
    mode: 'override',
    values: { ParamAngleX: 999 },
  });

  assert.equal(mixer.step(16).values.ParamAngleX, 30);
});

test('平滑：不会一帧跳到目标', () => {
  const mixer = new ParamMixer({ timeConstants: { ParamAngleX: 120 } });
  mixer.upsert({
    id: 'tracking',
    priority: CHANNEL_PRIORITY.tracking,
    mode: 'override',
    values: { ParamAngleX: 30 },
  });

  const first = mixer.step(16).values.ParamAngleX;
  assert.ok(first > 0 && first < 30, `首帧应处于中间态，实际 ${first}`);

  let last = first;
  for (let i = 0; i < 60; i++) last = mixer.step(16).values.ParamAngleX;
  assert.ok(Math.abs(last - 30) < 0.5, `1 秒后应接近目标，实际 ${last}`);
});

test('口型时间常数走默认规则（比头部快）', () => {
  const mixer = new ParamMixer();
  mixer.upsert({
    id: 'lipsync',
    priority: CHANNEL_PRIORITY.lipsync,
    mode: 'override',
    hardLock: true,
    values: { ParamMouthOpenY: 1, ParamAngleX: 30 },
  });

  const snap = mixer.step(16);
  assert.ok(
    snap.values.ParamMouthOpenY > snap.values.ParamAngleX / 30,
    '同一帧内嘴部应比头部更快接近目标',
  );
});

test('reset 后不残留通道', () => {
  const mixer = new ParamMixer();
  mixer.upsert({ id: 'x', priority: 1, mode: 'override', values: { ParamAngleX: 1 } });
  mixer.reset();
  assert.equal(mixer.has('x'), false);
  assert.deepEqual(mixer.step(16).values, {});
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}\n`);
