/**
 * Runtime Probe 宿主：真实 Live2D 渲染证据的唯一来源。
 *
 * 纪律（2026-11-05 通宵任务书红线）：
 *  - 不允许 Mock 参数变化冒充真实运行时探针；本模块所有观测都来自
 *    Playwright 驱动的真实 Edge/Chromium + @dsh/renderer（window.DSH_L2D）。
 *  - 参数写入走渲染器既有唯一写路径 DSH_L2D.setParameters（内部 ParamInjector/
 *    param-ownership 管辖），本模块不另建写路径。
 *  - 注入前必须经 packages/dsh-l2d-db safety-guard（Hard/Soft 双层边界）裁决。
 *
 * 用法见 run-probe.mjs。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

export const MODEL_2048 = '大肥鱼.dsl2d.2048.model3.json';

/** 启动 dev-server 子进程，等待端口可连。返回 { proc, port, baseUrl }。 */
export function startDevServer(port = 5319) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server', 'index.mjs'), '--port', String(port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => { out += d; };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => {
      reject(new Error('dev-server 启动超时: ' + out));
    }, 15000);
    const poll = async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/models`, { signal: AbortSignal.timeout(800) });
        clearTimeout(timer);
        resolve({ proc, port, baseUrl: `http://127.0.0.1:${port}` });
      } catch {
        if (proc.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error('dev-server 提前退出: ' + out));
          return;
        }
        setTimeout(poll, 300);
      }
    };
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    setTimeout(poll, 500);
  });
}

/** 拉起 Edge（headed），打开调试台，等待模型就绪。返回操作面。 */
export async function launchProbeHost({ baseUrl, width = 460, height = 620, headless = false, deviceScaleFactor = 1 } = {}) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    channel: 'msedge',               // 本机 Edge，免下载 Chromium
    headless,
    args: [
      '--window-size=1280,900',
      '--disable-session-crashed-bubble',
      // 本机虚拟显示合成器节流 rAF（实测 6/s）→ 禁 vsync/帧率限制后实测 58/s
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      // 防 rAF 节流：探针窗口可能被遮挡/失焦，禁用后台节流保证真实渲染循环满速
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.bringToFront();
  // 调试台自动优先加载 2048 降档模型；等待 DSH_L2D 就绪
  await page.waitForFunction(
    () => Boolean(window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()),
    null,
    { timeout: 45000, polling: 250 },
  );

  const ops = {
    /** 运行时自省：真实模型参数表（含 min/max） */
    caps: () => page.evaluate(() => window.DSH_L2D.getCapabilities()),
    /** 诊断：frames/glErr/lastError 等 */
    info: () => page.evaluate(() => window.DSH_L2D.getInfo()),
    /** 实时参数读（渲染器调试/校准入口） */
    read: (ids) => page.evaluate((ids2) => window.DSH_L2D.readParameters(ids2), ids),
    /** 唯一合法写路径；返回 ApplyReport { ok, failed } */
    set: (values) => page.evaluate((v) => window.DSH_L2D.setParameters(v), values),
    /** 物理输出参数的合法认领入口（时长内独占，到期自动释放） */
    own: (ids, durationMs = 6000) => page.evaluate(({ ids: i, d }) => window.DSH_L2D.ownParameters(i, d), { ids, d: durationMs }),
    release: (ids) => page.evaluate((i) => window.DSH_L2D.releaseParameters(i), ids),
    resetPose: () => page.evaluate(() => window.DSH_L2D.resetPose()),
    /** 连续 N 帧采样参数值（rAF 对齐），返回 [{t, v}] */
    sample: (ids, frames = 60) => page.evaluate(({ ids: ids2, frames: n }) => new Promise((resolve) => {
      const out = [];
      let i = 0;
      const t0 = performance.now();
      function step() {
        const vals = window.DSH_L2D.readParameters(ids2);
        out.push({ t: Math.round(performance.now() - t0), ...vals });
        i += 1;
        if (i >= n) { resolve(out); return; }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }), { ids, frames }),
    /** FPS 观测：1 秒窗口帧计数 */
    measureFps: () => page.evaluate(() => new Promise((resolve) => {
      const a = window.DSH_L2D.getInfo().frames;
      const t0 = performance.now();
      setTimeout(() => {
        const b = window.DSH_L2D.getInfo().frames;
        resolve({ fps: Math.round(((b - a) / (performance.now() - t0)) * 1000), framesDelta: b - a });
      }, 1000);
    })),
    screenshot: (file) => page.screenshot({ path: file, fullPage: false }),
    close: async () => { await context.close().catch(() => {}); await browser.close().catch(() => {}); },
    getConsoleErrors: () => [...consoleErrors],
  };
  return { browser, context, page, ops };
}

export function stopDevServer(dv) {
  if (dv?.proc && dv.proc.exitCode === null) dv.proc.kill();
}

/** 等待 TCP 可连的小工具（供外部复用） */
export function waitHttp(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error('waitHttp 超时 ' + url));
        else setTimeout(poll, 250);
      });
    };
    poll();
  });
}

export const ART_DIR = path.join(ROOT, 'data', 'runtime-probe');
export function ensureArtDir() {
  fs.mkdirSync(ART_DIR, { recursive: true });
  return ART_DIR;
}
