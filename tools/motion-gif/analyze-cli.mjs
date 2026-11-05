#!/usr/bin/env node
/**
 * dsh-l2d · GIF 批量时序分析 CLI（P2 验收入口）
 *
 * 用法：
 *   node tools/motion-gif/analyze-cli.mjs <目录或文件...> [--sample-every N] [--limit N]
 *
 * 行为：
 *  - 逐文件 analyzeGifFile → 成功者 persistAnalysis 入库（motion_assets + motion_analysis，幂等）；
 *  - 损坏/不可解码文件：报告中如实记录 error，不入库（不伪造分析）；
 *  - 汇总报告写 data/gif-motion-report.json（含每文件帧时序摘要）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { analyzeGifFile, persistAnalysis, ANALYSIS_MODEL, ANALYSIS_MODEL_VERSION } from './analyze.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = { paths: [], sampleEvery: 1, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sample-every') args.sampleEvery = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else args.paths.push(argv[i]);
  }
  return args;
}

function collectGifs(paths) {
  const out = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) {
        if (f.toLowerCase().endsWith('.gif')) out.push(path.join(abs, f));
      }
    } else if (abs.toLowerCase().endsWith('.gif')) {
      out.push(abs);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.paths.length === 0) {
    console.error('用法: node tools/motion-gif/analyze-cli.mjs <目录或文件...> [--sample-every N] [--limit N]');
    process.exit(2);
  }
  const gifs = collectGifs(args.paths).slice(0, args.limit);
  const db = openDb({ startDir: REPO_ROOT });

  const report = {
    analysisModel: `${ANALYSIS_MODEL}@${ANALYSIS_MODEL_VERSION}`,
    analyzedAt: new Date().toISOString(),
    total: gifs.length,
    succeeded: 0,
    failed: 0,
    files: [],
  };

  for (const gifPath of gifs) {
    const rel = path.relative(REPO_ROOT, gifPath).replace(/\\/g, '/');
    const result = analyzeGifFile(gifPath, { sampleEvery: args.sampleEvery });
    if (!result.ok) {
      report.failed += 1;
      report.files.push({ file: rel, ok: false, error: result.error });
      console.error(`[FAIL] ${rel}: ${result.error}`);
      continue;
    }
    const { assetId, analysisId } = persistAnalysis(db, gifPath, result);
    const { meta, timing, reviewState } = result.analysis;
    report.succeeded += 1;
    report.files.push({
      file: rel, ok: true, sha256: result.sha256.slice(0, 16),
      assetId, analysisId, confidence: result.confidence, reviewState,
      summary: {
        size: `${meta.width}x${meta.height}`,
        frames: meta.numFrames,
        durationMs: meta.durationMs,
        distinctDelays: meta.distinctDelays,
        delays: meta.delays,
        hasTransparency: meta.hasTransparency,
        repeatedFrameRatio: meta.repeatedFrameRatio,
        startFrame: timing.startFrame,
        peakFrame: timing.peakFrame,
        endFrame: timing.endFrame,
        periodFrames: timing.periodFrames,
        keyframes: timing.keyframes,
      },
    });
    console.log(`[OK] ${rel}: ${meta.numFrames}f ${meta.durationMs}ms peak@${timing.peakFrame} period=${timing.periodFrames} review=${reviewState}`);
  }
  db.close();

  fs.mkdirSync(path.join(REPO_ROOT, 'data'), { recursive: true });
  const outPath = path.join(REPO_ROOT, 'data', 'gif-motion-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n${report.succeeded}/${report.total} analyzed, ${report.failed} failed -> ${path.relative(REPO_ROOT, outPath)}`);
}

main();
