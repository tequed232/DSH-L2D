#!/usr/bin/env node
/**
 * 运行时验收（一条命令）。
 *
 *   node tools/acceptance/run.mjs                 # 默认读 ~/.dsh/l2d-service.json
 *   node tools/acceptance/run.mjs --origin http://127.0.0.1:3080
 *   node tools/acceptance/run.mjs --seconds 10 --min-fps 52
 *   node tools/acceptance/run.mjs --read-only     # 只做只读项，不发任何动作
 *
 * 检查项（A/A2/B/E/F GET 只读；D/C 发动作；F rescan 是 POST 重扫但不动角色）：
 *   A  新产物：get_state.info 必须带 fpsCap / vsyncHz（缺了就是旧 bundle）
 *   A2 渲染倍率：pxW×pxH 量级判断（≈1186×1482 = 还没吃 2048 档）
 *   B  前台帧率：Δframes / Δutime ≥ min-fps（utime 是渲染器累加渲染时间，不含轮询延迟）
 *   D  计划层：只带 group+timeoutMs 的链必须按整组超时收敛（reason=timeout）。
 *      这一项专门防「页面还在跑旧 overlay / 计划层没接线」——老路径会忽略 timeoutMs，等满 1.8s。
 *   C  并行组降级：同组两条 look，**结束事件**必须带 notes=parallel-overlap-downgraded。
 *   E  设置页：GET /dsh-l2d/settings 返回 200 且五个分区标题齐全。
 *   F  画像路由：GET /dsh-l2d/capability.json 契约（controls=20、modelId 非空）；
 *      POST /dsh-l2d/capability/rescan 重扫一次（只重建画像缓存，不驱动角色）。
 *   G  MCP 冒烟：spawn packages/dsh-l2d-mcp/src/server.mjs 走 JSON-RPC tools/list，
 *      工具数 ≥13 且含 l2d_act；l2d_posture 未实装记 WARN（对未上线 API 只做预埋检查）。
 *
 * 标志：
 *   --read-only      跳过 C/D（发动作）和 F 的 rescan（POST 写操作），其余照跑
 *   --skip-parallel  仅跳过 C（D 仍会发一条动作，要完全只读请用 --read-only）
 *   --skip-plan      仅跳过 D
 *   --min-boot-tag   页面新鲜度基准（默认 1793684582683）：bootTag 更旧的页面可能
 *                    是旧实例，或与并行代理的旧页面共享 /ai/poll 队列，回执不可信
 *   --verbose        打印 C 的原始事件，便于定位「notes 没产生」还是「没送到」
 *
 * 退出码：0 全过；1 有 FAIL；2 连不上服务（DSH 没起 / 端口变了）。
 *
 * 注意：C/D 会驱动角色做动作，别和他人同时操作同一实例（aiInbox 是全域抢占式队列）。
 * 发动作的入队调用带 2 次重试（并行代理的页面可能瞬时抢走队列），回执按 bootTag 判新鲜度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const ORIGIN = (argOf('origin', '') || readOrigin() || '').replace(/\/+$/, '');
const SECONDS = Number(argOf('seconds', 6));
const MIN_FPS = Number(argOf('min-fps', 52));
const RESULT_TIMEOUT = Number(argOf('timeout', 15000));
/** 并行组用例的取件窗口（秒）：结束回执带 notes，常在受理回执之后 1~3s 才到。 */
const DRAIN_MS = Math.max(2, Number(argOf('drain', 9))) * 1000;
/** 页面新鲜度基准：diag.bootTag 低于它的页面是旧实例 / 别的代理旧页面，动作回执不可信。 */
const MIN_BOOT_TAG = Number(argOf('min-boot-tag', 1793684582683));
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_SERVER = path.join(REPO_ROOT, 'packages', 'dsh-l2d-mcp', 'src', 'server.mjs');

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

/** 发动作前重试：并行代理的页面可能瞬时抢走 /ai/poll 队列导致入队失败，总共最多试 3 次。 */
async function callRetry(name, payload, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await call(name, payload);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(500);
    }
  }
  throw lastErr;
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

/**
 * spawn MCP server，走 stdio JSON-RPC 完成 initialize + tools/list，返回工具数组。
 * 只列工具，不调任何工具 → 不发动作、不碰角色。
 */
