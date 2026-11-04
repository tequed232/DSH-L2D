/**
 * dsh-l2d · GIF 逐帧提取与动作时序分析（P2：动作知识库的数据入口）
 *
 * 产出被 motion_assets / motion_analysis 消费（不另建 GIF 专用数据库）；
 * motion_definitions / action_chains 由审核后的下游流程创建——本模块绝不自动认定语义。
 *
 * 纪律（任务书 P2）：
 *  - 不破坏原始素材；提取结果可追溯到源文件 sha256；
 *  - 帧序号、时间戳、分析模型版本、置信度、审核状态全保留；
 *  - 不能仅凭相邻帧差异认定动作语义：一切结论 review_state='needs_review'；
 *  - 损坏/不可解码 GIF：明确报错记录，不伪造分析。
 *
 * 解码：vendor omggif 1.0.10（MIT，sha256 bd898d5b…，零依赖）。
 * disposal 合成：按 GIF89a 规范处理 disposal 0/1/2/3，保留透明通道。
 * 差异分析：48x48 归一化网格上的 RGBA 平均通道差（0~255），对分辨率不敏感。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { upsertMotionAsset, upsertMotionAnalysis } from '../../packages/dsh-l2d-db/src/repo.mjs';

const require = createRequire(import.meta.url);
const { GifReader } = require('./vendor/omggif.cjs');

export const ANALYSIS_MODEL = 'dsh-l2d-gif-analyzer';
export const ANALYSIS_MODEL_VERSION = '1.0.0';
const DIFF_GRID = 48;          // 归一化网格边长
const NOISE_FLOOR = 2.0;       // 低于该均差的帧视为静止（8-bit 像素噪声容限）
const PEER_RATIO = 0.5;        // 关键帧候选：峰值须 >= 相邻窗口最大值×该比例

/**
 * 逐帧解码 GIF（流式，仅保留相邻两帧的 RGBA 缓冲，内存 O(1) 帧数无关）。
 * @returns {{ ok:true, meta, frames }} 或 { ok:false, error }
 */
export function decodeGif(buffer, { sampleEvery = 1 } = {}) {
  try {
    const reader = new GifReader(buffer);
    const { width, height } = reader;
    const numFrames = reader.numFrames();
    if (numFrames <= 0) return { ok: false, error: 'GIF 无帧（可能为静态图或空文件）' };

    // 全局透明检测：任一帧带 transparent_index 或背景可透出 → hasTransparency
    let hasTransparency = false;
    const frameInfos = [];
    for (let i = 0; i < numFrames; i++) {
      const fi = reader.frameInfo(i);
      frameInfos.push(fi);
      if (fi.transparent_index !== null && fi.transparent_index !== undefined) hasTransparency = true;
    }

    const cellW = Math.max(1, Math.floor(width / DIFF_GRID));
    const cellH = Math.max(1, Math.floor(height / DIFF_GRID));
    const gridW = Math.floor(width / cellW);
    const gridH = Math.floor(height / cellH);

    let cur = Buffer.alloc(width * height * 4);
    let prev = null;
    let prevSnapshot = null; // disposal=3 用的帧前快照
    const frames = [];
    let decoded = 0;

    for (let i = 0; i < numFrames; i++) {
      const fi = frameInfos[i];
      if (fi.disposal === 3) prevSnapshot = Buffer.from(cur);
      reader.decodeAndBlitFrameRGBA(i, cur);

      let diffScore = null;
      if (prev && i % sampleEvery === 0) {
        let sum = 0, n = 0;
        for (let gy = 0; gy < gridH; gy++) {
          for (let gx = 0; gx < gridW; gx++) {
            // 每网格采样中心像素，RGBA 四通道平均绝对差
            const px = gx * cellW + (cellW >> 1);
            const py = gy * cellH + (cellH >> 1);
            const off = (py * width + px) * 4;
            sum += (Math.abs(cur[off] - prev[off]) + Math.abs(cur[off + 1] - prev[off + 1])
                  + Math.abs(cur[off + 2] - prev[off + 2]) + Math.abs(cur[off + 3] - prev[off + 3])) / 4;
            n += 1;
          }
        }
        diffScore = n > 0 ? Number((sum / n).toFixed(2)) : 0;
      }
      frames.push({
        index: i,
        delayMs: fi.delay * 10,           // GIF delay 单位 1/100 秒
        disposal: fi.disposal,
        transparent: fi.transparent_index !== null && fi.transparent_index !== undefined,
        diffScore,
      });
      decoded += 1;

      // disposal 合成（为下一帧准备缓冲）
      if (fi.disposal === 2) {
        for (let y = fi.y; y < fi.y + fi.height; y++) {
          for (let x = fi.x; x < fi.x + fi.width; x++) {
            const off = (y * width + x) * 4;
            cur[off] = 0; cur[off + 1] = 0; cur[off + 2] = 0; cur[off + 3] = 0; // 恢复透明背景
          }
        }
      } else if (fi.disposal === 3 && prevSnapshot) {
        cur = Buffer.from(prevSnapshot);
        prevSnapshot = null;
      }
      prev = Buffer.from(cur); // 快照供下帧 diff
    }

    const totalDelayMs = frames.reduce((s, f) => s + f.delayMs, 0);
    const delays = [...new Set(frames.map((f) => f.delayMs))];
    const staticFrames = frames.slice(1).filter((f) => f.diffScore !== null && f.diffScore < NOISE_FLOOR).length;
    return {
      ok: true,
      meta: {
        width, height, numFrames, decoded,
        hasTransparency,
        loop: reader.loopCount === undefined ? null : reader.loopCount(),
        delays: delays.slice(0, 8),                          // 帧间隔分布（去重抽样）
        distinctDelays: delays.length,
        repeatedFrameRatio: numFrames > 1 ? Number((staticFrames / (numFrames - 1)).toFixed(3)) : 0,
        durationMs: totalDelayMs,
      },
      frames,
    };
  } catch (err) {
    return { ok: false, error: `GIF 解码失败：${err.message}` };
  }
}

