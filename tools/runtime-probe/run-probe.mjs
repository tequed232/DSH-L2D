/**
 * Runtime Probe CLI（Phase 3 真实渲染探针）。
 *
 *  - --mode smoke    : 宿主冒烟——真实加载模型、自省参数、FPS、截图；不写参数。
 *  - --mode baseline : 单参数基线探针——Safety Guard 裁决 → 基线采样 → 注入 →
 *                      逐帧观测 → 恢复基线 → 复核；probe_run 经 Repository 入库。
 *
 * 结果一律落 data/runtime-probe/，并打印 PASS/FAIL 摘要。禁止在本模块伪造任何观测值。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startDevServer, launchProbeHost, stopDevServer, ensureArtDir, MODEL_2048 } from './lib/host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function argOf(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const mode = argOf('--mode', 'smoke');
const PORT = Number(argOf('--port', '5319'));

const TARGET_PARAMS = ['Param_Angle_Rotation84', 'Param_Angle_Rotation85', 'Param_Angle_Rotation86', 'Param_Angle_Rotation87',
  'LEar1', 'LEar2', 'LEar3', 'REar1', 'REar2', 'REar3',
  'AngryMove', 'AngryMove2', 'AngryMove3', 'AngryMove4', 'AngryMove5', 'AngryMove6', 'AngryMove7', 'AngryMove8',
  'Clothes5', 'Param52', 'Param39', 'Param11'];

async function smoke() {
  const dv = await startDevServer(PORT);
  let host = null;
  try {
    host = await launchProbeHost({ baseUrl: dv.baseUrl });
    const caps = await host.ops.caps();
    const info = await host.ops.info();
    const fps = await host.ops.measureFps();
    const errs = host.ops.getConsoleErrors();
    const artDir = ensureArtDir();
    const shot = path.join(artDir, `smoke-${Date.now()}.png`);
    await host.ops.screenshot(shot);

    const allIds = (caps.params || []).map((p) => p.id);
    const targets = TARGET_PARAMS.filter((id) => allIds.includes(id));
    const missing = TARGET_PARAMS.filter((id) => !allIds.includes(id));
    const report = {
      mode: 'smoke',
      modelLoaded: caps.model,
      paramCount: allIds.length,
      expressionCount: (caps.expressions || []).length,
      motionGroups: caps.motionGroups,
      info, fps,
      targetsFound: targets,
      targetsMissing: missing,
      consoleErrors: errs.slice(0, 10),
      screenshot: shot,
      verdict: (fps.fps >= 20 && info.lastError === 'none' && (caps.params || []).length >= 400) ? 'PASS' : 'FAIL',
    };
    fs.writeFileSync(path.join(artDir, 'smoke-latest.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== 'PASS') process.exitCode = 2;
  } finally {
    if (host) await host.ops.close();
    stopDevServer(dv);
  }
}

async function loadDbAndGuard() {
  const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'db.mjs')).href);
  const guard = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'safety-guard.mjs')).href);
  return { openDb, guard };
}

async function baseline() {
  const param = argOf('--param');
  const value = Number(argOf('--value'));
  if (!param || !Number.isFinite(value)) {
    console.error('用法: --mode baseline --param <ParamId> --value <N> [--frames 90]');
    process.exit(1);
  }
  const frames = Number(argOf('--frames', '90'));

  const { openDb, guard } = await loadDbAndGuard();
  const db = openDb({ startDir: ROOT });

  // Safety Guard：Hard/Soft 双层边界裁决（fail-closed；strict 模式——动作注入按 Soft 包络钳制）
  const paramRow = db.prepare("SELECT * FROM parameters WHERE model_id = '大肥鱼.dsl2d' AND param_id = ?").get(param);
  if (!paramRow) {
    console.log(JSON.stringify({ mode: 'baseline', param, verdict: 'REJECTED', reason: '注册表无此参数' }, null, 2));
    process.exitCode = 3;
    return;
  }
  const decision = guard.checkInjection(paramRow, value, { strict: true });
  if (!decision.ok) {
    console.log(JSON.stringify({ mode: 'baseline', param, value, verdict: 'REJECTED', guard: decision }, null, 2));
    process.exitCode = 3;
    return;
  }

  const dv = await startDevServer(PORT);
  let host = null;
  try {
    host = await launchProbeHost({ baseUrl: dv.baseUrl });
    const caps = await host.ops.caps();
    const live = (caps.params || []).find((p) => p.id === param);
    if (!live) {
      console.log(JSON.stringify({ mode: 'baseline', param, verdict: 'FAIL', reason: '模型无此参数' }));
      process.exitCode = 2;
      return;
    }

    // 1) 基线采样
    const baselineSamples = await host.ops.sample([param], 30);
    const baselineVals = baselineSamples.map((s) => s[param]);
    const baseline = {
      median: median(baselineVals),
      min: Math.min(...baselineVals),
      max: Math.max(...baselineVals),
      samples: baselineSamples.length,
    };

    // 2) 注入（strict 模式下 guard 已把超 Soft 值钳到 Soft 边界）
    const injectValue = decision.suggestedValue ?? decision.value;
    let apply = await host.ops.set({ [param]: injectValue });
    let ownershipUsed = false;
    if (!apply.ok.includes(param) && /:rejected|:physics-output/.test(apply.failed.join(','))) {
      // 物理输出参数：走渲染器所有权认领（唯一合法通道），时长覆盖采样窗口后自动释放
      await host.ops.own([param], (frames / 30) * 1000 + 6000);
      ownershipUsed = true;
      apply = await host.ops.set({ [param]: injectValue });
    }
    if (!apply.ok.includes(param)) {
      console.log(JSON.stringify({ mode: 'baseline', param, verdict: 'FAIL', apply, baseline }));
      process.exitCode = 2;
      return;
    }

    // 3) 注入态逐帧观测
    const injectedSamples = await host.ops.sample([param], frames);
    const injectedVals = injectedSamples.map((s) => s[param]);
    const observed = {
      median: median(injectedVals),
      min: Math.min(...injectedVals),
      max: Math.max(...injectedVals),
      movedBeyondNoise: Math.max(...injectedVals.map((v) => Math.abs(v - baseline.median))) > noiseThreshold(baseline),
    };

    // 4) 恢复基线并复核
    await host.ops.resetPose();
    await new Promise((r) => setTimeout(r, 350));
    const afterSamples = await host.ops.sample([param], 30);
    const afterVals = afterSamples.map((s) => s[param]);
    const restored = Math.abs(median(afterVals) - baseline.median) <= Math.max(noiseThreshold(baseline), 0.05 * (live.max - live.min || 1));

    // 5) 截图证据 + 入库（Repository 唯一入口）
    const artDir = ensureArtDir();
    const shot = path.join(artDir, `baseline-${param}-${Date.now()}.png`);
    await host.ops.screenshot(shot);

    const { createAnalysisJob, finishAnalysisJob, upsertNode, insertProbeRun } =
      await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'repo.mjs')).href);
    const jobId = createAnalysisJob(db, { analysisJobId: `probe-${param}-${Date.now()}`, modelId: '大肥鱼.dsl2d', toolVersions: { 'runtime-probe': '0.1.0', playwright: 'playwright-core' } });
    const nodeId = upsertNode(db, { modelId: '大肥鱼.dsl2d', nodeKey: param, nodeType: 'Parameter', displayName: live.name ?? null, evidenceLevel: 'source_exact', sourcePointer: 'live-capabilities' });
    const runId = insertProbeRun(db, {
      analysisJobId: jobId,
      parameterNodeId: nodeId,
      baseline,
      inputValue: injectValue,
      result: { observed, applied: apply, ownershipUsed, liveRange: { min: live.min, max: live.max }, guardDecision: decision, samples: injectedSamples },
      restored,
    });
    finishAnalysisJob(db, jobId, 'done', restored ? 'baseline restored' : 'restore drift');

    const verdict = observed.movedBeyondNoise && restored ? 'PASS' : (observed.movedBeyondNoise ? 'PASS_WITH_WARNINGS' : 'FAIL');
    const report = {
      mode: 'baseline', param, requestedValue: value, injectValue,
      liveRange: { min: live.min, max: live.max },
      guard: decision,
      baseline, observed, restored, ownershipUsed, probeRunId: runId, analysisJobId: jobId,
      screenshot: shot, verdict,
    };
    fs.writeFileSync(path.join(artDir, `baseline-${param}-latest.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (verdict === 'FAIL') process.exitCode = 2;
  } finally {
    if (host) await host.ops.close();
    stopDevServer(dv);
  }
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
/** 噪声阈值：基线极差的 2 倍与量程 1% 取大者 */
function noiseThreshold(baseline) {
  return Math.max((baseline.max - baseline.min) * 2, 0.01);
}

const MODES = { smoke, baseline };
if (!MODES[mode]) {
  console.error('未知 mode:', mode);
  process.exit(1);
}
MODES[mode]().catch((e) => {
  console.error('PROBE_ERROR:', e.message);
  process.exit(1);
});
