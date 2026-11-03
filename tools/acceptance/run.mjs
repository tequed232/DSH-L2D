#!/usr/bin/env node
/**
 * 运行时验收（一条命令）—— 对应 PR #11 的三项待验收。
 *
 *   node tools/acceptance/run.mjs                 # 默认读 ~/.dsh/l2d-service.json
 *   node tools/acceptance/run.mjs --origin http://127.0.0.1:10237
 *   node tools/acceptance/run.mjs --seconds 10 --min-fps 55
 *
 * 检查项：
 *   A 新产物：l2d_get_state.info 必须带 fpsCap / vsyncHz（缺了就是旧 bundle）
 *   B 前台帧率：Δframes / Δ墙钟 ≥ min-fps（失焦态按设计是 30，别在失焦时判失败）
 *   C 并行组：同组两条 look 应返回 accepted，且 action-done.notes 出现
 *     parallel-overlap-downgraded（同参数域自动降级串行）
 *
 * 退出码：0 全过；1 有 FAIL；2 连不上服务（DSH 没起 / 端口变了）。
 *
 * 注意：本脚本只读状态 + 发两条视线动作，不改设置、不写文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const ORIGIN = (argOf('origin', '') || readOrigin() || '').replace(/\/+$/, '');
const SECONDS = Number(argOf('seconds', 6));
const MIN_FPS = Number(argOf('min-fps', 55));
const RESULT_TIMEOUT = Number(argOf('timeout', 15000));

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

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL';
  console.log(`  ${tag}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function getJson(url, init) {
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

/** 入队一条 /ai/call，返回 id。 */
async function call(name, payload) {
  const r = await getJson(`${ORIGIN}/dsh-l2d/ai/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args: payload || {} }),
  });
  if (r.status !== 200) throw new Error(`${name} 入队失败 HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** 轮询 /ai/result 直到 ready，返回 { result, events }。 */
async function awaitResult(id, timeoutMs = RESULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  const events = [];
  while (Date.now() < deadline) {
    const r = await getJson(`${ORIGIN}/dsh-l2d/ai/result?id=${id}`);
    if (r.status === 200 && r.body && Array.isArray(r.body.events)) events.push(...r.body.events);
    if (r.status === 200 && r.body && r.body.ready) return { result: r.body.result, events };
    await sleep(400);
  }
  return { result: null, events };
}

/** 继续收一段时间事件（action-done 常在受理回执之后才到）。 */
async function drainEvents(id, ms) {
  const events = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await getJson(`${ORIGIN}/dsh-l2d/ai/result?id=${id}`);
    if (r.status === 200 && r.body && Array.isArray(r.body.events)) events.push(...r.body.events);
    await sleep(400);
  }
  return events;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ORIGIN) {
    console.error('找不到服务地址：既没传 --origin，也没读到 ~/.dsh/l2d-service.json');
    process.exit(2);
  }
  console.log(`\n[acceptance] origin=${ORIGIN}  seconds=${SECONDS}  minFps=${MIN_FPS}\n`);

  // 0 连通性
  try {
    const probe = await getJson(`${ORIGIN}/dsh-l2d/ai/result?id=0`);
    if (probe.status !== 200) throw new Error('HTTP ' + probe.status);
  } catch (e) {
    console.error(`连不上 ${ORIGIN}（${e.message}）。DSH 可能没启动，或端口已变——重启后重读会合文件。`);
    process.exit(2);
  }

  // A 新产物
  const stateId = await call('l2d_get_state', {});
  const state = await awaitResult(stateId, 8000);
  const info = (state.result && state.result.info) || null;
  if (!info) {
    record('A 新产物', false, 'get_state 未返回 info（渲染器未就绪？）');
  } else {
    const hasCap = typeof info.fpsCap === 'number';
    const hasVsync = typeof info.vsyncHz === 'number';
    record(
      'A 新产物',
      hasCap && hasVsync,
      hasCap && hasVsync
        ? `fpsCap=${info.fpsCap} vsyncHz=${info.vsyncHz} pxW×pxH=${info.pxW}×${info.pxH}`
        : `缺 ${[!hasCap && 'fpsCap', !hasVsync && 'vsyncHz'].filter(Boolean).join('/')} → 页面仍是旧 bundle`,
    );
    if (hasCap && info.pxW) {
      const expected = 593 * 741;
      const actual = Number(info.pxW) * Number(info.pxH);
      record(
        'A2 渲染倍率',
        actual < expected * 1.6,
        `pxW×pxH=${info.pxW}×${info.pxH}（2× 档应在 593×741 附近；1186×1482 说明还没吃 2048 档）`,
      );
    }
  }

  // B 前台帧率
  const s1 = info || {};
  await sleep(SECONDS * 1000);
  const id2 = await call('l2d_get_state', {});
  const st2 = await awaitResult(id2, 8000);
  const s2 = (st2.result && st2.result.info) || {};
  const dFrames = Number(s2.frames) - Number(s1.frames);
  if (!(dFrames >= 0) || !s1.frames) {
    record('B 前台帧率', false, 'frames 未推进（页面隐藏/被遮挡，或渲染器未启动）');
  } else {
    const fps = dFrames / SECONDS;
    record(
      'B 前台帧率',
      fps >= MIN_FPS,
      `${fps.toFixed(1)} fps（Δframes=${dFrames} / ${SECONDS}s，阈值 ${MIN_FPS}）` +
        (fps < MIN_FPS ? '；若窗口不在前台，失焦限帧就是 30，置前后重跑' : ''),
    );
  }

  // C 并行组降级
  if (flag('skip-parallel')) {
    record('C 并行组降级', 'warn', '已按 --skip-parallel 跳过');
  } else {
    const chain = [
      { kind: 'look', x: 0.6, y: 0.1, group: 'acc', mode: 'parallel', delayMs: 0 },
      { kind: 'look', x: -0.6, y: 0.1, group: 'acc', mode: 'parallel', delayMs: 0 },
    ];
    const actId = await call('l2d_act', { chain, priority: 'BACKGROUND' });
    const act = await awaitResult(actId, 12000);
    const r = act.result || {};
    const accepted = r.ok === true && (r.accepted === true || r.status === 'accepted' || r.accepted === undefined);
    const events = act.events.length ? act.events : await drainEvents(actId, 6000);
    const notes = events
      .filter((e) => e && (e.type === 'action-done' || e.phase === 'end' || e.kind === 'skip'))
      .flatMap((e) => [].concat(e.notes || [], e.note || []))
      .concat([].concat(r.notes || []))
      .filter(Boolean)
      .join(',');
    const downgraded = /parallel-overlap-downgraded/.test(notes);
    record(
      'C 并行组降级',
      accepted && downgraded,
      !accepted
        ? `受理失败：${JSON.stringify(r).slice(0, 160)}`
        : downgraded
          ? `notes=${notes}`
          : `受理 ok 但未见降级 notes（events=${events.length}，notes=${notes || '空'}）`,
    );
    // 收尾：把视线放回中立，避免留下歪头
    try {
      await call('l2d_reset', {});
    } catch {
      /* 忽略：收尾失败不影响验收结论 */
    }
  }

  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n[acceptance] ${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('[acceptance] 异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
