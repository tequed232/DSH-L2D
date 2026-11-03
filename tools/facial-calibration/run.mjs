#!/usr/bin/env node
/**
 * 五官参数标定采集器（零依赖 + 本机 Edge headless）。
 *
 * 目标：对单个五官参数做「扫描值 → 截图」采集，供人工（read_image）判语义。
 * 不依赖正在运行的 DSH 页面，也不写生产代码/模型文件；模型、Core、renderer.js
 * 全部以只读方式从仓库读取。
 *
 * 用法：
 *   node run.mjs --caps                 # 只导出 getCapabilities（参数 min/max/def）
 *   node run.mjs --one ParamEyeLOpen=0.5
 *   node run.mjs --spec spec.json       # 批量跑 spec 里的 jobs
 *   node run.mjs --spec spec.json --w 720 --h 1120 --zoom 1
 *
 * 采集原理：
 *   - 本地起静态服务器，提供 /cal.html、/core.js、/renderer.js、/model/*
 *   - Edge headless 只启动一次，用 CDP（Page.captureScreenshot）逐例截图
 *   - 页面每帧重放目标参数（sticky set 语义），保证截图时不被物理/表情/眨眼覆盖
 *   - 页内固定 neutral baseline（眼/眉/嘴/脸颊/特效归零 + 头部归零），单参数对照
 *
 * 产物：<out>/capabilities.json、<out>/<name>.png、<out>/<name>-face.png、<out>/results.json
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.DSH_L2D_ROOT || path.join(HERE, '..', '..'));
// 模型/Core 不入库：worktree 里没有时回落到共享 checkout（只读）。
const SHARED = 'D:/Desktop/DSH-L2D';
const pickDir = (...cands) => cands.filter(Boolean).find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
const pickFile = (...cands) => cands.filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const MODEL_DIR = pickDir(process.env.DSH_L2D_MODEL_DIR, path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek'), path.join(SHARED, 'DeepSeek免费公皮', 'DeepSeek'));
if (!MODEL_DIR) throw new Error('找不到模型目录，请设置 DSH_L2D_MODEL_DIR');
const CORE_FILE = pickFile(
  process.env.DSH_L2D_CORE,
  path.join(ROOT, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Core', 'live2dcubismcore.min.js'),
  path.join(SHARED, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Core', 'live2dcubismcore.min.js'),
);
if (!CORE_FILE) throw new Error('找不到 Cubism Core');
const RENDERER_FILE = pickFile(
  path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'renderer.js'),
  path.join(SHARED, 'packages', 'dsh-l2d-plugin', 'assets', 'renderer.js'),
);

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const MODE = args.includes('--caps') ? 'caps' : args.includes('--probe') ? 'probe' : args.includes('--one') ? 'one' : 'spec';
const OUT = path.resolve(argOf('--out', path.join(HERE, 'out')));
const W = Number(argOf('--w', 720));
const H = Number(argOf('--h', 1120));
const ZOOM = Number(argOf('--zoom', 1));
const DPR = Number(argOf('--dpr', 1));
const MODEL = argOf('--model', '大肥鱼.dsl2d.2048.model3.json');
const FACE_TOP = Number(argOf('--face-top', 0.3)); // 脸部裁剪：画布顶部比例
const WAIT_MS = Number(argOf('--wait', 1200)); // 表情交叉淡入默认 1s，600ms 会截断
const EDGE =
  process.env.EDGE_PATH ||
  [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p));

// 固定 baseline：把五官/特效/头部全部压到中立，保证单参数对照干净。
// 只包含确定性可写参数；物理输出（ShockR/L 等）写不进去会被注入器忽略。
const BASELINE = {
  // 头部/身体：避免 Idle 动作与呼吸带来的角度漂移影响对比
  AngleX: 0,
  AngleY: 0,
  AngleZ: 0,
  PositionX: 0,
  PositionY: 0,
  // 眼
  ParamEyeLOpen: 1,
  ParamEyeROpen: 1,
  LEyeSquint: 0,
  REyeSquint: 0,
  EyeSmile: 0,
  // 眉
  ParamBrowLY: 0,
  ParamBrowRY: 0,
  BrowInnerUp: 0,
  // 嘴
  JawOpen: 0,
  MouthSmile_L: 0,
  MouthSmile_R: 0,
  Mouthpucker: 0,
  MouthFunnel: 0,
  MouthX: 0,
  // 脸颊/特效
  CheeckPuff: 0,
  RCry: 0,
  LCry: 0,
  SweatBurst1: 0,
  SweatBurst2: 0,
  SweatBurst3: 0,
  SweatBurst4: 0,
  Startwinkle: 0,
  // 表情开关（眼睛族等）
  key3: 0,
  key4: 0,
  key5: 0,
  key6: 0,
};

// ---------------- 静态服务器 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
};
function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
function send(res, status, type, buf) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}
function resolveInside(baseDir, relRaw) {
  let rel;
  try {
    rel = decodeURIComponent(relRaw);
  } catch {
    return null;
  }
  const full = path.resolve(baseDir, rel);
  if (!full.startsWith(path.resolve(baseDir) + path.sep) && full !== path.resolve(baseDir)) return null;
  return full;
}
const server = http.createServer((req, res) => {
  const urlPath = String(req.url || '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/cal.html') {
    return send(res, 200, MIME['.html'], readIfExists(path.join(HERE, 'index.html')) || Buffer.from(''));
  }
  if (urlPath === '/core.js') {
    const buf = readIfExists(CORE_FILE);
    return buf ? send(res, 200, MIME['.js'], buf) : send(res, 404, 'text/plain', Buffer.from('core missing'));
  }
  if (urlPath === '/renderer.js') {
    const buf = readIfExists(RENDERER_FILE);
    return buf
      ? send(res, 200, MIME['.js'], buf)
      : send(res, 404, 'text/plain', Buffer.from('renderer.js missing (pnpm -F @dsh/renderer build)'));
  }
  if (urlPath.startsWith('/model/')) {
    const full = resolveInside(MODEL_DIR, urlPath.slice('/model/'.length));
    if (!full) return send(res, 400, 'text/plain', Buffer.from('bad path'));
    const buf = readIfExists(full);
    if (!buf) return send(res, 404, 'text/plain', Buffer.from('not found'));
    return send(res, 200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', buf);
  }
  return send(res, 404, 'text/plain', Buffer.from('not found'));
});

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
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
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFile(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const buf = readIfExists(p);
    if (buf && buf.length) return buf;
    await sleep(100);
  }
  return null;
}

async function launchEdge(profileDir) {
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=' + W + ',' + H,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const buf = await waitFile(portFile, 25000);
  if (!buf) throw new Error('Edge 未写出 DevToolsActivePort（headless 启动失败）');
  const port = Number(String(buf).split('\n')[0].trim());
  if (!port) throw new Error('DevToolsActivePort 内容异常: ' + String(buf));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await res.json();
      return { child, wsUrl: j.webSocketDebuggerUrl };
    } catch {
      await sleep(120);
    }
  }
  throw new Error('DevTools /json/version 不可达');
}

// ---------------- 截图裁剪（可选 sharp） ----------------
let sharp = null;
for (const base of [path.join(ROOT, 'package.json'), path.join(SHARED, 'package.json'), import.meta.url]) {
  try {
    sharp = createRequire(base)('sharp');
    break;
  } catch {
    /* 试下一个位置 */
  }
}
async function cropFace(pngPath, facePath) {
  if (!sharp) return false;
  const top = Math.max(1, Math.round(H * FACE_TOP));
  try {
    await sharp(pngPath)
      .extract({ left: 0, top: 0, width: W, height: top })
      .resize({ width: Math.min(W * 2, 1800) })
      .png()
      .toFile(facePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------- 主流程 ----------------
async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome，可用 EDGE_PATH 指定');
  fs.mkdirSync(OUT, { recursive: true });
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-cal-edge-'));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/cal.html?w=${W}&h=${H}&zoom=${ZOOM}&dpr=${DPR}&model=${encodeURIComponent(MODEL)}`;
  console.log(`[cal] page: ${pageUrl}`);
  console.log(`[cal] out : ${OUT}`);

  const { child, wsUrl } = await launchEdge(tmpProfile);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(ws);

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => cdp.send(method, params, sessionId);
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await S('Page.navigate', { url: pageUrl });

    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 35000) {
      const r = await S('Runtime.evaluate', {
        expression: '!!(window.__calReady || window.__calError)',
        returnByValue: true,
      });
      if (r.result && r.result.value === true) {
        ready = true;
        break;
      }
      await sleep(200);
    }
    if (!ready) throw new Error('页面 35s 内未就绪（模型加载失败？看 --dump 日志）');
    const errCheck = await S('Runtime.evaluate', {
      expression: 'window.__calError || null',
      returnByValue: true,
    });
    if (errCheck.result && errCheck.result.value) throw new Error('页面报错: ' + errCheck.result.value);

    const evalJson = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result ? r.result.value : null;
    };

    if (MODE === 'caps') {
      const cap = await evalJson('JSON.stringify(window.__calCaps())');
      const capPath = path.join(OUT, 'capabilities.json');
      fs.writeFileSync(capPath, cap, 'utf8');
      console.log('[cal] capabilities ->', capPath);
      await shutdown(cdp, child, ws, tmpProfile);
      return;
    }

    // 用例清单
    const jobs = [];
    if (MODE === 'probe') {
      // probe 模式不需要 jobs；下面单独走采样分支
    } else if (MODE === 'one') {
      const raw = args[args.indexOf('--one') + 1] || '';
      const [id, v] = raw.split('=');
      if (!id) throw new Error('--one 需要 "Param=0.5"');
      jobs.push({ name: id + '_' + v, params: { [id.trim()]: Number(v) } });
    } else {
      const specPath = path.resolve(argOf('--spec', ''));
      if (!specPath || !fs.existsSync(specPath)) throw new Error('--spec 文件不存在: ' + specPath);
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      for (const job of spec.jobs) jobs.push(job);
    }
    console.log(`[cal] jobs: ${jobs.length}`);

    // --probe：表情/参数生效时序诊断（不改页面，只打印采样）
    if (args.includes('--probe')) {
      const name = args[args.indexOf('--probe') + 1] || null;
      await evalJson(`window.__calExpr(${JSON.stringify(name)}); 'ok'`);
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        const sample = await evalJson("JSON.stringify({key4: window.__calPv(['key4']).key4, key9: window.__calPv(['key9']).key9, frames: window.__calInfo().frames, expr: window.__calInfo().expr})");
        console.log('[probe]', i, sample);
      }
      await shutdown(cdp, child, ws, tmpProfile);
      return;
    }

    const results = [];
    for (const job of jobs) {
      const params = job.params || {};
      const freeze = Object.assign({}, BASELINE, job.freeze || {});
      // baseline 中与目标参数同名的键由目标值覆盖（避免目标被 baseline 压回中立）
      for (const k of Object.keys(params)) delete freeze[k];
      // 表情用例不能清 key*：表情正是通过 key1/2/3/4/5/6/7/8/9/13 叠加的
      if (job.expr) for (const k of Object.keys(freeze)) if (/^keyd+$/.test(k)) delete freeze[k];
      const spec = { freeze, params };
      // 表情通道对照：jobs 可带 expr（null/缺省 = 清表情）
      const exprOk = await evalJson(`String(window.__calExpr(${JSON.stringify(job.expr || null)}))`);
      await evalJson(`window.__calSet(${JSON.stringify(spec)}); 'ok'`);
      // 单例可覆盖等待：表情淡入约 1s 且 headless 帧率偏低，表情类用例给更长等待
      await sleep(Number.isFinite(job.waitMs) ? job.waitMs : WAIT_MS);

      // 物理输出读数（只读）：用来判定「参数没生效」是模型绑定问题还是物理没跑起来
      const ids = Object.keys(params).concat(['ParamEyeLOpen', 'ParamEyeROpen', 'LEyeSquint', 'REyeSquint', 'EyeSmile', 'ParamBrowLY', 'ParamBrowRY', 'BrowInnerUp', 'JawOpen', 'MouthSmile_L', 'MouthSmile_R', 'Mouthpucker', 'CheeckPuff', 'key2', 'key3', 'key4', 'key5', 'key6', 'key7', 'key8', 'key9', 'key13', 'Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5', 'AngleX', 'AngleY', 'AngleZ', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLY2', 'LipPhysics1', 'ParamAngleX', 'ParamBreath']);
      const pvRaw = await evalJson(`JSON.stringify(window.__calPv(${JSON.stringify(ids)}))`);
      const pv = pvRaw ? JSON.parse(pvRaw) : {};
      const infoFields = await evalJson('window.__calInfo() ? ({frames: window.__calInfo().frames, phase: window.__calInfo().phase}) : null');
      const shot = await S('Page.captureScreenshot', { format: 'png' });
      // 允许中文名（标定用例用模型表情名），只替换文件系统非法字符
      const name = String(job.name || 'shot').replace(/[\\/:*?"<>|\s]+/g, '_');
      const fullPath = path.join(OUT, name + '.png');
      fs.writeFileSync(fullPath, Buffer.from(shot.data, 'base64'));
      const facePath = path.join(OUT, name + '-face.png');
      const cropped = await cropFace(fullPath, facePath);
      results.push({ name, params, freeze, expr: job.expr || null, exprOk, frames: infoFields && infoFields.frames, pv, shot: fullPath, face: cropped ? facePath : null });
      console.log(`[cal] ${name}  pv=${JSON.stringify(pv)}`);
    }

    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, w: W, h: H, results }, null, 1), 'utf8');
    await shutdown(cdp, child, ws, tmpProfile);
    console.log(`[cal] done: ${results.length} shots -> ${OUT}`);
  } catch (err) {
    await shutdown(cdp, child, ws, tmpProfile);
    throw err;
  }
}

async function shutdown(cdp, child, ws, profileDir) {
  try {
    cdp.close();
  } catch {
    /* ignore */
  }
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  await sleep(300);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error('[cal] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
