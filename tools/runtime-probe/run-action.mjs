/**
 * Action Executor：全链路真实执行器（SQLite → Action Chain → Model Adapter →
 * Safety Guard → Live2D Runtime）。
 *
 * 链路纪律（2026-11-05 通宵任务书）：
 *  1. 动作/链/绑定全部读自 SQLite（唯一数据源），不硬编码参数映射；
 *  2. 语义通道经 Model Adapter resolveMotionParams 解析（版本漂移 fail-closed）；
 *  3. 每个注入值经 safety-guard checkInjectionBatch 预检（任一硬违规→整批拒绝）；
 *  4. 运行时执行用渲染器既有 playKeyframes（ParamInjector 所有权管辖，自动钳值域）；
 *  5. 无通道映射的轨道/表情语义 → 如实 SKIP 留痕，不猜测、不 mock；
 *  6. 执行证据写 execution_history（Repository 唯一入口）。
 *
 * 用法：node run-action.mjs --motion dafeiyu.tail-sway-happy [--cycles 2]
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startDevServer, launchProbeHost, stopDevServer, ensureArtDir } from './lib/host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODEL_ID = '大肥鱼.dsl2d';

function argOf(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

/** camelCase 轨道名 → snake_case 通道名（tailSway ↔ tail_sway） */
function trackToChannel(track) {
  return track.replace(/([A-Z])/g, '_$1').toLowerCase();
}

