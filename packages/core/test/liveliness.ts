/**
 * 加法限幅、微动作采样、姿势缓动的冒烟测试。
 * 运行：node --experimental-strip-types packages/core/test/liveliness.ts
 */
import assert from 'node:assert/strict';
import { mixAdditive, sampleAmbient, AMBIENT_FORBIDDEN, easeInOutCubic } from '../src/index.ts';
import { PoseController } from '../../renderer/src/app/pose-controller.ts';

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

console.log('\n灵动化冒烟测试\n');

test('加法叠加：小幅度原样相加', () => {
  const sum = mixAdditive(
    [
      { id: 'body', priority: 40, value: 2 },
      { id: 'ambient', priority: 20, value: 3 },
      { id: 'media', priority: 10, value: 1 },
    ],
    15,
  );
  assert.equal(sum, 6);
});

test('超限时先砍媒体，再砍微动作，身体尽量保留', () => {
  const sum = mixAdditive(
    [
      { id: 'media', priority: 10, value: 5 },
      { id: 'ambient', priority: 20, value: 3 },
      { id: 'body', priority: 40, value: 10 },
    ],
    12,
  );
  assert.equal(sum, 12);
});

test('全零就是零，关传感器不会残留', () => {
  const sum = mixAdditive(
    [
      { id: 'body', priority: 40, value: 0 },
      { id: 'ambient', priority: 20, value: 0 },
      { id: 'media', priority: 10, value: 0 },
    ],
    15,
  );
  assert.equal(sum, 0);
});

test('单路超过上限会被钳住', () => {
  const sum = mixAdditive([{ id: 'body', priority: 40, value: 20 }], 15);
  assert.equal(sum, 15);
});

test('反向可以抵消，而不是被直接丢掉', () => {
  const sum = mixAdditive(
    [
      { id: 'body', priority: 40, value: -10 },
      { id: 'ambient', priority: 20, value: 4 },
    ],
    12,
  );
  assert.equal(sum, -6);
});

test('微动作不写口型参数', () => {
  for (const kind of ['tilt', 'shift', 'shrug', 'puff', 'pucker'] as const) {
    const sample = sampleAmbient(kind, 0.25, -1);
    for (const banned of AMBIENT_FORBIDDEN) {
      assert.equal(sample[banned], undefined, kind + ' 不应写 ' + banned);
    }
  }
  const tilt = sampleAmbient('tilt', 0.5, -1);
  assert.ok(Math.abs((tilt.AngleZ || 0) + 3) < 1e-6, '歪头峰值应为 -3');
  const shift = sampleAmbient('shift', 0.5, 1);
  assert.ok(Math.abs((shift.PositionX || 0) - 5) < 1e-6);
  assert.equal(sampleAmbient('puff', 0.5, 1).CheeckPuff, 0.45);
  assert.equal(sampleAmbient('pucker', 0).Mouthpucker, 0);
});

test('easeInOutCubic 中段比线性更缓', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.25) < 0.25);
});

test('姿势用三次缓动，而不是线性跳变', () => {
  const writes: Array<{ id: string; v: number }> = [];
  const injector = {
    set(_model: unknown, id: string, v: number) {
      writes.push({ id, v });
      return true;
    },
  };
  const pose = new PoseController({ easeSec: 1, idleReturnSec: 10 });
  pose.setPose({ right: 'finger' });
  pose.update(null as never, 0.25, injector as never);
  const mid = writes.filter((w) => w.id === 'Param40').pop();
  assert.ok(mid, '应写入 Param40');
  assert.ok(mid.v > 0 && mid.v < 0.2, `0.25 秒处应明显慢于线性，实际 ${mid.v}`);
});

test('姿势空闲后自动缓回 rest', () => {
  const writes: Array<{ id: string; v: number }> = [];
  const injector = {
    set(_model: unknown, id: string, v: number) {
      writes.push({ id, v });
      return true;
    },
  };
  const pose = new PoseController({ easeSec: 0.2, idleReturnSec: 0.3 });
  pose.setPose({ right: 'finger' });
  pose.update(null as never, 0.2, injector as never);
  const held = writes.filter((w) => w.id === 'Param40').pop();
  assert.ok(held && Math.abs(held.v - 1) < 1e-6, '缓动结束应停在竖指');
  pose.update(null as never, 0.35, injector as never);
  pose.update(null as never, 0.2, injector as never);
  const back = writes.filter((w) => w.id === 'Param40').pop();
  assert.ok(back && back.v < 0.05, `应回到 rest，实际 ${back && back.v}`);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}\n`);
