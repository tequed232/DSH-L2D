/**
 * 动作语义词表测试（M1-d2 测试矩阵 M7，docs/REFERENCE-WHALEL2D-ARCHITECTURE.md §5.3）。
 *
 * WHALE FishPet.Tests 式动作语义回归：把"owner 评审过的行为"固化为无窗口断言——
 *   1. 词表校验器：每词 params 非空、参数 id 在白名单内、Move 类键帧首尾归零、时长一致；
 *   2. 时长随 scale 单调（Scale/Pace 同型，Body.cs:25-26）；
 *   3. 给定 cue → resolveWritePlan 输出 writes 的参数 id 与符号方向精确断言
 *      （不锁数值——数值随模型调，方向与结构不随）。
 * fixture 里的 RArm/ParamEyeBallX 等参数名与词表白名单同源（词表是评审过的数据文件，
 * 允许持参；机制文件 gesture-timeline 仍零参数名）。
 */
import assert from 'node:assert/strict';
import {
  GESTURE_VOCAB,
  GESTURE_PARAM_WHITELIST,
  gestureWordIntent,
  gestureWordSegment,
  scaleGestureWord,
  validateGestureVocab,
} from '../src/gesture-vocab.ts';
import { LIMB_BONE_PARAMS, resolveWritePlan } from '../src/write-plan.ts';
import type { GestureWord } from '../src/gesture-vocab.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('  ok  ' + name);
};

test('M7-01 词表校验器：种子词表全绿（params 非空 / 白名单内 / Move 首尾归零 / 时长一致）', () => {
  assert.deepEqual(validateGestureVocab(), [], '种子词表必须零问题');
});

test('M7-02 校验器 fail-closed：空 params / 白名单外参数 / Move 尾帧非零都要报', () => {
  const bad: GestureWord[] = [
    { id: 'x1', label: '', channel: 'gaze', kind: 'hold', params: {}, durationMs: 100 },
    {
      id: 'x2',
      label: '',
      channel: 'gaze',
      kind: 'hold',
      params: { ParamNotInList: 1 },
      durationMs: 100,
    },
    {
      id: 'x3',
      label: '',
      channel: 'wave',
      kind: 'move',
      params: { RArm: 1 },
      durationMs: 100,
      keys: [
        [0, 0],
        [100, 1],
      ],
    },
  ];
  const issues = validateGestureVocab(bad);
  const ids = new Set(issues.map((i) => i.wordId));
  assert.ok(ids.has('x1') && ids.has('x2') && ids.has('x3'), '三个坏词都要被抓：' + JSON.stringify(issues));
  assert.ok(issues.some((i) => i.wordId === 'x2' && i.detail.includes('whitelist')));
  assert.ok(issues.some((i) => i.wordId === 'x3' && i.detail.includes('尾帧')));
});

test('M7-03 每词一个参数域（WHALEL2D §3.1：同通道替换、跨通道并存的判定基础）', () => {
  for (const w of GESTURE_VOCAB) {
    assert.equal(Object.keys(w.params).length, 1, w.id + ' 必须恰好声明一个参数');
  }
  // 同通道词参数域相同 → 冲突判定天然产生"同通道替换"；跨通道词参数域不相交 → 并存
  const byChannel = new Map<string, Set<string>>();
  for (const w of GESTURE_VOCAB) {
    const dom = byChannel.get(w.channel) ?? new Set<string>();
    Object.keys(w.params).forEach((p) => dom.add(p));
    byChannel.set(w.channel, dom);
  }
  const channels = [...byChannel.values()];
  assert.ok(channels.length >= 3, '种子词表至少覆盖 3 个通道');
});

test('M7-04 时长随 scale 单调（0.25x → 4x 严格递增，WHALE 微/快 前缀同语义）', () => {
  const scales = [0.25, 0.5, 1, 1.5, 2, 4];
  for (const w of GESTURE_VOCAB) {
    let prev = 0;
    for (const s of scales) {
      const d = scaleGestureWord(w, s).durationMs;
      assert.ok(d > prev, w.id + ' scale=' + s + ' 时长必须单调递增：' + d + ' <= ' + prev);
      prev = d;
    }
  }
});

