#!/usr/bin/env node
/**
 * 长窗口帧率幂态验收（P1：渲染调度）。
 *
 *   node tools/acceptance/perf-idle.mjs                          # 真机：读 ~/.dsh/l2d-service.json，HTTP 轮询
 *   node tools/acceptance/perf-idle.mjs --origin http://127.0.0.1:3081
 *   node tools/acceptance/perf-idle.mjs --cdp 9222               # CDP 模式：全量三态断言
 *   node tools/acceptance/perf-idle.mjs --cdp 9222 --spawn       # 先拉起本地 Chrome（headless）再跑
 *   node tools/acceptance/perf-idle.mjs --window-ms 20000 --json-out idle.json
 *
 * 断言（每组窗口默认 ≥20s，帧计数来自渲染器自报，跨组不重置）：
 *   A 前台待机 60   ：Δframes/Δt ≥ --min-idle-fps（默认 50），且采样期内 fpsCap==60
 *   B 失焦降载 30   ：注入 blur 后 fps 落在 [--min-blur-fps, --max-blur-fps]（默认 24~42），fpsCap==30
 *   C 页面隐藏暂停  ：注入 document.hidden=true，连续 --hidden-windows（3）组各 ≥20s，
 *                     每组 Δframes === 0
 *   D 恢复可见无突跳：恢复后帧计数恢复增长；rAF 帧间隔 P99 ≤ --p99-max-ms（默认 150），
 *                     max ≤ --p99-max-ms × 2.5 —— 防恢复后补帧爆发/delta 瞬移
 *
 * 状态注入说明（CDP 模式）：对目标页面 Runtime.evaluate 注入合成事件——
 *   blur/focus 直接 dispatchEvent；隐藏用 Object.defineProperty(document,'hidden')
 *   + visibilitychange，与渲染器调度守卫读的完全是同一信号源。
 *
 * 双后端：
 *   CDP 模式（--cdp）  ：全量 A~D。
 *   HTTP 模式（缺省）  ：真机没有 eval 通道，只跑 A（l2d_get_state 轮询 frames/utime），
 *                        B/C/D 记 SKIP（不拉低 verdict）。A 若实测 ~30fps 多半是窗口
 *                        真失焦了，FAIL 详情里会提示置前后重跑。
 *
 * 输出：过程行 + 末尾一行摘要 JSON（verdict: PASS/FAIL，exit 0/1；连不上 exit 2）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const ORIGIN = (argOf('origin', '') || readOrigin() || '').replace(/\/+$/, '');
const WINDOW_MS = Number(argOf('window-ms', 20000));
const HIDDEN_WINDOWS = Math.max(1, Number(argOf('hidden-windows', 3)));
const SETTLE_MS = Number(argOf('settle-ms', 3000)); // > 2.5s 交互滞回，注入状态后等它滑出
const RESTORE_MS = Number(argOf('restore-ms', 5000));
const POLL_MS = Number(argOf('poll-ms', 250));
const MIN_IDLE_FPS = Number(argOf('min-idle-fps', 50));
const MIN_BLUR_FPS = Number(argOf('min-blur-fps', 24));
const MAX_BLUR_FPS = Number(argOf('max-blur-fps', 42));
const P99_MAX_MS = Number(argOf('p99-max-ms', 150));
const CDP_ARG = argOf('cdp', '');
const CDP_PORT = /^\d+$/.test(CDP_ARG || '') ? Number(CDP_ARG) : Number(argOf('cdp-port', 9222));
const JSON_OUT = argOf('json-out', '');

function readOrigin() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    const json = JSON.parse(fs.readFileSync(path.join(home, 'l2d-service.json'), 'utf8'));
    return json && json.origin ? String(json.origin) : '';
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, verdict, detail, metrics = null) {
  results.push({ name, verdict, detail, metrics });
  const tag = verdict === true ? 'PASS' : verdict === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`  ${tag}  ${name} — ${detail}`);
}

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }

  static connect(wsUrl, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('CDP ws 连接超时'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP ws 连接失败'));
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 15000);
    });
  }

  /** 页面里执行表达式；返回 returnByValue 的值，页面抛错则抛异常 */
  async eval(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面执行失败: ' + String(text).slice(0, 200));
    }
    return r ? r.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function normalizeCdpHttp(v) {
  if (!v) return null;
  if (/^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
  if (/:\d+$/.test(v)) return 'http://' + v;
  return 'http://127.0.0.1:' + Number(v);
}

/** 在 cdpHttp 上找 origin 对应的 page；找不到可按 --new-tab 开新页 */
async function findOrOpenPage(cdpHttp, origin) {
  const list = await (await fetch(`${cdpHttp}/json/list`)).json();
  let page = (list || []).find((t) => t.type === 'page' && String(t.url || '').startsWith(origin));
  if (!page && (flag('new-tab') || flag('spawn'))) {
    const open = await fetch(`${cdpHttp}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' }).catch(() =>
      fetch(`${cdpHttp}/json/new?${encodeURIComponent(origin)}`),
    );
    page = await open.json();
  }
  if (!page) {
    const pages = (list || []).filter((t) => t.type === 'page').map((t) => t.url).slice(0, 5);
    throw new Error(`CDP 下没有 ${origin} 的页面（现有: ${pages.join(' | ') || '无'}）；加 --new-tab 可自动开页`);
  }
  return page;
}

/** 本地拉起 headless Chrome（验证 dev-server / 本机复现用） */
function spawnBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge（可用 CHROME_PATH 指定）');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-idle-'));
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=700,900',
    'about:blank',
  ], { stdio: 'ignore' });
  child.unref();
  console.log(`[perf-idle] 已拉起浏览器 ${path.basename(exe)}（cdp=${CDP_PORT}，临时档案 ${profile}）`);
}

// ---------------------------------------------------------------- 页面读数 / 状态注入

/** 等浏览器调试端口就绪（spawn 后启动需要几秒） */
async function waitCdpUp(cdpHttp, timeoutMs = 20000) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${cdpHttp}/json/version`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    await sleep(500);
  }
  throw new Error(`调试端口 ${timeoutMs}ms 内未就绪（${lastErr}）`);
}


const EXPR_STATE = `(() => {
  const api = window.DSH_L2D;
  if (!api || typeof api.getInfo !== 'function') return { ok: false, reason: 'no-DSH_L2D' };
  const ready = typeof api.isReady === 'function' ? api.isReady() : false;
  if (!ready) return { ok: false, reason: 'not-ready' };
  const info = api.getInfo();
  return {
    ok: true,
    frames: info.frames,
    fpsCap: info.fpsCap,
    utime: info.utime,
    rm: info.rm,
    hidden: document.hidden,
  };
})()`;

const EXPR = {
  show: `(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); return document.hidden; })()`,
  hide: `(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return document.hidden; })()`,
  focus: `(() => { window.dispatchEvent(new Event('focus')); return true; })()`,
  blur: `(() => { window.dispatchEvent(new Event('blur')); return true; })()`,
  // 恢复后采 5s rAF 时间戳，node 侧算帧间隔 P99（测恢复补帧/delta 突跳）
  gaps: `new Promise((resolve) => {
    const ts = []; let last = 0; const t0 = performance.now();
    function lp(t) { if (last) ts.push(t - last); last = t; if (t - t0 < 5000) requestAnimationFrame(lp); else resolve(ts); }
    requestAnimationFrame(lp);
  })`,
};

/** dev-server 调试页自举（真实 DSH 页面本就已挂载，走 not-ready 之外不会进这里） */
const EXPR_BOOT = `(async () => {
  const api = window.DSH_L2D;
  if (api && typeof api.isReady === 'function' && api.isReady()) return { ok: true, pre: true };
  try {
    const r = await fetch('/api/models');
    if (!r.ok) return { ok: false, reason: 'not-ready 且页面无 /api/models（自举仅支持 dev-server）' };
    const name = ((await r.json()).models || [])[0];
    if (!name) return { ok: false, reason: '/api/models 无模型' };
    const loadScript = (src) => new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = () => res(true); s.onerror = () => rej(new Error('load fail: ' + src));
      document.head.appendChild(s);
    });
    await loadScript('/core.js');
    await loadScript('/renderer.js');
    if (!window.DSH_L2D) return { ok: false, reason: 'renderer.js 加载后仍无 DSH_L2D' };
    await window.DSH_L2D.loadCore('/core.js');
    let cv = document.getElementById('dsh-idle-stage');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'dsh-idle-stage';
      cv.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:800px;';
      document.body.appendChild(cv);
    }
    await window.DSH_L2D.mount(cv, { modelUrl: '/model/' + encodeURIComponent(name), width: 600, height: 800 });
    return { ok: !!window.DSH_L2D.isReady() };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
})()`;

async function waitReady(cdp, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await cdp.eval(EXPR_STATE);
    if (s && s.ok) return s;
    if (Date.now() - t0 > timeoutMs) {
      const boot = await cdp.eval(EXPR_BOOT, { awaitPromise: true }).catch((e) => ({ ok: false, reason: e.message }));
      if (!boot || !boot.ok) throw new Error('渲染器未就绪：' + ((boot && boot.reason) || 'unknown'));
    }
    await sleep(500);
  }
}

/**
 * 采样一个窗口：每 POLL_MS 读一次 frames，返回 { dtMs, dFrames, fpsCaps, fps }。
 * fps 用首尾帧差（不是采样点均值），与 run.mjs 口径一致。
 */
async function sampleWindow(cdp, durationMs) {
  const first = await cdp.eval(EXPR_STATE);
  if (!first || !first.ok) throw new Error('采样起点读取失败: ' + (first && first.reason));
  const t0 = Date.now();
  const fpsCaps = new Set();
  let last = first;
  while (Date.now() - t0 < durationMs) {
    await sleep(POLL_MS);
    const s = await cdp.eval(EXPR_STATE).catch(() => null);
    if (s && s.ok) {
      last = s;
      fpsCaps.add(s.fpsCap);
    }
  }
  const dtMs = Date.now() - t0;
  const dFrames = last.frames - first.frames;
  return { dtMs, dFrames, fps: (dFrames / dtMs) * 1000, fpsCaps: [...fpsCaps], hidden: last.hidden };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------- HTTP 后端（真机无 CDP）

async function httpGetState(timeoutMs = 8000) {
  const r = await fetch(`${ORIGIN}/dsh-l2d/ai/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'l2d_get_state', args: {} }),
  });
  if (r.status !== 200) throw new Error(`l2d_get_state 入队失败 HTTP ${r.status}`);
  const { id } = await r.json();
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${ORIGIN}/dsh-l2d/ai/result?id=${id}`);
    if (res.status === 200) {
      const body = await res.json();
      if (body && body.ready) return body.result;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('l2d_get_state 回执超时');
    await sleep(400);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!ORIGIN) {
    console.error('找不到服务地址：既没传 --origin，也没读到 ~/.dsh/l2d-service.json');
    process.exit(2);
  }
  const cdpHttp = normalizeCdpHttp(CDP_ARG);
  let cdp = null;
  if (flag('spawn')) spawnBrowser();
  if (cdpHttp) {
    try {
      if (flag('spawn')) await waitCdpUp(cdpHttp);
      const page = await findOrOpenPage(cdpHttp, ORIGIN);
      cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      console.log(`[perf-idle] CDP 已连接：${page.url}`);
    } catch (e) {
      console.error(`[perf-idle] CDP 不可用（${e.message}），退回 HTTP 轮询模式`);
    }
  }
  if (cdp) await cdp.send('Runtime.enable');

  const startedAt = new Date().toISOString();
  console.log(`\n[perf-idle] origin=${ORIGIN} mode=${cdp ? 'cdp' : 'http'} window=${WINDOW_MS}ms hiddenWindows=${HIDDEN_WINDOWS}\n`);
  try {
    if (cdp) {
      const st = await waitReady(cdp);
      console.log(`[perf-idle] 渲染器就绪 frames=${st.frames} fpsCap=${st.fpsCap} rm=${st.rm}`);

      // ---- A 前台待机 60
      await cdp.eval(EXPR.show);
      await cdp.eval(EXPR.focus);
      await sleep(SETTLE_MS); // 等 focus 注入产生的交互滞回滑出
      const a = await sampleWindow(cdp, WINDOW_MS);
      record(
        'A 前台待机60',
        a.dFrames > 0 && a.fps >= MIN_IDLE_FPS && a.fpsCaps.every((v) => v === 60),
        `${a.fps.toFixed(1)} fps（Δframes=${a.dFrames} / ${(a.dtMs / 1000).toFixed(1)}s，fpsCap=${a.fpsCaps.join('/')}，阈值 ≥${MIN_IDLE_FPS}）`,
        a,
      );

      // ---- B 失焦降载 30
      await cdp.eval(EXPR.blur);
      await sleep(SETTLE_MS);
      const b = await sampleWindow(cdp, WINDOW_MS);
      record(
        'B 失焦降载30',
        b.dFrames > 0 && b.fps >= MIN_BLUR_FPS && b.fps <= MAX_BLUR_FPS && b.fpsCaps.every((v) => v === 30),
        `${b.fps.toFixed(1)} fps（Δframes=${b.dFrames} / ${(b.dtMs / 1000).toFixed(1)}s，fpsCap=${b.fpsCaps.join('/')}，期望区间 ${MIN_BLUR_FPS}~${MAX_BLUR_FPS}）`,
        b,
      );
      await cdp.eval(EXPR.focus); // 恢复聚焦再进隐藏组

      // ---- C 页面隐藏暂停：HIDDEN_WINDOWS 组，每组独立断言 Δframes === 0
      await cdp.eval(EXPR.hide);
      let cOk = true;
      const cDetails = [];
      for (let i = 0; i < HIDDEN_WINDOWS; i++) {
        const c = await sampleWindow(cdp, WINDOW_MS);
        const grew = c.dFrames !== 0;
        cOk = cOk && !grew;
        cDetails.push(`#${i + 1} Δframes=${c.dFrames}(${(c.dtMs / 1000).toFixed(0)}s)`);
        record(`C${i + 1} 隐藏暂停`, !grew, grew ? `隐藏期帧数仍在增长（+${c.dFrames}）` : `${(c.dtMs / 1000).toFixed(0)}s 帧数零增长`);
      }
      // ---- D 恢复可见：帧数恢复增长 + 帧间隔无大突跳
      await cdp.eval(EXPR.show);
      await cdp.eval(EXPR.focus);
      await sleep(1000);
      const d = await sampleWindow(cdp, RESTORE_MS);
      const gaps = (await cdp.eval(EXPR.gaps, { awaitPromise: true })).filter((g) => g > 0).sort((x, y) => x - y);
      const p99 = percentile(gaps, 99);
      const max = gaps.length ? gaps[gaps.length - 1] : 0;
      const dOk = d.dFrames > 0 && p99 <= P99_MAX_MS && max <= P99_MAX_MS * 2.5;
      record(
        'D 恢复无突跳',
        dOk,
        `Δframes=${d.dFrames}/${(d.dtMs / 1000).toFixed(1)}s · 帧间隔 P99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms（n=${gaps.length}，上限 P99≤${P99_MAX_MS}）` +
          (cOk ? '' : '（注意：隐藏组有失败，恢复叙事不完整）'),
        { p99, max, samples: gaps.length },
      );
    } else {
      // ---- HTTP 模式：只跑 A
      const s1 = await httpGetState();
      const info1 = (s1 && s1.info) || {};
      if (!info1.frames) throw new Error('get_state 未返回 info.frames（渲染器未就绪或页面是旧 bundle）');
      const t0 = Date.now();
      await sleep(WINDOW_MS);
      const s2 = await httpGetState();
      const info2 = (s2 && s2.info) || {};
      const dFrames = Number(info2.frames) - Number(info1.frames);
      const dUtime = Number(info2.utime) - Number(info1.utime);
      const dtMs = Date.now() - t0;
      const fps = dUtime > 0 ? dFrames / dUtime : (dFrames / dtMs) * 1000;
      record(
        'A 前台待机60',
        dFrames > 0 && fps >= MIN_IDLE_FPS,
        `${fps.toFixed(1)} fps（Δframes=${dFrames} / ${dUtime > 0 ? dUtime.toFixed(2) + 's utime' : (dtMs / 1000).toFixed(1) + 's 墙钟'}，阈值 ≥${MIN_IDLE_FPS}）` +
          (fps < MIN_IDLE_FPS && fps >= MIN_BLUR_FPS ? '；实测落在 30fps 档 → 真机窗口正失焦，置前后重跑' : ''),
        { dFrames, dtMs, fps },
      );
      for (const [name, why] of [
        ['B 失焦降载30', '真机无 eval 通道，需 CDP 模式（--cdp）'],
        ['C 隐藏暂停', '真机无 eval 通道，需 CDP 模式（--cdp）'],
        ['D 恢复无突跳', '真机无 eval 通道，需 CDP 模式（--cdp）'],
      ]) {
        record(name, 'skip', why);
      }
    }
  } finally {
    if (cdp) cdp.close();
  }

  const failed = results.filter((r) => r.verdict === false).length;
  const skipped = results.filter((r) => r.verdict === 'skip').length;
  const summary = {
    tool: 'perf-idle',
    verdict: failed ? 'FAIL' : 'PASS',
    origin: ORIGIN,
    mode: cdp ? 'cdp' : 'http',
    startedAt,
    windowMs: WINDOW_MS,
    hiddenWindows: HIDDEN_WINDOWS,
    groups: results.map((r) => ({ name: r.name, verdict: r.verdict === true ? 'PASS' : r.verdict === 'skip' ? 'SKIP' : 'FAIL', detail: r.detail })),
    failed,
    skipped,
  };
  if (skipped) summary.verdict = summary.verdict === 'FAIL' ? 'FAIL' : 'PASS-PARTIAL';
  console.log('\n[perf-idle] ' + JSON.stringify(summary));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('[perf-idle] 异常：', e && e.message ? e.message : e);
  process.exit(2);
});
