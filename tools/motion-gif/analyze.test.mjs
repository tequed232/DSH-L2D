/**
 * dsh-l2d · GIF 时序分析测试（P2 验收：正常/静止/运动/损坏/幂等入库）
 * 运行：node --experimental-sqlite tools/motion-gif/analyze.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GifWriter } from './vendor/omggif.cjs';
import { decodeGif, analyzeTiming, analyzeGifFile, persistAnalysis } from './analyze.mjs';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-gif-'));

/** 合成 GIF：帧内容函数 frameFn(frameIndex) → 索引数组（palette 两色）。 */
function makeGif(frameFn, { w = 16, h = 16, frames = 4, delay = 5, transparent = false } = {}) {
  // omggif palette = 24-bit 整数数组，条目数须为 2 的幂
  const palette = transparent
    ? [0x000000, 0xffffff, 0x808080, 0x404040]  // 4 色（索引 2 为透明色）
    : [0x000000, 0xffffff];                      // 2 色
  const transparentIndex = transparent ? 2 : undefined;
  const buf = Buffer.alloc(w * h * frames + 4096);
  const gw = new GifWriter(buf, w, h, { loop: 0, palette });
  for (let i = 0; i < frames; i++) {
    const data = new Uint8Array(w * h);
    frameFn(i, data, w, h);
    const opts = { delay, disposal: 1 };
    if (transparent) opts.transparent = transparentIndex;
    gw.addFrame(0, 0, w, h, data, opts);
  }
  return buf.subarray(0, gw.end());
}

// ---- 1. 静止 GIF（重复帧）：diff 全零，无 start/peak ----
test('static gif: all diffs ~0, no motion detected', () => {
  const buf = makeGif((i, data, w, h) => data.fill(i === 0 ? 1 : 1), { frames: 4 });
  const r = decodeGif(buf);
  assert.equal(r.ok, true);
  assert.equal(r.meta.numFrames, 4);
  assert.equal(r.meta.repeatedFrameRatio, 1);
  const t = analyzeTiming(r.frames);
  assert.equal(t.startFrame, null);
  assert.equal(t.endFrame, null);
});

// ---- 2. 运动 GIF：起始/峰值/结束帧检出 + 三态循环周期 3 ----
test('motion gif: start/peak/end frames detected', () => {
  // 三色循环（条纹平移）：diff 呈周期 3 信号
  const buf = makeGif((i, data, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (x + i) % 3 === 0 ? 0 : 1;
  }, { frames: 9 });
  const r = decodeGif(buf);
  assert.equal(r.ok, true);
  const t = analyzeTiming(r.frames);
  assert.notEqual(t.startFrame, null);
  assert.notEqual(t.peakFrame, null);
  assert.notEqual(t.endFrame, null);
  assert.equal(t.periodFrames, 3);
  assert.ok(t.peakFrameDiff > 20); // 条纹平移，网格均差显著
});

// ---- 3. 透明 GIF：transparent_index 传播到 meta ----
test('transparent gif: transparency flag detected', () => {
  const buf = makeGif((i, data, w, h) => data.fill(i % 2 === 0 ? 2 : 1), { frames: 3, transparent: true });
  const r = decodeGif(buf);
  assert.equal(r.ok, true);
  assert.equal(r.meta.hasTransparency, true);
  assert.equal(r.frames[0].transparent, true);
});

// ---- 4. 帧间隔：delay 单位换算（5 = 50ms） ----
test('frame delays converted to ms', () => {
  const buf = makeGif(() => {}, { frames: 3, delay: 5 });
  const r = decodeGif(buf);
  assert.deepEqual(r.meta.delays, [50]);
  assert.equal(r.meta.durationMs, 150);
});

// ---- 5. 损坏 GIF：明确报错，不伪造分析 ----
test('corrupted gif: decode fails with error', () => {
  const good = makeGif((i, d) => d.fill(1), { frames: 2 });
  const cases = [
    { name: 'truncated', buf: good.subarray(0, Math.floor(good.length / 3)) },
    { name: 'garbage', buf: Buffer.from('not a gif at all, just random bytes 1234567890') },
    { name: 'empty', buf: Buffer.alloc(0) },
  ];
  for (const c of cases) {
    const r = decodeGif(c.buf);
    assert.equal(r.ok, false, c.name);
    assert.ok(r.error.length > 0, c.name);
  }
});

// ---- 6. 抽帧频率：sampleEvery=2 只隔帧计算 diff ----
test('sampleEvery skips diff computation on skipped frames', () => {
  const buf = makeGif((i, data, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = i % 2;
  }, { frames: 4 });
  const r = decodeGif(buf, { sampleEvery: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.frames[1].diffScore, null); // 被 skip
  assert.notEqual(r.frames[2].diffScore, null);
});

// ---- 7. 真实 GIF 集成 + 幂等入库（P2 验收：可追溯源 hash） ----
test('real gif integration: analyze + persist idempotent', () => {
  const realGif = 'D:/Temp/l2d-gallery-extract/27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif';
  if (!fs.existsSync(realGif)) { console.log('    (skip: real gif not present)'); return; }
  const result = analyzeGifFile(realGif);
  assert.equal(result.ok, true);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.analysis.reviewState, 'needs_review');
  assert.equal(result.analysis.analysisModel, 'dsh-l2d-gif-analyzer@1.0.0');
  assert.ok(result.analysis.meta.numFrames >= 19);

  const db = openDb({ path: path.join(tmp, 'bootstrap-state.sqlite') });
  const first = persistAnalysis(db, realGif, result);
  const second = persistAnalysis(db, realGif, result);
  assert.equal(first.assetId, second.assetId);       // hash 去重
  assert.equal(first.analysisId, second.analysisId); // analysis 幂等
  const assets = db.prepare('SELECT COUNT(*) n FROM motion_assets').get().n;
  assert.equal(assets, 1);
  const row = db.prepare('SELECT analysis_json FROM motion_analysis WHERE id = ?').get(first.analysisId);
  const parsed = JSON.parse(row.analysis_json);
  assert.equal(parsed.meta.numFrames, result.analysis.meta.numFrames); // 帧数据完整入库
  db.close();
});

// ---- 8. 关键帧候选：单调渐变运动应产出至少一个候选 ----
test('motion gif: keyframe candidates produced', () => {
  const buf = makeGif((i, data, w, h) => {
    const stripeW = Math.max(1, Math.round((w / 2) * (i / 3)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < stripeW ? 0 : 1;
  }, { frames: 4 });
  const r = decodeGif(buf);
  const t = analyzeTiming(r.frames);
  assert.ok(t.keyframes.length >= 1, `keyframes=${JSON.stringify(t.keyframes)}`);
});

console.log(`\ngif-analyzer: ${passed} tests passed`);
fs.rmSync(tmp, { recursive: true, force: true });