test('M7-05 scale 同比缩放 keys（move 词曲线形状不变，首尾仍归零）', () => {
  const wave = GESTURE_VOCAB.find((w) => w.id === 'wave.right');
  assert.ok(wave && wave.keys);
  const s2 = scaleGestureWord(wave, 2);
  assert.equal(s2.keys![0][1], 0);
  assert.equal(s2.keys![s2.keys!.length - 1][1], 0);
  assert.equal(s2.durationMs, wave.durationMs * 2);
  assert.deepEqual(
    s2.keys!.map(([t]) => t),
    wave.keys!.map(([t]) => t * 2),
  );
});

test('M7-06 语义回归：cue → resolveWritePlan writes 的参数 id 与符号方向精确断言', () => {
  const isLimbWord = (w: GestureWord) => Object.keys(w.params).some((p) => LIMB_BONE_PARAMS.has(p));
  // 非四肢词（gaze/tilt）：motion source 直写即合法（参数非物理输出/四肢骨）
  for (const w of GESTURE_VOCAB.filter((x) => !isLimbWord(x))) {
    const r = resolveWritePlan({
      now: 1000,
      intents: [gestureWordIntent(w)],
      ownership: {},
      physics: {},
      knownParams: [...GESTURE_PARAM_WHITELIST],
    });
    const expectedEntries = Object.entries(w.params);
    assert.equal(r.writes.length, expectedEntries.length, w.id + ' writes 数量与参数域一致');
    for (const [pid, value] of expectedEntries) {
      const hit = r.writes.find((x) => x.id === pid);
      assert.ok(hit, w.id + ' 必须写 ' + pid);
      assert.equal(
        Math.sign(hit.value),
        Math.sign(value),
        w.id + ' → ' + pid + ' 符号方向必须一致（方向锁死、数值不锁）',
      );
    }
    assert.deepEqual(r.rejected, [], w.id + ' 词面意图不得被 write-plan 拒绝');
  }
  // 四肢词（wave/RArm）：write-plan 契约是 fail-closed——无独占必拒（INV-3），
  // 真实执行路径是渲染层 injector own（playKeyframes 自动认领），不走 write-plan 直写；
  // 有 limb 独占（runId 匹配 + limb source）时方向必须与词面一致。
  for (const w of GESTURE_VOCAB.filter(isLimbWord)) {
    const withoutOwn = resolveWritePlan({ now: 1000, intents: [gestureWordIntent(w)], ownership: {}, physics: {} });
    assert.ok(
      withoutOwn.rejected.every((x) => x.reason === 'not-owned') && withoutOwn.writes.length === 0,
      w.id + ' 无独占时必须 fail-closed（INV-3）',
    );
    const [pid, value] = Object.entries(w.params)[0];
    const runId = 'vocab:' + w.id;
    const withOwn = resolveWritePlan({
      now: 1000,
      intents: [{ id: runId, source: 'limb', priority: w.priority ?? 50, params: { ...w.params }, runId }],
      ownership: { [pid]: { owner: 'limb', runId, phase: 'post' } },
      physics: { [pid]: 0 },
    });
    const hit = withOwn.writes.find((x) => x.id === pid);
    assert.ok(hit, w.id + ' 独占窗口内必须产出写入');
    assert.equal(Math.sign(hit.value), Math.sign(value), w.id + ' → ' + pid + ' 符号方向一致');
  }
});

test('M7-07 词段投影：gestureWordSegment 输出可入队形状（params/durationMs/priority 对齐词面）', () => {
  for (const w of GESTURE_VOCAB) {
    const seg = gestureWordSegment(w);
    assert.equal(seg.id, 'vocab:' + w.id);
    assert.equal(seg.durationMs, w.durationMs);
    assert.equal(seg.priority, w.priority ?? 50);
    assert.deepEqual(seg.params, w.params);
    assert.equal(seg.source, 'motion');
  }
});

console.log('gesture-vocab: ' + passed + ' tests passed');