function mcpToolsList(serverPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err, tools) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出也无妨 */ }
      err ? reject(err) : resolve(tools);
    };
    const timer = setTimeout(
      () => finish(new Error(`tools/list ${timeoutMs}ms 内无响应${stderr ? '，stderr: ' + stderr.slice(-200) : ''}`)),
      timeoutMs,
    );
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(new Error('spawn 失败：' + e.message)));
    child.on('exit', (code) => {
      if (!done) finish(new Error(`server 提前退出 code=${code}${stderr ? '，stderr: ' + stderr.slice(-200) : ''}`));
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          finish(null, msg.result.tools);
        }
      }
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-acceptance', version: '0.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

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
  const diag = (state.result && state.result.diag) || null;
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
      // 判据用「量级」而不是某个固定像素值：窗口尺寸不同会让 593×741 变成 624×780，
      // 但 4096 贴图档 + 4× 会直接翻到 1186×1482 量级。
      // 盲区：1× 渲染（非 2×）也会落在"量级正常"里，像素级回归需比对 pxW/pxH 与窗口 CSS 尺寸的比值。
      const actual = Number(info.pxW) * Number(info.pxH);
      const tooBig = actual > 1186 * 1482 * 0.9;
      record(
        'A2 渲染倍率',
        !tooBig,
        `pxW×pxH=${info.pxW}×${info.pxH}${tooBig ? '（≈1186×1482 量级 = 还没吃 2048 档）' : ''}`,
      );
    }
  }

  // B 前台帧率：分母优先用渲染器自己的 utime（累加 CPU 渲染时间，不受轮询延迟影响），
  // 老包没有 utime 时退回墙钟。墙钟口径会把 400ms 轮询延迟算进去，低 ~5%。
  const s1 = info || {};
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const id2 = await call('l2d_get_state', {});
  const st2 = await awaitResult(id2, 8000);
  const wallSec = (Date.now() - t0) / 1000;
  const s2 = (st2.result && st2.result.info) || {};
  const dFrames = Number(s2.frames) - Number(s1.frames);
  const dUtime = Number(s2.utime) - Number(s1.utime);
  if (!(dFrames >= 0) || !s1.frames) {
    record('B 前台帧率', false, 'frames 未推进（页面隐藏/被遮挡，或渲染器未启动）');
  } else {
    const byUtime = Number.isFinite(dUtime) && dUtime > 0;
    const fps = byUtime ? dFrames / dUtime : dFrames / Math.max(1, wallSec);
    record(
      'B 前台帧率',
      fps >= MIN_FPS,
      `${fps.toFixed(1)} fps（Δframes=${dFrames} / ${byUtime ? dUtime.toFixed(2) + 's utime' : wallSec.toFixed(2) + 's 墙钟'}，阈值 ${MIN_FPS}）` +
        (fps < MIN_FPS ? '；若窗口不在前台，失焦限帧就是 30，置前后重跑' : ''),
    );
  }

  // D 计划层是否在跑（专门防「页面还在跑旧 overlay」这类假绿/假红）
  // 只带 timeoutMs 且 delayMs=0 的单个 look：计划层在跑 → 整组超时在 ~300ms 收敛，
  // 走老串行兜底 → timeoutMs 被忽略，要等满 life（1.8s+）。两者时间差一个数量级。
  // 回执可信度前置检查：bootTag 低于基准 = 连的是旧实例 / 并行代理的旧页面在抢队列。
  // 页面会把 bootTag 序列化成字符串，必须转数字再比，否则守卫静默失效。
  const bootTagRaw = diag ? diag.bootTag : null;
  const bootTagNum = Number(bootTagRaw);
  const bootTag = bootTagRaw != null && Number.isFinite(bootTagNum) ? bootTagNum : null;
  const pageStale = bootTag != null && bootTag < MIN_BOOT_TAG;
  if (flag('read-only') || flag('skip-plan')) {
    record('D 计划层', 'warn', flag('read-only') ? '已按 --read-only 跳过' : '已按 --skip-plan 跳过');
  } else if (pageStale) {
    record('D 计划层', 'warn', `页面 bootTag=${bootTag} 低于基准 ${MIN_BOOT_TAG}（旧实例或并行代理旧页面在消费队列），回执不可信 → 刷新页面 / 重启后重跑`);
  } else {
    const t = Date.now();
    const pid = await callRetry('l2d_act', {
      chain: [{ kind: 'look', x: 0.2, y: 0, group: 'probe', timeoutMs: 300 }],
      priority: 'FORCE',
    });
    const pr = await awaitResult(pid, 12000);
    const prr = pr.result || {};
    let endEv = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !endEv) {
      const more = await drainEvents(pid, 600);
      endEv = more.find((e) => e && e.phase === 'end' && e.runId === prr.runId) || null;
      if (!endEv && pr.events.length) {
        endEv = pr.events.find((e) => e && e.phase === 'end' && e.runId === prr.runId) || null;
      }
    }
    const elapsed = Date.now() - t;
    // 断言只看「是否按整组超时收敛」：elapsed 含 400ms 级轮询延迟，用它卡阈值等于在测观察者。
    const timedOut = !!endEv && endEv.reason === 'timeout';
    // 收敛耗时用页面自己的时间戳算（end.ts - start.ts），不含任何轮询延迟；
    // 老包没有 ts 时退回 elapsed，只做诊断不做断言。
    const startEv = (pr.events || []).find((e) => e && e.phase === 'start' && e.runId === prr.runId) || null;
    const chainMs = endEv && startEv && endEv.ts && startEv.ts ? endEv.ts - startEv.ts : null;
    const withinBudget = chainMs == null ? true : chainMs < 1400;
    const converged = timedOut && withinBudget;
    const versioned = !!(diag && diag.bootTag) && !!(diag && String(diag.scripts || '').includes('?v='));
    const ok = converged && versioned;
    record(
      'D 计划层',
      ok,
      !converged
        ? `链内 ${chainMs == null ? 'n/a' : chainMs + 'ms'} / 观测 ${elapsed}ms · end.reason=${endEv ? endEv.reason || '无' : '未收到'}${prr.planSource ? ' planSource=' + prr.planSource : ''} → 计划层未生效`
        : versioned
          ? `reason=timeout · 链内耗时 ${chainMs == null ? 'n/a' : chainMs + 'ms'}（观测 ${elapsed}ms 含轮询）· 产物带版本 ${diag.bootTag}`
          : `reason=timeout 但页面产物不可自证（bootTag=${(diag && diag.bootTag) || '无'}）`,
    );
  }

  // C 并行组降级（判据：notes 必须挂在**同一 runId 的结束事件**上；被插队也算，但只算 WARN）
  if (flag('read-only') || flag('skip-parallel')) {
    record('C 并行组降级', 'warn', flag('read-only') ? '已按 --read-only 跳过' : '已按 --skip-parallel 跳过');
  } else if (pageStale) {
    record('C 并行组降级', 'warn', `页面 bootTag=${bootTag} 低于基准 ${MIN_BOOT_TAG}（旧实例或并行代理旧页面在消费队列），回执不可信 → 刷新页面 / 重启后重跑`);
  } else {
    const chain = [
      { kind: 'look', x: 0.6, y: 0.1, group: 'acc', mode: 'parallel', delayMs: 0 },
      { kind: 'look', x: -0.6, y: 0.1, group: 'acc', mode: 'parallel', delayMs: 0 },
    ];
    // FORCE：环境自发动作抢不走，避免把「被插队」误判成「降级没生效」
    const actId = await callRetry('l2d_act', { chain, priority: 'FORCE' });
    const act = await awaitResult(actId, 12000);
    const r = act.result || {};
    const accepted = r.ok === true && (r.accepted === true || r.status === 'accepted');
    // 结束回执（带 notes）总是晚于受理回执到达，必须继续收，不能只看首个 ready。
    const events = act.events.concat(await drainEvents(actId, DRAIN_MS));
    if (flag('verbose')) {
      console.log('    [C] 受理回执: ' + JSON.stringify(r).slice(0, 260));
      console.log('    [C] events: ' + JSON.stringify(events).slice(0, 900));
    }
    const mine = events.filter((e) => e && e.type === 'action-done' && e.runId === r.runId);
    const end = mine.filter((e) => e.phase === 'end').pop() || null;
    const interrupted = mine.filter((e) => e.phase === 'interrupted').pop() || null;
    // PASS 只认**结束事件自己携带的 notes**：混入 planNotes 会让「计划算出来了但没送到」假绿。
    const notesOf = (ev) => [].concat((ev && ev.notes) || []).join(',');
    const planNotes = [].concat((r && r.planNotes) || []).join(',');
    const endNotes = notesOf(end);
    const intNotes = notesOf(interrupted);
    // 用前缀匹配，别把未来的 parallel-overlap-xxx 变体判死
    const RE = /parallel-overlap-downgraded/;
    let verdict;
    let detail;
    if (!accepted) {
      verdict = false;
      detail = `受理失败：${JSON.stringify(r).slice(0, 160)}`;
    } else if (end && end.reason !== 'timeout' && RE.test(endNotes)) {
      verdict = true;
      detail = `end.notes=${endNotes}`;
    } else if (interrupted && RE.test(intNotes)) {
      verdict = 'warn';
      detail = `被插队（interrupted）但 notes=${intNotes}`;
    } else {
      verdict = false;
      detail =
        `未见降级 notes（end=${end ? endNotes || '空' : '-'} / interrupted=${interrupted ? intNotes || '空' : '-'} / events=${events.length}` +
        `${r.planSource ? ' / planSource=' + r.planSource : ''}${planNotes ? ' / planNotes=' + planNotes : ''}）`;
    }
    record('C 并行组降级', verdict, detail);
    // 收尾：把视线放回中立，避免留下歪头
    try {
      await call('l2d_reset', {});
    } catch {
      /* 忽略：收尾失败不影响验收结论 */
    }
  }

  // E 设置页：GET 200 且五个分区标题齐全（纯读取；标题是分区导航的契约锚点，
  // 缺了 = 页面是旧 bundle 或分区被改名导致深链 / 自动化定位失效）。
  {
    const TITLES = ['显示与布局', '角色与模型', '情绪与行为', '动画与性能', '开发者工具'];
    let html = '';
    let status = 0;
    try {
      const res = await fetch(`${ORIGIN}/dsh-l2d/settings`, { cache: 'no-store' });
      status = res.status;
      html = await res.text();
    } catch (e) {
      html = 'FETCH-ERR ' + e.message;
    }
    const missing = TITLES.filter((t) => !html.includes(t));
    record(
      'E 设置页',
      status === 200 && missing.length === 0,
      status !== 200
        ? `HTTP ${status}（预期 200）→ 插件设置路由未挂载或服务是旧版本`
        : missing.length
          ? `缺分区标题：${missing.join('/')} → 页面是旧 bundle 或分区标题被改名`
          : `HTTP 200，分区标题 5/5 齐全`,
    );
  }

  // F 画像路由：capability.json 是 MCP / 上层规划的语义通道契约，
  // controls 数量变了 = 模型或扫描器变了，下游白名单会静默漂移，必须显式断言。
  // rescan 是 POST 重扫（重建画像缓存文件，不驱动角色），read-only 下跳过。
  {
    const cap = await getJson(`${ORIGIN}/dsh-l2d/capability.json`);
    const controls = cap.body && Array.isArray(cap.body.controls) ? cap.body.controls : null;
    const n = controls ? controls.length : -1;
    const modelId = cap.body && cap.body.modelId;
    record(
      'F 画像路由',
      // W3 合入后契约 = 标准 20 + W3 36 = 56（来源 tools/w3-registry/registry.json）
      cap.status === 200 && n === 56 && !!modelId,
      cap.status !== 200
        ? `capability.json HTTP ${cap.status}（预期 200）→ 画像路由未挂载`
        : n !== 56
          ? `controls.length=${n}（契约要求 20）→ 模型或扫描器输出变了，检查 tools/capability-scan`
          : !modelId
            ? 'modelId 为空 → 画像缺模型标识，上层无法绑定'
            : `controls=20 · modelId=${modelId}`,
    );
    if (flag('read-only')) {
      record('F rescan', 'warn', '已按 --read-only 跳过（POST 重扫）');
    } else {
      const rs = await getJson(`${ORIGIN}/dsh-l2d/capability/rescan`, { method: 'POST' });
      const rsText = typeof rs.body === 'string' ? rs.body : JSON.stringify(rs.body);
      record(
        'F rescan',
        rs.status === 200,
        rs.status === 200
          ? 'HTTP 200（重扫一次，画像缓存已重建）'
          : `HTTP ${rs.status}：${String(rsText).slice(0, 120)} → 重扫失败时 capability.json 可能滞留旧模型`,
      );
    }
  }

  // G MCP 冒烟：spawn MCP server 走 JSON-RPC tools/list（不起渲染、不连服务也能列工具）。
  // 判据：工具数 ≥13 且含 l2d_act；l2d_posture 未实装记 WARN——它是对未上线 API 的
  // 行为契约预埋，缺了不算失败，但要让实装进度可见。
  {
    let tools = null;
    let gError = '';
    try {
      tools = await mcpToolsList(MCP_SERVER, 15000);
    } catch (e) {
      gError = e && e.message ? e.message : String(e);
    }
    let verdict;
    let detail;
    if (!tools) {
      verdict = false;
      detail = gError || 'tools/list 无结果';
    } else {
      const names = tools.map((t) => t && t.name).filter(Boolean);
      const missingRequired = ['l2d_act'].filter((n) => !names.includes(n));
      const missingOptional = ['l2d_posture'].filter((n) => !names.includes(n));
      if (names.length < 13) {
        verdict = false;
        detail = `只列出 ${names.length} 个工具（要求 ≥13）→ server.mjs 注册中断或 SDK 依赖未安装（在 packages/dsh-l2d-mcp 跑 pnpm install）`;
      } else if (missingRequired.length) {
        verdict = false;
        detail = `缺必需工具：${missingRequired.join('/')}（现有 ${names.join(', ')}）`;
      } else if (missingOptional.length) {
        verdict = 'warn';
        detail = `${names.length} 个工具齐全（含 l2d_act）；${missingOptional.join('/')} 未实装 → WARN 不算 FAIL：该项是对未上线 API 的预埋检查，实装后应自动转 PASS`;
      } else {
        verdict = true;
        detail = `${names.length} 个工具，必需/可选全齐`;
      }
    }
    record('G MCP 冒烟', verdict, detail);
  }

  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n[acceptance] ${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('[acceptance] 异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
