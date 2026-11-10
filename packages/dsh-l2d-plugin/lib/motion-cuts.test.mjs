/**
 * motion-cuts.mjs 自测：用手写的最小 motion3 样例（不依赖、不提交任何模型文件）。
 *   node packages/dsh-l2d-plugin/lib/motion-cuts.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { computeCutPoints, autoCutsForModel } from './motion-cuts.mjs';

// 0–0.5s 静止 → 0.5–1.0s 线性 0→10 → 1.0–2.0s 静止
const sample = {
  Version: 3,
  Meta: { Duration: 2, Fps: 30, Loop: false },
  Curves: [
    { Target: 'Parameter', Id: 'ParamA', Segments: [0, 0, 0, 0.5, 0, 0, 1.0, 10, 0, 2.0, 10] },
    // 开关曲线与纯阶梯曲线不计速度
    { Target: 'Parameter', Id: 'Movement1', Segments: [0, 0, 0, 0.1, 1, 0, 1.9, 0] },
    { Target: 'Parameter', Id: 'ParamStep', Segments: [0, 0, 2, 0.7, 1, 2, 2.0, 1] },
    { Target: 'PartOpacity', Id: 'PartX', Segments: [0, 0, 0, 2, 1] },
  ],
};

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log('✓ ' + name);
};

t('静止窗口起点即衔接点；开关/阶梯/部件曲线不参与', () => {
  const r = computeCutPoints(sample);
  assert.equal(r.durationMs, 2000);
  assert.equal(r.loop, false);
  assert.equal(r.cutPointsMs.length, 2);
  assert.equal(r.cutPointsMs[0], 0);
  assert.ok(r.cutPointsMs[1] >= 1000 && r.cutPointsMs[1] <= 1070, String(r.cutPointsMs[1]));
});
t('只看给定参数：参数都不动 → 没有衔接点', () => {
  assert.deepEqual(computeCutPoints(sample, { params: ['ParamOther'] }).cutPointsMs, []);
});
t('minGapMs 去重、minRunMs 过滤短静止', () => {
  const r = computeCutPoints(sample, { minGapMs: 5000 });
  assert.deepEqual(r.cutPointsMs, [0]);
  const r2 = computeCutPoints(sample, { minRunMs: 600 });
  assert.equal(r2.cutPointsMs.length, 1, '0–0.5s 的静止只有 500ms，不够 600');
});
t('坏输入不抛', () => {
  assert.deepEqual(computeCutPoints(null), { durationMs: 0, loop: false, cutPointsMs: [] });
  assert.deepEqual(computeCutPoints({ Meta: { Duration: 1 }, Curves: 'x' }).cutPointsMs, []);
});
t('autoCutsForModel：按 model3 引用读、拒绝越出模型目录、读不到就跳过', () => {
  const dir = path.resolve('/virtual/model');
  const files = new Map([
    [path.join(dir, 'm.model3.json'), JSON.stringify({ FileReferences: { Motions: {
      好: [{ File: 'motions/a.motion3.json', FadeInTime: 0.3 }],
      越界: [{ File: '../escape.motion3.json' }],
      缺: [{ File: 'motions/missing.motion3.json' }],
    } } })],
    [path.join(dir, 'motions/a.motion3.json'), JSON.stringify(sample)],
    [path.resolve('/virtual/escape.motion3.json'), JSON.stringify(sample)],
  ]);
  const fsImpl = { readFileSync: (f) => { if (!files.has(f)) throw new Error('ENOENT'); return files.get(f); } };
  const out = autoCutsForModel(dir, 'm', () => ['ParamA'], ['好', '越界', '缺', '没有这个组'], fsImpl);
  assert.deepEqual(Object.keys(out), ['好']);
  assert.equal(out.好.fadeInMs, 300);
  assert.equal(out.好.durationMs, 2000);
  assert.deepEqual(autoCutsForModel('', 'm', () => [], ['好'], fsImpl), {});
  assert.deepEqual(autoCutsForModel(dir, 'nope', () => [], ['好'], fsImpl), {});
});

console.log(`motion-cuts ok (${n} cases)`);