/**
 * 时序分析：起始/峰值/结束帧、周期、关键帧候选。
 * 仅基于帧间差异的客观量，不做语义命名（语义留给人工/多模态审核）。
 */
export function analyzeTiming(frames) {
  const diffs = frames.map((f) => f.diffScore).slice(1); // 第 0 帧无 diff
  if (diffs.length === 0) return { startFrame: null, peakFrame: null, endFrame: null, periodFrames: null, keyframes: [] };

  const offsetOf = (i) => i + 1; // diffs[i] 对应 frames[i+1]
  const startLocal = diffs.findIndex((d) => d >= NOISE_FLOOR);
  const startFrame = startLocal === -1 ? null : offsetOf(startLocal);
  const endLocal = (() => { for (let i = diffs.length - 1; i >= 0; i--) if (diffs[i] >= NOISE_FLOOR) return i; return -1; })();
  const endFrame = endLocal === -1 ? null : offsetOf(endLocal);
  const peakLocal = diffs.indexOf(Math.max(...diffs));
  const peakFrame = offsetOf(peakLocal);

  // 关键帧候选：局部显著峰值（高于两侧邻域×PEER_RATIO）
  const keyframes = [];
  for (let i = 1; i < diffs.length - 1; i++) {
    if (diffs[i] < NOISE_FLOOR) continue;
    const win = diffs.slice(Math.max(0, i - 3), i + 4).filter((_, j) => j !== Math.min(3, i));
    const localMax = Math.max(...win, 0);
    if (diffs[i] >= localMax * PEER_RATIO && diffs[i] >= Math.max(...diffs) * PEER_RATIO) {
      keyframes.push(offsetOf(i));
    }
  }

  // 主周期：对 diff 序列做归一化自相关，取首个显著峰（循环 GIF）
  let periodFrames = null;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const centered = diffs.map((d) => d - mean);
  const energy = centered.reduce((s, d) => s + d * d, 0);
  if (energy > 0) {
    let bestLag = null, bestScore = 0;
    for (let lag = 2; lag <= Math.floor(diffs.length / 2); lag++) {
      let s = 0;
      for (let i = 0; i + lag < diffs.length; i++) s += centered[i] * centered[i + lag];
      const score = s / energy;
      if (score > 0.5 && score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (bestLag) periodFrames = bestLag;
  }

  return {
    startFrame, peakFrame, endFrame,
    startFrameDiff: startFrame !== null ? diffs[startLocal] : null,
    peakFrameDiff: diffs[peakLocal],
    periodFrames,
    keyframes,
  };
}

/**
 * 分析单个 GIF 文件 → 结构化记录（入库前形态；不落库）。
 * @returns { ok, sha256, analysis?, error? }
 */
export function analyzeGifFile(filePath, { sampleEvery = 1 } = {}) {
  const buffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const decoded = decodeGif(buffer, { sampleEvery });
  if (!decoded.ok) return { ok: false, sha256, error: decoded.error };

  const timing = analyzeTiming(decoded.frames);
  const confidence = timing.peakFrameDiff > NOISE_FLOOR * 4 ? 0.8 : 0.5;
  const analysis = {
    analysisModel: `${ANALYSIS_MODEL}@${ANALYSIS_MODEL_VERSION}`,
    sourceFile: path.basename(filePath),
    sha256,
    meta: decoded.meta,
    timing,
    frames: decoded.frames,
    reviewState: 'needs_review', // 全部结论待人工/多模态复核，禁止自动 approved
    analyzedAt: new Date().toISOString(),
  };
  return { ok: true, sha256, analysis, confidence };
}

/** 入库：asset（hash 去重）+ analysis（幂等 id）。供 CLI 与测试共用。 */
export function persistAnalysis(db, filePath, result, { originalPathOverride = null } = {}) {
  if (!result.ok) throw new Error(`persistAnalysis: 结果非 ok：${result.error}`);
  const assetId = `gif:${result.sha256.slice(0, 16)}`;
  const analysisId = `analysis:${assetId}`;
  const asset = upsertMotionAsset(db, {
    id: assetId,
    sourceType: 'gif',
    originalPath: originalPathOverride ?? filePath,
    contentHash: result.sha256,
    metadata: { sourceFile: path.basename(filePath), sizeBytes: fs.statSync(filePath).size },
  });
  upsertMotionAnalysis(db, {
    id: analysisId,
    assetId: asset.id,
    modelName: `${ANALYSIS_MODEL}@${ANALYSIS_MODEL_VERSION}`,
    analysis: result.analysis,
    confidence: result.confidence,
  });
  return { assetId, analysisId, asset };
}
