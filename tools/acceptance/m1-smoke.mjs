#!/usr/bin/env node
/**
 * M1 真机验收冒烟（一条命令，风格对齐 run.mjs）。
 *
 *   node tools/acceptance/m1-smoke.mjs --origin http://127.0.0.1:3081
 *   node tools/acceptance/m1-smoke.mjs --m1-flag on --allow-write   # 集成日：M1 写路径真用例
 *   node tools/acceptance/m1-smoke.mjs --selftest                   # 对内置 mock 宿主自测（不碰真机）
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
 *     T1 画像契约        GET capability.json：controls=56 且 modelId 非空（对齐 run.mjs F 项）
 *     T2 设置页          GET /dsh-l2d/settings：200 且五个分区标题齐全（对齐 run.mjs E 项）
 *     T3 服务状态        GET /dsh-l2d/status.json → 200（对齐 guards.mjs 前置）
 *   M1 组（--m1-flag on 才生效；off 时整组 SKIP 不拉低 verdict）
 *     U1 acquire→post 覆盖  POST l2d_posture（own:true, RArm）→ get_state info.pv 读到覆盖值
 *     U2 release 回物理     U1 独占到期后 pv 中 RArm 恢复物理轨迹（偏离覆盖值）
 *     U3 口型红线回归       POST l2d_set_parameters / l2d_play_keyframes 带 ParamMouthOpenY → 400
 *                           reserved-param（拒绝类探测不产生状态变化）
 *     U4 未索引组拒绝       POST l2d_play_motion 未知组 → 400 unknown-motion-group
 *     U5 Hip pre 让位       POST l2d_posture（own:true, HipAngleX）→ 受理且无 wrong-phase，
 *                           get_state info.inj 的 pw=pre 计数上涨（依赖 m1-hip：--m1-hip 开真用例）
 *     U6 gesture 仲裁       POST l2d_act keyframes 步 → 回执/事件含仲裁标记（依赖 m1-gesture：
 *                           --m1-gesture 开真用例；字段以交付为准，当前按占位契约断言）
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
 * 退出码：0 无 FAIL（SKIP/WARN 不算）；1 有 FAIL；2 连不上服务。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // T1 画像契约（GET，对齐 run.mjs F：W3 合入后 controls=56）
  const cap = await getJson(origin, `${origin}/dsh-l2d/capability.json`);
  const controls = cap.body && Array.isArray(cap.body.controls) ? cap.body.controls.length : -1;
  const modelId = cap.body && cap.body.modelId;
  record(
    'T1 画像契约',
    cap.status === 200 && controls === 56 && !!modelId,
    cap.status !== 200 ? `HTTP ${cap.status}` : `controls=${controls}（契约 56）· modelId=${modelId || '空'}`,
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

/** U1 acquire → post 覆盖；返回独占参数与目标值供 U2 复用。 */
async function caseAcquireCover(origin) {
  const TARGET = 0.8;
  const c = await call(origin, 'l2d_posture', {
    values: { RArm: TARGET },
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
    record('U1 acquire→post 覆盖', false, `回执 skipped=${skipped.join(',')} → acquire 未受理`, '自动化');
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

/** U5 Hip pre 让位（依赖 m1-hip：PhysicsGate 接线后 pw=pre 计数上涨）。 */
async function caseHipPre(origin, ready) {
  if (!ready) {
    record('U5 Hip pre 让位', 'skip', 'm1-hip 未交付（交付后加 --m1-hip 跑真用例），占位', '自动化');
    return;
  }
  const before = await getState(origin);
  const pw0 = before && parsePw(before.inj);
  const c = await call(origin, 'l2d_posture', {
    values: { HipAngleX: 8 },
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
  await sleep(600);
  const after = await getState(origin);
  const pw1 = after && parsePw(after.inj);
  const preGrew = pw0 && pw1 ? pw1[0] > pw0[0] : false;
  record(
    'U5 Hip pre 让位',
    !wrongPhase && preGrew,
    `wrong-phase=${wrongPhase} · pw=${pw0 ? pw0.join('/') : '?'} → ${pw1 ? pw1.join('/') : '?'}` +
      (preGrew ? '（pre 计数已上涨）' : ' → PhysicsGate 未接管 Hip* 写'),
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
  record(
    'U6 gesture 仲裁',
    arbitrated,
    arbitrated ? '回执/事件命中仲裁标记' : '回执/事件未见仲裁标记（核对 m1-gesture 实际回执字段后同步断言）',
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
      `${HIP_READY ? '  m1-hip=ready' : ''}${GESTURE_READY ? '  m1-gesture=ready' : ''}\n`,
  );
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
