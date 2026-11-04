#!/usr/bin/env node
/**
 * M1-g 步骤 3「通道 A/B 判定实验」（真模型，dev-server + overlay 页）。
 *
 * 问题（G0 §6.4 风险 #1 的根因）：真实手臂动作写的是**姿态层** Param36..43 / 59..62，
 * 而 limb 能 own 的只有 RArm 这一层**物理输出**。如果姿态层能经物理带动 RArm，那"接管手臂"
 * 就有两条通道；如果不能，G2 planner 必须把两件事分开处理（普通写姿态 + 单独 own 输出）。
 *
 * 实验设计（每个相位持续 hold 足够长，避免把呼吸振荡当成因果）：
 *   baseline   不写任何参数            → RArm 的"自然轨迹"（ParamBreath 驱动）
 *   ctrl-angle 写 AngleX=30（头根输入） → 证明测量链路本身有效（ParamAngleX 必须跟随）
 *   ctrl-root  写 PositionY=12（手臂物理根输入） → 证明手臂物理对根输入有响应
 *   A-pose42   写 Param42=1（姿态层，非物理输出） → RArm 是否跟随？
 *   B-pose     写 Param36/39/40/41/43（整套右臂姿态） → RArm 是否跟随？
 *   limb-off   调 l2d_limb_acquire（flag 默认关） → 必须 limb-disabled
 *
 * 用法：先 `node tools/dev-server/index.mjs --port 5399`，浏览器打开
 *       http://127.0.0.1:5399/overlay-test.html（等模型就绪），再跑本脚本。
 *   node tools/acceptance/limb-channel-probe.mjs [--base http://127.0.0.1:5399]
 */
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = argOf('--base', 'http://127.0.0.1:5399');
const HOLD_MS = Number(argOf('--hold', '3000'));
const STEP_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 入队一条 AI 指令并等回执（overlay 页消费队列后 POST /ai/result）。 */
async function call(name, args = {}) {
  const r = await fetch(BASE + '/ai/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const q = await r.json();
  if (!q.id) throw new Error('enqueue failed: ' + JSON.stringify(q));
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const raw = await (await fetch(BASE + '/ai/result?id=' + q.id)).json();
    // aiInbox.read 在页面回执前返回占位 {ready:false}；真正回执包在 result 字段
    if (raw && raw.result) return raw.result;
  }
  throw new Error('timeout waiting result id=' + q.id);
}

