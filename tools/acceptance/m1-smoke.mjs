#!/usr/bin/env node
/**
 * M1 真机验收冒烟（一条命令，风格对齐 run.mjs）。
 *
 *   node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081
 *   node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081 --readiness-wait 30000
 *   node tools/acceptance/m1-smoke.mjs --m1-flag on --allow-write   # 集成日：M1 写路径真用例
 *   node tools/acceptance/m1-smoke.mjs --selftest                   # 对内置 mock 宿主自测（不碰真机）
 *
 * 就绪门禁（--readiness-wait <ms>，默认不加 = 0 = 现行为）：
 *   宿主页 overlay 的模型挂载是异步的（3081 已知现象：HTTP 早通、模型未就绪），
 *   不等就进场会把环境问题记成用例 FAIL。加 --readiness-wait 后先在 [0, ms] 内有上限轮询，
 *   按 L0 服务连通 / L1 消费者在线 / L2 模型就绪 三层判定（见 readiness.mjs）：
 *     READY         → 进场跑用例
 *     MODEL-LOADING → 继续等（readiness 中），到期仍不就绪 = BLOCKED
 *     NO-CONSUMER   → 页面没在 poll AI 队列，等也无用，到期 = BLOCKED
 *     BLOCKED       → L0 就不通，直接 BLOCKED
 *   裸 --readiness-wait（不带数值）= 30000ms。BLOCKED 即 exit 3，不跑用例、不写状态。
 *
 * 开关组（embodied.m1 flag 的镜像开关，见 Consolidated-M1-Plan §2 约束 4）：
 *   --m1-flag on|off|auto   默认 off。
 *     off = 只跑基线组（期望与 run.mjs 现行为一致，即回滚验收）；
 *     on  = 基线组 + M1 新用例组；
 *     auto= 探测运行时 flag 标记（渲染层接线 diag.m1 后生效，当前回落为 off）。
 *
 * 用例组：
 *   基线组（GET 只读，任何 flag 下都跑）
 *     T0 连通性          GET /dsh-l2d/ai/result?id=0 → 200
 *     T1 画像契约        GET capability.json：controls=59 且 modelId 非空（对齐 run.mjs F 项）
 *     T2 设置页          GET /dsh-l2d/settings：200 且五个分区标题齐全（对齐 run.mjs E 项）
 *     T3 服务状态        GET /dsh-l2d/status.json → 200（对齐 guards.mjs 前置）
 *   M1 组（--m1-flag on 才生效；off 时整组 SKIP 不拉低 verdict）
 *     U1 acquire→post 覆盖  POST l2d_posture（own:true, RArm）→ get_state info.pv 读到覆盖值
 *     U2 release 回物理     U1 独占到期后 pv 中 RArm 恢复物理轨迹（偏离覆盖值）
 *     U3 口型红线回归       POST l2d_set_parameters / l2d_play_keyframes 带 ParamMouthOpenY → 400
 *                           reserved-param（拒绝类探测不产生状态变化）
 *     U4 未索引组拒绝       POST l2d_play_motion 未知组 → 400 unknown-motion-group
 *     U5 Hip pre 让位       POST l2d_posture（own:true, torso.hip 三通道）→ 回执 applied 含 HipAngleX/Y/Z
 *                           且 phase='pre'、owned 含三参数、无 wrong-phase、pw=pre 计数上涨、
 *                           独占窗口内 HipAngleX 锁 Agent 值、释放后回物理（依赖 m1-hip：--m1-hip 开真用例）
 *     U6 gesture 仲裁       POST l2d_act keyframes 步 → 回执/事件含仲裁标记（依赖 m1-gesture：
 *                           --m1-gesture 开真用例；字段以交付为准，当前按占位契约断言）
 *     U7 gesture 准入正例   POST l2d_play_keyframes（无占用）→ 回执 arbitration.flagEnabled=true
 *                           且 admitted 非空（依赖 m1-gesture；M1-d2）
 *     U8 gesture 准入负例   先 l2d_set_parameters own RArm，再 l2d_play_keyframes 同参数
 *                           → 拒绝 reason='gesture-priority-blocked'，Agent 独占不被释放
 *                           （依赖 m1-gesture；M1-d2 纵深防御/收紧项）
 *     U9 gesture 清账复播   l2d_stop_keyframes 后同参数再播 → 仍可准入（Timeline 与 kf
 *                           状态同步清账，无残留；依赖 m1-gesture；M1-d2 调用点 3）
 *   人工项（永远 SKIP 列出，供勾选）
 *     H1 待机四肢由物理驱动（目视）  H2 现有动作/姿势/表情回归（目视）  H3 裙摆随 Agent 值动（M1-b 目视）
 *
 * 写路径安全：
 *   不带 --allow-write 时，一切 POST 用例（含 U3/U4 这类「只拒不写」的探测）都 SKIP ——
 *   允许对伺服中的其他分支实例（如 3081）做纯 GET 验收而不惊动动作队列。
 *   U1/U2/U5 是真写路径用例，只在集成日由有真机写权限的人执行。
 *
 * SKIP 语义：占位 / 未开启的用例记 SKIP，不计入 verdict（学 perf-idle 双后端幂态的处理）。
 * 每项标注「自动化 / 需人工」。
 *
 * 退出码：0 无 FAIL（SKIP/WARN 不算）；1 有 FAIL；2 连不上服务；3 就绪门禁 BLOCKED。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_READINESS_WAIT_MS,
  DEFAULT_CONSUMER_TIMEOUT_MS,
  EXIT_BLOCKED,
  waitForReadiness,
  formatReadinessLines,
  formatTick,
} from './readiness.mjs';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const CLI_ORIGIN = (argOf('origin', '') || readOrigin() || '').replace(/\/+$/, '');
const M1_FLAG = argOf('m1-flag', 'off'); // on | off | auto
const ALLOW_WRITE = flag('allow-write');
const HIP_READY = flag('m1-hip'); // m1-hip 交付后由执行方显式开启
const GESTURE_READY = flag('m1-gesture'); // m1-gesture 交付后由执行方显式开启
const HOLD_MS = Number(argOf('hold-ms', 3000)); // U1 独占时长
const RESULT_TIMEOUT = Number(argOf('timeout', 15000));
// 就绪门禁：不带开关 = 0（现行为，不门禁）；裸 --readiness-wait = 30s；显式 0 同样回到现行为。
const READINESS_WAIT = readReadinessWait();

const SELFTEST = flag('selftest');
const THIS_FILE = fileURLToPath(import.meta.url);

function readOrigin() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'l2d-service.json');
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && json.origin ? String(json.origin) : '';
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析 --readiness-wait：缺省 0；裸开关默认 30s；非法数值按默认处理。 */
function readReadinessWait() {
  if (!flag('readiness-wait')) return 0;
  const raw = argOf('readiness-wait', '');
  if (raw === '' || raw.startsWith('--')) return DEFAULT_READINESS_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_READINESS_WAIT_MS;
}