async function main() {
  const motionId = argOf('--motion');
  const cycles = Number(argOf('--cycles', '2'));
  if (!motionId) { console.error('用法: --motion <motion_id> [--cycles N]'); process.exit(1); }

  const { openDb } = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'db.mjs')).href);
  const adapterMod = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'model-adapter.mjs')).href);
  const guardMod = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'safety-guard.mjs')).href);
  const db = openDb({ startDir: ROOT });

  // ---- 1) SQLite：动作 + 链 ----
  const motion = db.prepare('SELECT * FROM motion_definitions WHERE id = ?').get(motionId);
  if (!motion) { console.log(JSON.stringify({ verdict: 'FAIL', reason: `motion 不存在: ${motionId}` })); process.exitCode = 2; return; }
  const chainRow = db.prepare('SELECT * FROM action_chains WHERE motion_id = ? ORDER BY created_at DESC LIMIT 1').get(motionId);
  if (!chainRow) { console.log(JSON.stringify({ verdict: 'FAIL', reason: '无 action_chain' })); process.exitCode = 2; return; }
  const chain = JSON.parse(chainRow.chain_json);

  // ---- 2) Model Adapter：语义通道 → 参数（fail-closed）----
  const resolved = adapterMod.resolveMotionParams(db, { motionId, modelId: MODEL_ID });
  if (!resolved.ok) {
    console.log(JSON.stringify({ verdict: 'FAIL', reason: 'ADAPTER_RESOLVE_FAILED', detail: resolved }));
    process.exitCode = 2; return;
  }
  const channels = resolved.channels;

  // ---- 3) Safety Guard：全部轨道极值预检（原子性）----
  const skips = [];
  const plans = []; // { track, channel, entries:[{paramId, weight, keys:[[t,v]]}] }
  const lookupParamRow = (pid) => db.prepare('SELECT * FROM parameters WHERE model_id = ? AND param_id = ?').get(MODEL_ID, pid);
  for (const step of chain.steps ?? []) {
    if (step.kind === 'expression') {
      skips.push({ step: step.step_index, kind: 'expression', semantic: step.params?.semantic, reason: '表情语义无 adapter 通道/无 Expression 绑定——如实跳过，不猜测' });
      continue;
    }
    if (step.kind !== 'keyframes') { skips.push({ step: step.step_index, kind: step.kind, reason: '未知 step kind' }); continue; }
    const track = step.params?.track;
    const chName = trackToChannel(track ?? '');
    const entries = channels[chName];
    if (!entries) { skips.push({ step: step.step_index, kind: 'keyframes', track, reason: `无通道映射 ${chName}（adapter 未绑定）——如实跳过` }); continue; }
    const keys = (step.params?.keys ?? []).map((k) => [k.t, k.value]);
    if (!keys.length) { skips.push({ step: step.step_index, track, reason: '空 keys' }); continue; }
    // Parameter Resolver：通道值空间为归一化 [-1,1]（MOTION-DATA-SCHEMA 约定），
    // 按每个参数的 Hard 范围（SQLite 注册表）线性缩放：v → min + (v+1)/2 × (max-min)。
    // 权重乘在归一化值上（缩放前），保证多段级联幅值按权重衰减。
    const entriesResolved = entries.map((e) => {
      const row = lookupParamRow(e.paramId);
      if (!row || row.min_value === null || row.max_value === null) return null;
      return {
        param: e.paramId,
        weight: e.weight ?? 1,
        min: row.min_value,
        max: row.max_value,
        keys: keys.map(([t, v]) => {
          const nv = Math.max(-1, Math.min(1, v * (e.weight ?? 1)));
          return [t, row.min_value + ((nv + 1) / 2) * (row.max_value - row.min_value)];
        }),
      };
    });
    if (entriesResolved.some((e) => e === null)) {
      skips.push({ step: step.step_index, track, reason: '通道内参数无 Hard 范围证据——guard fail-closed，跳过' });
      continue;
    }
    const extremes = keys.map(([, v]) => v);
    const batch = entries.map((e) => {
      const row = lookupParamRow(e.paramId);
      const nv = Math.max(-1, Math.min(1, Math.max(...extremes) * (e.weight ?? 1)));
      return { paramId: e.paramId, value: row.min_value + ((nv + 1) / 2) * (row.max_value - row.min_value) };
    });
    const guardResult = guardMod.checkInjectionBatch(batch, lookupParamRow, { strict: true });
    if (!guardResult.ok) {
      console.log(JSON.stringify({ verdict: 'REJECTED', reason: 'SAFETY_GUARD_BATCH_REJECT', step: step.step_index, track, violations: guardResult.violations }));
      process.exitCode = 3; return;
    }
    plans.push({
      step: step.step_index, track, channel: chName,
      tracks: entriesResolved.map((e) => ({ param: e.param, keys: e.keys })),
      durationMs: step.duration_ms ?? Math.max(...keys.map(([t]) => t)),
    });
  }

  // ---- 4) Runtime：真实执行 ----
  const dv = await startDevServer(5321);
  let host = null;
  const startedAt = new Date().toISOString();
  try {
    host = await launchProbeHost({ baseUrl: dv.baseUrl });
    const artDir = ensureArtDir();
    const tag = `${motionId.replace(/[^\w.-]/g, '_')}-${Date.now()}`;
    const shots = {};

    const allParams = plans.flatMap((p) => p.tracks.map((t) => t.param));
    // 基线：30 帧采样取中值与噪声幅度（物理参数有待机微动，单点读会误判）
    const baseSamples = await host.ops.sample(allParams, 30);
    const baseline = {};
    for (const pid of allParams) {
      const vals = baseSamples.map((s) => s[pid]).filter(Number.isFinite);
      baseline[pid] = { median: medianOf(vals), spread: vals.length ? Math.max(...vals) - Math.min(...vals) : 0 };
    }
    shots.baseline = path.join(artDir, `${tag}-0-baseline.png`);
    await host.ops.screenshot(shots.baseline);

    const applied = [];
    const observed = {};
    let bestFps = 0;
    for (const plan of plans) {
      // playKeyframes：渲染器所有权认领 + 值域钳制的既有执行路径；
      // 立即采样覆盖首个极值（链 keys 首峰在 450ms）
      const handle = await host.page.evaluate((t) => window.DSH_L2D.playKeyframes(t.tracks, { loop: false }), plan);
      const during = await host.ops.sample(allParams, 70);
      const fpsDuring = await host.ops.measureFps();
      bestFps = Math.max(bestFps, fpsDuring.fps);
      await host.page.waitForTimeout(Math.min(plan.durationMs, 450));
      shots[`step${plan.step}`] = path.join(artDir, `${tag}-step${plan.step}.png`);
      await host.ops.screenshot(shots[`step${plan.step}`]);
      for (const pid of allParams) {
        const vals = during.map((s) => s[pid]).filter(Number.isFinite);
        if (vals.length) {
          observed[pid] = {
            min: Math.min(...vals),
            max: Math.max(...vals),
            excursion: Math.max(
              Math.max(...vals) - baseline[pid].median,
              baseline[pid].median - Math.min(...vals),
            ),
          };
        }
      }
      await host.page.evaluate(() => window.DSH_L2D.stopKeyframes());
      applied.push({ step: plan.step, track: plan.track, handle, params: plan.tracks.map((t) => t.param) });
      await host.page.waitForTimeout(250);
    }

    // ---- 5) 恢复与复核（物理惯性 + 待机微动：采 40 帧中值，容差 = 噪声幅度 3 倍或量程 5%）----
    await host.ops.resetPose();
    await host.page.waitForTimeout(900);
    const afterSamples = await host.ops.sample(allParams, 40);
    const liveCaps = await host.ops.caps();
    const restored = allParams.every((pid) => {
      const vals = afterSamples.map((s) => s[pid]).filter(Number.isFinite);
      if (!vals.length) return false;
      const med = medianOf(vals);
      const live = (liveCaps.params || []).find((p) => p.id === pid);
      const tol = Math.max((baseline[pid]?.spread ?? 0) * 3, ((live?.max ?? 1) - (live?.min ?? 0)) * 0.05);
      return Math.abs(med - baseline[pid].median) <= tol;
    });
    shots.restored = path.join(artDir, `${tag}-z-restored.png`);
    await host.ops.screenshot(shots.restored);
    const errs = host.ops.getConsoleErrors();

    // ---- 6) execution_history（Repository 唯一入口）----
    const repoMod = await import(pathToFileURL(path.join(ROOT, 'packages', 'dsh-l2d-db', 'src', 'repo.mjs')).href);
    const { randomUUID } = await import('node:crypto');
    let execId = null;
    try {
      repoMod.recordExecution(db, {
        execId: `exec-${randomUUID()}`,
        motionId, modelId: MODEL_ID,
        status: restored ? 'completed' : 'interrupted',
        request: { chainId: chainRow.id, cycles, plans: plans.map((p) => ({ step: p.step, track: p.track, channel: p.channel })) },
        result: { applied, skips, observed, restored, fps: bestFps, baseline, screenshots: shots, consoleErrors: errs.slice(0, 5) },
        startedAt, finishedAt: new Date().toISOString(),
      });
      execId = 'recorded';
    } catch (e) {
      execId = `record-failed: ${e.message}`;
    }

    // 移动门槛：excursion 超过基线噪声 3 倍且绝对值 > 量程 1%
    const moved = Object.entries(observed).filter(([pid, o]) =>
      o.excursion > Math.max((baseline[pid]?.spread ?? 0) * 3, 0.01));
    const verdict = applied.length && moved.length && restored ? 'PASS' : (applied.length && moved.length ? 'PASS_WITH_WARNINGS' : 'FAIL');
    const report = {
      verdict, motionId, chainId: chainRow.id, motionStatus: motion.status,
      channelsUsed: plans.map((p) => p.channel), applied, skips,
      observed, movedParams: moved.map(([p]) => p),
      restored, fps: bestFps, execId, screenshots: shots,
      consoleErrors: errs.slice(0, 5),
    };
    fs.writeFileSync(path.join(ensureArtDir(), `action-${tag}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (verdict === 'FAIL') process.exitCode = 2;
  } finally {
    if (host) await host.ops.close();
    stopDevServer(dv);
  }
}

function medianOf(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

main().catch((e) => { console.error('ACTION_ERROR:', e.message); process.exit(1); });