function parsePv(state) {
  const pv = state && state.info && state.info.pv;
  const out = {};
  if (typeof pv !== 'string') return out;
  for (const token of pv.split(/\s+/)) {
    const m = token.replace(/\*$/, '').match(/^([^=]+)=(-?[0-9.]+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function sampleOnce() {
  const st = await call('l2d_get_state');
  return parsePv(st);
}

/** 在 holdMs 窗口内按 STEP_MS 采样，返回每个 id 的统计。 */
async function sampleWindow(label, holdMs) {
  const series = {};
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    const v = await sampleOnce();
    for (const [k, val] of Object.entries(v)) (series[k] || (series[k] = [])).push(val);
    await sleep(STEP_MS);
  }
  const stat = {};
  for (const [k, arr] of Object.entries(series)) {
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    stat[k] = { n, mean, min: Math.min(...arr), max: Math.max(...arr), range: Math.max(...arr) - Math.min(...arr) };
  }
  return { label, stat };
}

function fmt(x, d = 4) {
  return x === undefined ? 'n/a' : x.toFixed(d);
}

const rows = [];
function pushRow(label, stat) {
  const g = (id) => (stat[id] ? stat[id].mean : undefined);
  const r = (id) => (stat[id] ? stat[id].range : undefined);
  rows.push({
    label,
    RArm: [g('RArm'), r('RArm')],
    LArm: [g('LArm'), r('LArm')],
    ParamAngleX: [g('ParamAngleX'), r('ParamAngleX')],
    ParamBodyAngleX: [g('ParamBodyAngleX'), r('ParamBodyAngleX')],
  });
}

async function phase(label, writes, holdMs = HOLD_MS) {
  if (writes) {
    // 体位/角度类根输入用 add 语义；这里统一走 l2d_set_parameters（非物理输出 → 普通写）
    const rec = await call('l2d_set_parameters', { values: writes });
    console.log('[' + label + '] 写入 ' + JSON.stringify(writes) + ' -> applied=' + JSON.stringify(rec.applied) + ' failed=' + JSON.stringify(rec.failed));
    if (rec.failed && rec.failed.length) console.log('  !! failed: ' + JSON.stringify(rec.failed));
  }
  const w = await sampleWindow(label, holdMs);
  pushRow(label, w.stat);
  console.log('[' + label + '] RArm mean≈' + fmt(w.stat.RArm && w.stat.RArm.mean) + ' range=' + fmt(w.stat.RArm && w.stat.RArm.range));
  return w;
}

async function main() {
  const ready = await call('l2d_get_state');
  if (!ready.ready) {
    console.error('页面未就绪（overlay-test.html 未加载模型）：' + JSON.stringify(ready).slice(0, 200));
    process.exit(2);
  }

  // 0) 复位到静息，等呼吸/物理进入稳态
  await call('l2d_reset_pose');
  await sleep(800);

  await phase('baseline', null);
  await phase('ctrl-angle(AngleX=30)', { AngleX: 30 });
  await phase('ctrl-root(PositionY=12)', { PositionY: 12 });
  await phase('A-pose42(Param42=1)', { Param42: 1 });
  await phase('B-pose(36/39/40/41/43)', { Param36: 0.8, Param39: 0.3, Param40: 0.2, Param41: 0.6, Param43: 1 });

  // 复位所有实验写入
  await call('l2d_set_parameters', { values: { AngleX: 0, PositionY: 0, Param42: 0, Param36: 0, Param39: 0, Param40: 0, Param41: 0, Param43: 0 } });
  await sleep(300);

  // limb 通道：flag 默认关 → 必须明确回执 limb-disabled，不静默成功
  const limbOff = await call('l2d_limb_acquire', { side: 'right' });
  console.log('limb_acquire(side=right) -> ' + JSON.stringify(limbOff).slice(0, 400));
  let limbOn = false;
  if (limbOff && limbOff.ok === false && limbOff.reason === 'limb-disabled') {
    const limbRel = await call('l2d_limb_release', {});
    console.log('limb_release(flag 关) -> ' + JSON.stringify(limbRel).slice(0, 300));
  } else {
    // flag 开（node tools/acceptance/build-flagon.mjs --limb --keep）：走完整接管验收
    limbOn = true;
  }
  if (limbOn) {
    const acq = await call('l2d_limb_acquire', {
      side: 'right',
      runId: 'probe-right',
      durationMs: 5000,
      values: { RArm: 0.6 },
    });
    console.log('limb_acquire(side=right) 回执 -> ' + JSON.stringify({
      accepted: acq.accepted,
      runId: acq.runId,
      acquired: (acq.acquired || []).length,
      written: acq.written,
    }));
    const ownedWin = await sampleWindow('limb-owned(RArm=0.6)', 2400);
    pushRow('limb-owned(RArm=0.6)', ownedWin.stat);
    console.log('[limb-owned] RArm mean≈' + fmt(ownedWin.stat.RArm && ownedWin.stat.RArm.mean) + ' range=' + fmt(ownedWin.stat.RArm && ownedWin.stat.RArm.range) + ' / LArm mean≈' + fmt(ownedWin.stat.LArm && ownedWin.stat.LArm.mean));
    const rel = await call('l2d_limb_release', { runId: 'probe-right' });
    console.log('limb_release 回执 -> released=' + ((rel && rel.released) || []).length);
    const freeWin = await sampleWindow('limb-released', 2000);
    pushRow('limb-released', freeWin.stat);
    console.log('[limb-released] RArm mean≈' + fmt(freeWin.stat.RArm && freeWin.stat.RArm.mean) + ' range=' + fmt(freeWin.stat.RArm && freeWin.stat.RArm.range));
  }
  const st = await call('l2d_get_state');
  const limbState = st && st.diag && st.diag.limb;
  console.log('get_state diag.limb -> ' + JSON.stringify(limbState).slice(0, 400));

  console.log('\n=== 数据表（每个相位的 RArm / LArm / ParamAngleX / ParamBodyAngleX：均值 (极差)）===');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('phase', 26) + pad('RArm', 20) + pad('LArm', 20) + pad('ParamAngleX', 20) + 'ParamBodyAngleX');
  for (const r of rows) {
    const cell = (p) => fmt(p[0]) + ' (' + fmt(p[1], 3) + ')';
    console.log(pad(r.label, 26) + pad(cell(r.RArm), 20) + pad(cell(r.LArm), 20) + pad(cell(r.ParamAngleX), 20) + cell(r.ParamBodyAngleX));
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
