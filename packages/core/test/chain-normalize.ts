/**
 * 动作链执行计划：并行组 / 整组超时 / 冲突降级。
 * 运行：node --experimental-strip-types packages/core/test/chain-normalize.ts
 */
import assert from 'node:assert/strict';
import {
  GROUP_TIMEOUT_MAX_MS,
  PARALLEL_OVERLAP_NOTE,
  normalizeActChain,
  stepDomains,
  type ChainStep,
} from '../src/chain-normalize.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed += 1;
    console.log('  ok', name);
  } catch (err) {
    process.exitCode = 1;
    console.error('  FAIL', name);
    console.error(err);
  }
};

// ---------------------------------------------------------------- 串行基线

test('无 group 的链保持原串行时刻（与旧 playActSteps 等价）', () => {
  const chain: ChainStep[] = [
    { kind: 'expression', name: '兔牙' },
    { kind: 'look', x: 0.2, y: 0.1, delayMs: 180 },
    { kind: 'pose', pose: { right: 'finger' }, delayMs: 200 },
  ];
  const plan = normalizeActChain(chain);
  assert.equal(plan.buckets.length, 3);
  assert.deepEqual(
    plan.buckets.map((b) => b.atMs),
    [0, 180, 380],
  );
  assert.deepEqual(plan.notes, []);
  for (const bucket of plan.buckets) assert.equal(bucket.steps.length, 1);
});

test('空链不炸，寿命有兜底下限', () => {
  const plan = normalizeActChain([]);
  assert.deepEqual(plan.buckets, []);
  assert.deepEqual(plan.notes, []);
  assert.ok(plan.lifeMs >= 400);
});

test('畸形输入（null / 非对象元素）被跳过', () => {
  const plan = normalizeActChain([null as unknown as ChainStep, { kind: 'look', x: 0 }]);
  assert.equal(plan.buckets.length, 1);
});

// ---------------------------------------------------------------- 并行组

test('同组进同一个桶，同帧投放', () => {
  const chain: ChainStep[] = [
    { kind: 'expression', name: '脸紅', group: 'g1', mode: 'parallel' },
    { kind: 'look', x: 0.3, y: 0.2, group: 'g1', mode: 'parallel' },
    { kind: 'pose', pose: { right: 'chest' }, group: 'g1', mode: 'parallel' },
  ];
  const plan = normalizeActChain(chain);
  assert.equal(plan.buckets.length, 1);
  assert.equal(plan.buckets[0].steps.length, 3);
  assert.equal(plan.buckets[0].atMs, 0);
  assert.deepEqual(plan.notes, []);
});

test('组内成员自己的 delayMs 是相对组开始时刻的错位', () => {
  const chain: ChainStep[] = [
    { kind: 'expression', name: '兔牙', group: 'g', delayMs: 100 },
    { kind: 'look', x: 0.1, group: 'g', delayMs: 60 },
  ];
  const plan = normalizeActChain(chain);
  assert.equal(plan.buckets.length, 1);
  const bucket = plan.buckets[0];
  assert.equal(bucket.atMs, 100);
  assert.deepEqual(bucket.steps.map((s) => s.atMs), [100, 160]);
});

test('组后的串行步排在整组之后', () => {
  const chain: ChainStep[] = [
    { kind: 'expression', name: '兔牙', group: 'g' },
    { kind: 'look', x: 0.1, group: 'g', delayMs: 500 },
    { kind: 'pose', pose: { right: 'rest' }, delayMs: 100 },
  ];
  const plan = normalizeActChain(chain);
  assert.equal(plan.buckets.length, 2);
  assert.equal(plan.buckets[0].atMs, 0);
  assert.equal(plan.buckets[1].atMs, 600); // 500（组内最晚）+100
});

// ---------------------------------------------------------------- 冲突降级

test('两个 look 同组 → 自动降级串行并记 notes', () => {
  const chain: ChainStep[] = [
    { kind: 'look', x: 1, group: 'g' },
    { kind: 'look', x: -1, delayMs: 200, group: 'g' },
  ];
  const plan = normalizeActChain(chain);
  const bucket = plan.buckets[0];
  assert.equal(bucket.downgraded, true);
  assert.deepEqual(plan.notes, [PARALLEL_OVERLAP_NOTE + ':g']);
  assert.deepEqual(bucket.steps.map((s) => s.atMs), [0, 200]);
});