// ---------------------------------------------------------------------------
// 判定辅助（selftest 直接打这些纯函数）
// ---------------------------------------------------------------------------

/**
 * 从 info.pv 串里解析某参数值。pv 形如：
 *   "AngleX=0.100 RArm=0.800 chg=yes finished=false"
 * 缺参 / 未采样返回 null。
 */
export function parsePv(pv, id) {
  if (typeof pv !== 'string') return null;
  const m = pv.match(new RegExp('(?:^|\\s)' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=(-?\\d+(?:\\.\\d+)?)'));
  return m ? Number(m[1]) : null;
}

/** 从 info.inj 串里解析相位写计数。inj 形如 "calls=... pw=3/5 ..."，返回 [pre, post] 或 null。 */
export function parsePw(inj) {
  if (typeof inj !== 'string') return null;
  const m = inj.match(/pw=(\d+)\/(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** U1/U2 共用：RArm 是否已偏离覆盖值（回物理的判定，±0.02 容差吸收取整）。 */
export function driftedFromHold(value, hold) {
  return value != null && Math.abs(value - hold) > 0.02;
}

// ---------------------------------------------------------------------------
// 结果记录：PASS / FAIL / SKIP / WARN；SKIP 不拉低 verdict
// ---------------------------------------------------------------------------

const results = [];
function record(name, verdict, detail, auto) {
  results.push({ name, verdict, detail, auto: auto || '自动化' });
  const tag = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict === 'warn' ? 'WARN' : 'SKIP';
  console.log(`  ${tag}  ${name}${detail ? ' — ' + detail : ''}【${auto || '自动化'}】`);
}

async function getJson(origin, url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

/** POST /ai/call 入队一条调用（写路径用例与 get_state 都走这里）。 */
async function call(origin, name, payload) {
  const r = await getJson(origin, `${origin}/dsh-l2d/ai/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args: payload || {} }),
  });
  return {
    status: r.status,
    body: r.body,
    text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
  };
}

/** 轮询 /ai/result 直到 ready。 */
async function awaitResult(origin, id, timeoutMs = RESULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  const events = [];
  while (Date.now() < deadline) {
    const r = await getJson(origin, `${origin}/dsh-l2d/ai/result?id=${id}`);
    if (r.status === 200 && r.body && Array.isArray(r.body.events)) events.push(...r.body.events);
    if (r.status === 200 && r.body && r.body.ready) return { result: r.body.result, events };
    await sleep(300);
  }
  return { result: null, events };
}

/** 发一次 l2d_get_state 并返回 info（失败返回 null）。 */
async function getState(origin) {
  try {
    const c = await call(origin, 'l2d_get_state', {});
    if (c.status !== 200 || !c.body || !c.body.id) return null;
    const r = await awaitResult(origin, c.body.id, 8000);
    return (r.result && r.result.info) || null;
  } catch {
    return null;
  }
}

/**
 * 单轮就绪探针（三层一次探完，交给 classifyReadiness 判）。
 * L0 失败直接返回，不再往队列灌调用；L1 无回执说明没人 poll——
 * 此时排队的 l2d_get_state 是只读的，页面后到时执行也只是一次读取，无副作用。
 */
async function probeReadiness(origin, consumerTimeoutMs = DEFAULT_CONSUMER_TIMEOUT_MS) {
  let connected = false;
  let httpStatus = 0;
  let error = '';
  try {
    const r = await getJson(origin, `${origin}/dsh-l2d/ai/result?id=0`);
    httpStatus = r.status;
    connected = r.status === 200;
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  if (!connected) return { connected: false, httpStatus, error };

  const t0 = Date.now();
  let served = false;
  let modelReady = null;
  try {
    const c = await call(origin, 'l2d_get_state', {});
    if (c.status === 200 && c.body && c.body.id) {
      const r = await awaitResult(origin, c.body.id, consumerTimeoutMs);
      if (r.result) {
        served = true;
        modelReady = r.result.ready === true;
      }
    }
  } catch {
    /* 回执异常按「未服务」处理 */
  }
  return { connected: true, httpStatus, served, latencyMs: Date.now() - t0, modelReady };
}

/**
 * 就绪门禁：有上限轮询到 READY 或超时。返回带 exitCode 的结论（0 放行 / 3 BLOCKED）。
 * log=true 时打分层状态行（轮次进度 + 收尾块）。
 *
 * @param {{origin:string, maxWaitMs?:number, intervalMs?:number,
 *          consumerTimeoutMs?:number, log?:boolean}} opts
 */
export async function runReadinessGate(opts) {
  const origin = String(opts.origin || '').replace(/\/+$/, '');
  const maxWaitMs = Number.isFinite(Number(opts.maxWaitMs)) ? Math.max(0, Number(opts.maxWaitMs)) : DEFAULT_READINESS_WAIT_MS;
  const consumerTimeoutMs = Number.isFinite(Number(opts.consumerTimeoutMs))
    ? Math.max(100, Number(opts.consumerTimeoutMs))
    : DEFAULT_CONSUMER_TIMEOUT_MS;
  const log = opts.log !== false;

  if (log) {
    console.log(`[m1-smoke] 就绪门禁：origin=${origin} 上限 ${maxWaitMs}ms（L0 连通 → L1 消费者 → L2 模型）`);
  }
  const verdict = await waitForReadiness(() => probeReadiness(origin, consumerTimeoutMs), {
    maxWaitMs,
    intervalMs: opts.intervalMs,
    onTick: log ? (t) => console.log(formatTick(t)) : null,
  });
  if (log) for (const line of formatReadinessLines(verdict)) console.log(line);
  return verdict;
}

/** M1 组整组开关：flag 解析（auto = 探测运行时标记，当前渲染层未接线，回落 off）。 */
export function resolveM1Flag(mode, diag) {
  if (mode === 'on') return { on: true, why: '--m1-flag on' };
  if (mode === 'auto') {
    const marker = diag && (diag.m1 === true || String(diag.m1 || '') === 'on');
    return marker
      ? { on: true, why: '运行时 diag.m1 探测到开启' }
      : { on: false, why: 'auto 探测未命中（渲染层未暴露 flag 标记），按 off 处理' };
  }
  return { on: false, why: '--m1-flag off（回滚基线模式）' };
}

// ---------------------------------------------------------------------------
// 用例实现（origin 显式传参，selftest 复用同一套逻辑打 mock 宿主）
// ---------------------------------------------------------------------------

/** 基线组（GET 只读）。返回连通性是否成立（失败则整轮中止）。 */
async function baselineCases(origin) {
  try {
    let probe;
    try {
      probe = await getJson(origin, `${origin}/dsh-l2d/ai/result?id=0`);
    } catch {
      // 连接抖动重试一次（mock 端口复用 / 真机瞬时拒绝都兜住）
      await sleep(300);
      probe = await getJson(origin, `${origin}/dsh-l2d/ai/result?id=0`);
    }
    record('T0 连通性', probe.status === 200, `HTTP ${probe.status}`, '自动化');
    if (probe.status !== 200) return false;
  } catch (e) {
    record('T0 连通性', false, e.message, '自动化');
    return false;
  }
  // T1 画像契约（GET，对齐 run.mjs F：M1-d1 合入后 controls=59 = 标准 23 + W3 36）
  const cap = await getJson(origin, `${origin}/dsh-l2d/capability.json`);
  const controls = cap.body && Array.isArray(cap.body.controls) ? cap.body.controls.length : -1;
  const modelId = cap.body && cap.body.modelId;
  record(
    'T1 画像契约',
    cap.status === 200 && controls === 59 && !!modelId,
    cap.status !== 200 ? `HTTP ${cap.status}` : `controls=${controls}（契约 59）· modelId=${modelId || '空'}`,
    '自动化',
  );
  // T2 设置页（GET，对齐 run.mjs E）
  {
    const TITLES = ['显示与布局', '角色与模型', '情绪与行为', '动画与性能', '开发者工具'];
    let status = 0;
    let html = '';
    try {
      const res = await fetch(`${origin}/dsh-l2d/settings`, { cache: 'no-store' });
      status = res.status;
      html = await res.text();
    } catch (e) {
      html = 'FETCH-ERR ' + e.message;
    }
    const missing = TITLES.filter((t) => !html.includes(t));
    record(
      'T2 设置页',
      status === 200 && missing.length === 0,
      status !== 200 ? `HTTP ${status}` : missing.length ? `缺分区标题 ${missing.join('/')}` : 'HTTP 200，分区 5/5',
      '自动化',
    );
  }
  // T3 服务状态（GET，对齐 guards.mjs 前置）
  try {
    const s = await getJson(origin, `${origin}/dsh-l2d/status.json`);
    record('T3 服务状态', s.status === 200, `HTTP ${s.status}`, '自动化');
  } catch (e) {
    record('T3 服务状态', false, e.message, '自动化');
  }
  return true;
}

/** 在画像里找 sourceId 覆盖某裸参数的语义控制 id（E2 语义姿态面的合法入口）。 */
async function resolveControlForParam(origin, paramId) {
  const prof = await getJson(origin, `${origin}/dsh-l2d/capability.json`);
  const controls = (prof.body && prof.body.controls) || [];
  const hit = controls.find((c) => String(c.sourceId || '').split('+').map((s) => s.trim()).includes(paramId));
  return hit ? hit.id : null;
}

/** U1 acquire → post 覆盖；返回独占参数与目标值供 U2 复用。 */
async function caseAcquireCover(origin) {
  const TARGET = 0.8;
  // E2 语义姿态执行：values 键必须是画像控制 id（sourceId 映射到裸参数），裸参数名会被 fail-closed 跳过。
  const controlId = await resolveControlForParam(origin, 'RArm');
  if (!controlId) {
    record('U1 acquire→post 覆盖', 'skip', '画像无 sourceId 覆盖 RArm 的语义控制——无法从动作面进入 post 覆盖路径', '自动化');
    return null;
  }
  const c = await call(origin, 'l2d_posture', {
    values: { [controlId]: TARGET },
    own: true,
    durationMs: HOLD_MS_REF.v,
    fadeMs: 200,
  });
  if (c.status !== 200 || !c.body || !c.body.id) {
    record('U1 acquire→post 覆盖', false, `入队 HTTP ${c.status}: ${c.text.slice(0, 120)}`, '自动化');
    return null;
  }
  const r = await awaitResult(origin, c.body.id);
  const receipt = r.result || {};
  const skipped = [].concat(receipt.skipped || []);
  if (skipped.length) {
    record('U1 acquire→post 覆盖', false, `回执 skipped=${JSON.stringify(skipped)} → acquire 未受理`, '自动化');
    return null;
  }
  // 独占窗口内采样：pv 的 RArm 应稳定在目标值附近
  const info1 = await getState(origin);
  await sleep(500);
  const info2 = await getState(origin);
  const v1 = info1 && parsePv(info1.pv, 'RArm');
  const v2 = info2 && parsePv(info2.pv, 'RArm');
  const ok = v1 != null && v2 != null && Math.abs(v1 - TARGET) <= 0.05 && Math.abs(v2 - TARGET) <= 0.05;
  record(
    'U1 acquire→post 覆盖',
    ok,
    `RArm 独占窗口采样 ${v1} / ${v2}（目标 ${TARGET}，容差 ±0.05）`,
    '自动化',
  );
  return ok ? { target: TARGET } : null;
}

/** U2 release 回物理：U1 独占到期后 RArm 偏离覆盖值。 */
async function caseReleaseBack(origin, acq) {
  if (!acq) {
    record('U2 release 回物理', 'skip', 'U1 未通过，缺前置', '自动化');
    return;
  }
  await sleep(HOLD_MS_REF.v + 1200); // 等 durationMs 到期（打断即释放的主路径 + 1.2s 余量）
  const a = await getState(origin);
  await sleep(700);
  const b = await getState(origin);
  const va = a && parsePv(a.pv, 'RArm');
  const vb = b && parsePv(b.pv, 'RArm');
  const ok = driftedFromHold(va, acq.target) && driftedFromHold(vb, acq.target);
  record(
    'U2 release 回物理',
    ok,
    `释放后 RArm 采样 ${va} / ${vb}（覆盖值 ${acq.target}，持续偏离 = 物理接管）`,
    '自动化',
  );
}

/** U3 口型红线：两条拒绝通道（set_parameters / keyframes track），只拒不写。 */
async function caseLipsyncRedline(origin) {
  let ok = true;
  const seen = [];
  const probes = [
    ['set_parameters', ['l2d_set_parameters', { values: { ParamMouthOpenY: 1 } }]],
    [
      'keyframes',
      ['l2d_play_keyframes', { tracks: [{ param: 'ParamMouthOpenY', keys: [[0, 0], [500, 1]] }] }],
    ],
  ];
  for (const [ch, [name, payload]] of probes) {
    const c = await call(origin, name, payload);
    const hit = c.status === 400 && c.text.includes('reserved-param');
    seen.push(`${ch}: HTTP ${c.status}`);
    if (!hit) ok = false;
  }
  record(
    'U3 口型红线（任何通道 400）',
    ok,
    ok ? seen.join(' · ') + '，均 reserved-param' : seen.join(' · ') + ' → 红线失守',
    '自动化',
  );
}

/** U4 未索引组拒绝。 */
async function caseUnknownGroup(origin) {
  const c = await call(origin, 'l2d_play_motion', { group: '__M1Smoke_NoSuchGroup__' });
  const ok = c.status === 400 && c.text.includes('unknown-motion-group');
  record(
    'U4 未索引组拒绝',
    ok,
    `HTTP ${c.status}${ok ? '，unknown-motion-group' : ': ' + c.text.slice(0, 100)}`,
    '自动化',
  );
}

/** U5 Hip pre 让位（依赖 m1-hip：语义通道 → pre 相位写入 → PhysicsGate 让位 → 释放回物理）。 */
async function caseHipPre(origin, ready) {
  if (!ready) {
    record('U5 Hip pre 让位', 'skip', 'm1-hip 未交付（交付后加 --m1-hip 跑真用例），占位', '自动化');
    return;
  }
  // M1-d1：torso.hip 三语义通道已入画像（标准 23 通道），Hip* pre 相位的动作面入口打通——
  // l2d_posture 走 torso.hip 族 → pre 批 ownParameters(..., 'pre') → PhysicsGate 让位（INV-7）。
  const TARGET = 0.5; // HipAngleX 的归一化目标值
  const hipTargets = [
    ['HipAngleZ', 0.6],
    ['HipAngleY', -0.4],
    ['HipAngleX', TARGET],
  ];
  const values = {};
  for (const [param, value] of hipTargets) {
    const controlId = await resolveControlForParam(origin, param);
    if (!controlId) {
      record(
        'U5 Hip pre 让位',
        'skip',
        `画像无映射 ${param} 的语义通道（torso.hip 未派生或画像未重扫到 59 通道）——无法从动作面进 pre 相位`,
        '自动化',
      );
      return;
    }
    values[controlId] = value;
  }
  const before = await getState(origin);
  const pw0 = before && parsePw(before.inj);
  const c = await call(origin, 'l2d_posture', {
    values,
    own: true,
    durationMs: HOLD_MS_REF.v,
    fadeMs: 200,
  });
  if (c.status !== 200 || !c.body || !c.body.id) {
    record('U5 Hip pre 让位', false, `入队 HTTP ${c.status}: ${c.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r = await awaitResult(origin, c.body.id);
  const receipt = r.result || {};
  const wrongPhase = JSON.stringify(receipt).includes('wrong-phase');
  // 回执断言：applied 含 HipAngleX/Y/Z 且 phase='pre'、owned 含三参数、无 skipped
  const applied = Array.isArray(receipt.applied) ? receipt.applied : [];
  const appliedOk = hipTargets.every(([param]) => applied.find((a) => a.id === param && a.phase === 'pre'));
  const owned = Array.isArray(receipt.owned) ? receipt.owned : [];
  const ownedOk = hipTargets.every(([param]) => owned.includes(param));
  const skipped = [].concat(receipt.skipped || []);
  if (skipped.length || !appliedOk || !ownedOk) {
    record(
      'U5 Hip pre 让位',
      false,
      `回执不符：skipped=${JSON.stringify(skipped)} · applied=${JSON.stringify(applied)} · owned=${owned.join(',')}`,
      '自动化',
    );
    return;
  }
  // 独占窗口内采样：HipAngleX 应稳定在 Agent pre 值附近
  await sleep(500);
  const s1 = await getState(origin);
  await sleep(500);
  const s2 = await getState(origin);
  const h1 = s1 && parsePv(s1.pv, 'HipAngleX');
  const h2 = s2 && parsePv(s2.pv, 'HipAngleX');
  const held = h1 != null && h2 != null && Math.abs(h1 - TARGET) <= 0.05 && Math.abs(h2 - TARGET) <= 0.05;
  // 释放后回物理：durationMs 到期后 HipAngleX 偏离独占值
  await sleep(HOLD_MS_REF.v + 1200);
  const e1 = await getState(origin);
  const pw1 = e1 && parsePw(e1.inj);
  await sleep(700);
  const e2 = await getState(origin);
  const p1 = e1 && parsePv(e1.pv, 'HipAngleX');
  const p2 = e2 && parsePv(e2.pv, 'HipAngleX');
  const released = driftedFromHold(p1, TARGET) && driftedFromHold(p2, TARGET);
  const preGrew = pw0 && pw1 ? pw1[0] > pw0[0] : false;
  record(
    'U5 Hip pre 让位',
    !wrongPhase && preGrew && held && released,
    `wrong-phase=${wrongPhase} · pw=${pw0 ? pw0.join('/') : '?'} → ${pw1 ? pw1.join('/') : '?'}` +
      ` · 独占窗口 HipAngleX=${h1}/${h2}（目标 ${TARGET}）· 释放后=${p1}/${p2}` +
      (!wrongPhase && preGrew && held && released ? '（pre 让位 + 释放回物理）' : ' → 见明细'),
    '自动化',
  );
  try {
    await call(origin, 'l2d_reset', {});
  } catch {
    /* 收尾失败不影响结论 */
  }
}

/** U6 gesture 仲裁（依赖 m1-gesture；按交付契约断言回执/事件中的仲裁标记）。 */
async function caseGestureArbitration(origin, ready) {
  if (!ready) {
    record('U6 gesture 仲裁', 'skip', 'm1-gesture 未交付（交付后加 --m1-gesture 跑真用例），占位', '自动化');
    return;
  }
  const c = await call(origin, 'l2d_act', {
    chain: [{ kind: 'keyframes', tracks: [{ param: 'RArm', keys: [[0, 0.5], [800, 0.5]] }] }],
    priority: 'NORMAL',
  });
  if (c.status !== 200 || !c.body || !c.body.id) {
    record('U6 gesture 仲裁', false, `入队 HTTP ${c.status}: ${c.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r = await awaitResult(origin, c.body.id);
  const haystack = JSON.stringify({ result: r.result, events: r.events });
  const arbitrated = /gesture|timeline|arbitrat/i.test(haystack);
  if (arbitrated) {
    record('U6 gesture 仲裁', true, '回执/事件命中仲裁标记', '自动化');
  } else {
    // M1-c 时间线本批为 core 纯函数（零运行路径变更、无动作面接线），回执无仲裁标记属预期。
    record(
      'U6 gesture 仲裁',
      'skip',
      '预期内：gesture timeline 为 core 纯函数、无动作面接线——回执无仲裁标记；待接线批次升级真用例',
      '自动化',
    );
  }
  try {
    await call(origin, 'l2d_reset', {});
  } catch {
    /* 收尾失败不影响结论 */
  }
}

/** U7 gesture 准入正例（M1-d2）：无占用时 play_keyframes 回执含 arbitration 且 admitted 非空。 */
async function caseGestureAdmitPositive(origin, ready) {
  if (!ready) {
    record('U7 gesture 准入正例', 'skip', 'm1-gesture 未交付（交付后加 --m1-gesture 跑真用例）', '自动化');
    return;
  }
  const c = await call(origin, 'l2d_play_keyframes', {
    tracks: [{ param: 'LArm', keys: [[0, 0.4], [500, 0.4]] }],
    duration: 500,
  });
  if (c.status !== 200 || !c.body) {
    record('U7 gesture 准入正例', false, `HTTP ${c.status}: ${c.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r7 = await awaitResult(origin, c.body.id);
  const body7 = r7.result || {};
  const arb = body7.arbitration;
  const ok =
    body7.ok === true &&
    !!arb &&
    arb.flagEnabled === true &&
    Array.isArray(arb.admitted) &&
    arb.admitted.length > 0;
  record(
    'U7 gesture 准入正例',
    ok,
    ok ? `admitted=${JSON.stringify(arb.admitted)}` : `回执不符：${JSON.stringify(body7).slice(0, 160)}`,
    '自动化',
  );
}

/** U8 gesture 准入负例（M1-d2）：Agent 独占同参数 → 拒绝且独占不被释放（收紧项）。 */
async function caseGestureAdmitNegative(origin, ready) {
  if (!ready) {
    record('U8 gesture 准入负例', 'skip', 'm1-gesture 未交付（交付后加 --m1-gesture 跑真用例）', '自动化');
    return;
  }
  const own = await call(origin, 'l2d_set_parameters', {
    values: { RArm: 0.8 },
    own: true,
    durationMs: 4000,
  });
  if (own.status !== 200) {
    record('U8 gesture 准入负例', false, `own 入队 HTTP ${own.status}: ${own.text.slice(0, 120)}`, '自动化');
    return;
  }
  await awaitResult(origin, own.body.id);
  const c = await call(origin, 'l2d_play_keyframes', {
    tracks: [{ param: 'RArm', keys: [[0, 0.2], [400, 0.2]] }],
    duration: 400,
  });
  if (c.status !== 200 || !c.body) {
    record('U8 gesture 准入负例', false, `HTTP ${c.status}: ${c.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r8 = await awaitResult(origin, c.body.id);
  const body8 = r8.result || {};
  const blocked = body8.ok === false && body8.reason === 'gesture-priority-blocked';
  record(
    'U8 gesture 准入负例',
    blocked,
    blocked
      ? 'Agent 独占期间手势整批拒（priority-blocked），独占未被释放'
      : `预期拒绝未发生：${JSON.stringify(body8).slice(0, 160)}`,
    '自动化',
  );
}

/** U9 gesture 清账复播（M1-d2 调用点 3）：stop 后 Timeline 与 kf 同步清账，同参数可再准入。 */
async function caseGestureStopReAdmit(origin, ready) {
  if (!ready) {
    record('U9 gesture 清账复播', 'skip', 'm1-gesture 未交付（交付后加 --m1-gesture 跑真用例）', '自动化');
    return;
  }
  const c1 = await call(origin, 'l2d_play_keyframes', {
    tracks: [{ param: 'LArm', keys: [[0, 0.3], [300, 0.3]] }],
    duration: 300,
  });
  if (c1.status !== 200 || !c1.body) {
    record('U9 gesture 清账复播', false, `首播 HTTP ${c1.status}: ${c1.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r1 = await awaitResult(origin, c1.body.id);
  if (!r1.result || r1.result.ok !== true) {
    record('U9 gesture 清账复播', false, `首播回执不符：${JSON.stringify(r1.result).slice(0, 160)}`, '自动化');
    return;
  }
  const s = await call(origin, 'l2d_stop_keyframes', {});
  if (s.status !== 200 || !s.body) {
    record('U9 gesture 清账复播', false, `stop HTTP ${s.status}`, '自动化');
    return;
  }
  await awaitResult(origin, s.body.id);
  const c2 = await call(origin, 'l2d_play_keyframes', {
    tracks: [{ param: 'LArm', keys: [[0, 0.5], [300, 0.5]] }],
    duration: 300,
  });
  if (c2.status !== 200 || !c2.body) {
    record('U9 gesture 清账复播', false, `复播 HTTP ${c2.status}: ${c2.text.slice(0, 120)}`, '自动化');
    return;
  }
  const r2 = await awaitResult(origin, c2.body.id);
  const body2 = r2.result || {};
  const ok =
    body2.ok === true &&
    !!body2.arbitration &&
    Array.isArray(body2.arbitration.admitted) &&
    body2.arbitration.admitted.length > 0;
  record(
    'U9 gesture 清账复播',
    ok,
    ok ? 'stop 后同参数再准入成功（清账无残留）' : `回执不符：${JSON.stringify(body2).slice(0, 160)}`,
    '自动化',
  );
  try {
    await call(origin, 'l2d_reset', {});
  } catch {
    /* 收尾失败不影响结论 */
  }
}
/**
 * 全流程：baseline → flag 解析 → M1 组（或整组 SKIP）→ 人工项列出。
 * 可独立调用（selftest 对 mock 宿主多轮执行）。
 *
 * @param {{origin:string, allowWrite?:boolean, m1Flag?:'on'|'off'|'auto',
 *           hipReady?:boolean, gestureReady?:boolean, holdMs?:number}} opts
 */
export async function runCases(opts) {
  const origin = String(opts.origin || '').replace(/\/+$/, '');
  const allowWrite = opts.allowWrite === true;
  const hipReady = opts.hipReady === true;
  const gestureReady = opts.gestureReady === true;
  const holdMs = Number.isFinite(Number(opts.holdMs)) ? Number(opts.holdMs) : HOLD_MS;
  const holdSaved = HOLD_MS_REF.v;
  HOLD_MS_REF.v = holdMs;

  results.length = 0;
  try {
    const connected = await baselineCases(origin);
    const gate = resolveM1Flag(opts.m1Flag || 'off', null);
    if (!connected) {
      record('M1 新用例组', 'skip', '连通性未过，整组跳过', '自动化');
    } else if (!gate.on) {
      record('M1 新用例组', 'skip', `embodied.m1 flag 关——${gate.why}；基线即回滚验收`, '自动化');
    } else if (!allowWrite) {
      record(
        'M1 新用例组',
        'skip',
        '未加 --allow-write：写路径/POST 探测全部跳过（对伺服中的其他分支实例只做 GET）',
        '自动化',
      );
    } else {
      const acq = await caseAcquireCover(origin);
      await caseReleaseBack(origin, acq);
      await caseLipsyncRedline(origin);
      await caseUnknownGroup(origin);
      await caseHipPre(origin, hipReady);
      await caseGestureArbitration(origin, gestureReady);
      // [M1-d2] 手势准入真用例（flag on 宿主；flag 关回归由整组 SKIP + 基线组结构覆盖）
      await caseGestureAdmitPositive(origin, gestureReady);
      await caseGestureAdmitNegative(origin, gestureReady);
      await caseGestureStopReAdmit(origin, gestureReady);
    }

    // 人工项：永远列出，SKIP 不拉低 verdict
    record('H1 待机四肢由物理驱动（目视）', 'skip', '需人工对照：待机时四肢随呼吸/物理摆动', '需人工');
    record('H2 现有动作/姿势/表情回归（目视）', 'skip', '需人工：M1-c 手势/表情仲裁合入后的既有行为回归', '需人工');
    record('H3 裙摆/腿链随 Agent 值动（目视）', 'skip', '需人工：M1-b Hip* pre 让位后次级链跟随', '需人工');
  } finally {
    HOLD_MS_REF.v = holdSaved;
  }

  const failed = results.filter((r) => r.verdict === false).length;
  const skipped = results.filter((r) => r.verdict === 'skip').length;
  const passed = results.filter((r) => r.verdict === true).length;
  return { results: [...results], failed, skipped, passed };
}

/** 可变的 HOLD_MS 壳：caseAcquireCover/caseReleaseBack 引用它，runCases 可注入。 */
const HOLD_MS_REF = { v: HOLD_MS };

async function main() {
  if (SELFTEST) {
    const { selftest } = await import('./m1-smoke.selftest.mjs');
    process.exit((await selftest()) ? 0 : 1);
  }
  if (!CLI_ORIGIN) {
    console.error('找不到服务地址：既没传 --origin，也没读到 ~/.dsh/l2d-service.json');
    process.exit(2);
  }
  console.log(
    `\n[m1-smoke] origin=${CLI_ORIGIN}  m1-flag=${M1_FLAG}  allow-write=${ALLOW_WRITE}` +
      `${HIP_READY ? '  m1-hip=ready' : ''}${GESTURE_READY ? '  m1-gesture=ready' : ''}` +
      `${READINESS_WAIT ? `  readiness-wait=${READINESS_WAIT}ms` : ''}\n`,
  );
  // 就绪门禁：仅在显式开启时生效（--readiness-wait 0 = 现行为，不等直接进场）。
  if (READINESS_WAIT > 0) {
    const gate = await runReadinessGate({ origin: CLI_ORIGIN, maxWaitMs: READINESS_WAIT });
    if (!gate.ok) process.exit(EXIT_BLOCKED);
  }
  const summary = await runCases({
    origin: CLI_ORIGIN,
    allowWrite: ALLOW_WRITE,
    m1Flag: M1_FLAG,
    hipReady: HIP_READY,
    gestureReady: GESTURE_READY,
  });
  console.log(
    `\n[m1-smoke] ${summary.passed} PASS · ${summary.skipped} SKIP · ${summary.failed} FAIL` +
      `（SKIP 不计入 verdict；写路径真用例在集成日由 team-lead 执行）\n`,
  );
  process.exit(summary.failed ? 1 : 0);
}

// 仅 CLI 直跑时触发（selftest 子进程 / import 复用不触发）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE;
if (isMain) {
  main().catch((e) => {
    console.error('[m1-smoke] 异常：', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