test('同侧手臂姿势同组 → 降级；左右不同侧 → 保留并行', () => {
  const downgraded = normalizeActChain([
    { kind: 'pose', pose: { right: 'finger' }, group: 'g' },
    { kind: 'pose', pose: { right: 'chest' }, group: 'g' },
  ]);
  assert.equal(downgraded.buckets[0].downgraded, true);

  const parallel = normalizeActChain([
    { kind: 'pose', pose: { right: 'finger' }, group: 'g' },
    { kind: 'pose', pose: { left: 'chest' }, group: 'g' },
  ]);
  assert.equal(parallel.buckets[0].downgraded, false);
  assert.deepEqual(parallel.notes, []);
});

test('表情 / 动作 / 视线跨域并行不降级', () => {
  const plan = normalizeActChain([
    { kind: 'expression', name: '兔牙', group: 'g' },
    { kind: 'motion', name: '竖手指打开', group: 'g' },
    { kind: 'look', x: 0.2, group: 'g' },
  ]);
  assert.equal(plan.buckets[0].downgraded, false);
  assert.equal(plan.buckets[0].steps.length, 3);
});

test('两个 motion 同组 → 降级（同一条动作槽）', () => {
  const plan = normalizeActChain([
    { kind: 'motion', name: '竖手指打开', group: 'g' },
    { kind: 'motion', name: '抚胸手打开', group: 'g' },
  ]);
  assert.equal(plan.buckets[0].downgraded, true);
});

test('域判定覆盖各类步骤', () => {
  assert.deepEqual(stepDomains({ kind: 'expression', name: 'x' }), ['expression']);
  assert.deepEqual(stepDomains({ kind: 'look', x: 0 }), ['head', 'eye']);
  assert.deepEqual(stepDomains({ kind: 'pose', pose: { left: 'chest' } }), ['arm-left']);
  assert.deepEqual(stepDomains({ kind: 'pose', pose: {} }), ['pose']);
  assert.deepEqual(stepDomains({ kind: 'motion', name: 'x' }), ['motion']);
  assert.deepEqual(stepDomains(null), ['unknown']);
});

// ---------------------------------------------------------------- 超时

test('timeoutMs 归一到整组，并计入寿命', () => {
  const plan = normalizeActChain([
    { kind: 'motion', name: '竖手指打开', group: 'g', timeoutMs: 3000 },
    { kind: 'look', x: 0, group: 'g' },
  ]);
  assert.equal(plan.buckets[0].timeoutMs, 3000);
  assert.ok(plan.lifeMs >= 3000);
});

test('timeoutMs 钳到上限 8000，非法值当 0', () => {
  assert.equal(
    normalizeActChain([{ kind: 'look', x: 0, group: 'g', timeoutMs: 99999 }]).buckets[0].timeoutMs,
    GROUP_TIMEOUT_MAX_MS,
  );
  assert.equal(
    normalizeActChain([{ kind: 'look', x: 0, group: 'g', timeoutMs: -5 }]).buckets[0].timeoutMs,
    0,
  );
});

// ---------------------------------------------------------------- 不改入参

test('不修改入参链与步骤对象', () => {
  const chain: ChainStep[] = [
    { kind: 'look', x: 1, group: 'g' },
    { kind: 'look', x: -1, group: 'g', delayMs: 300 },
  ];
  const before = JSON.stringify(chain);
  normalizeActChain(chain);
  assert.equal(JSON.stringify(chain), before);
});

test('桶按时刻排序，且组不会把后面的链顶到错误时刻', () => {
  const plan = normalizeActChain([
    { kind: 'expression', name: 'b', group: 'early' },
    { kind: 'expression', name: 'a', group: 'late', delayMs: 400 },
    { kind: 'expression', name: 'c', group: 'late', delayMs: 100 },
  ]);
  assert.deepEqual(
    plan.buckets.map((b) => b.atMs),
    [0, 400],
  );
  assert.equal(plan.buckets[1].steps.length, 2);
  assert.deepEqual(plan.buckets[1].steps.map((s) => s.atMs), [400, 500]);
});

test('声明顺序决定组的起点（先声明的组把后面的组推迟）', () => {
  const plan = normalizeActChain([
    { kind: 'expression', name: 'a', group: 'late', delayMs: 400 },
    { kind: 'expression', name: 'b', group: 'early' },
  ]);
  assert.deepEqual(
    plan.buckets.map((b) => b.atMs),
    [400, 400],
  );
});

if (process.exitCode) {
  console.error('\n动作链执行计划测试失败\n');
} else {
  console.log(`\n${passed} passed\n`);
}
