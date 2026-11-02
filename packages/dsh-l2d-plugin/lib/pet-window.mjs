/**
 * dsh-l2d 桌宠独立窗（Electron 主进程自举）
 *
 * 前提（proposals/pet-window-feasibility.md §1.4）：插件宿主进程 = Electron 主进程。
 * 本模块仅在 settings.petWindow === 'only' 时工作，流程：
 *   1. 探针 import('electron')，必须验 typeof BrowserWindow === 'function'
 *      （RUN_AS_NODE 的 Node 模式下 import('electron') 可能返回字符串路径，只看是否抛错不够）；
 *   2. 建透明、无框、置顶、不抢焦点的 pet 窗，加载同源 /dsh-l2d/pet.html；
 *   3. 主进程 16ms 轮询光标 → IPC 送页面；页面 postrender 读 alpha 命中 → IPC 回主进程；
 *      迟滞切换 setIgnoreMouseEvents（不用 forward:true，Electron 33 实测不转发）；
 *   4. 拖动由主进程完成（页面只报 start/end，主进程按光标增量 setPosition）；
 *   5. Win32「不画」救法：hide→showInactive→setAlwaysOnTop('screen-saver')，前 30s 保活。
 * 任何一步失败：diag 记录并放弃建窗（页内浮层模式照常，不抛错不拖垮宿主）。
 */
const POLL_MS = 16;
const KEEPALIVE_MS = 2500;
const KEEPALIVE_ROUNDS = 12; // 30s 内保活，之后停
const HIT_ON_TICKS = 2; // 连续 2 帧命中才恢复交互
const HIT_OFF_TICKS = 3; // 连续 3 帧未命中才回到穿透
const PET_W = 360;
const PET_H = 460;
const MARGIN = 24;

/**
 * @param {object} options
 * @param {object} options.settings        readSettings() 快照（只看 petWindow）
 * @param {string} options.preloadPath     pet-preload.cjs 的绝对路径
 * @param {() => (string|null)} options.getOrigin  webServer origin，如 http://127.0.0.1:14110
 * @param {(msg: string) => void} [options.diag]
 * @returns {Promise<Function|null>} 成功返回同步 dispose；未启用/探针失败返回 null
 */
export async function setupPetWindow(options = {}) {
  const mode = options.settings && options.settings.petWindow === 'only' ? 'only' : 'off';
  if (mode !== 'only') return null;

  const diag = options.diag || (() => {});
  const getOrigin = options.getOrigin || (() => null);
  const preloadPath = String(options.preloadPath || '');

  // ① 探针：必须拿到真 API 对象，字符串（RUN_AS_NODE）视为失败
  let electron = null;
  try {
    const m = await import('electron');
    if (m && typeof m === 'object' && typeof m.BrowserWindow === 'function') electron = m;
  } catch {
    /* 无 electron */
  }
  if (!electron) {
    diag('pet 窗: electron 探针失败（宿主不在 Electron 主进程），降级为页内浮层');
    return null;
  }

  const { BrowserWindow, screen, ipcMain } = electron;
  const CH_CURSOR = 'l2d-pet:cursor';
  const CH_HIT = 'l2d-pet:hit';
  const CH_DRAG = 'l2d-pet:drag';

  let disposed = false;
  const disposers = [];
  let petWin = null;
  let pollTimer = null;
  let keepaliveTimer = null;
  let keepaliveRounds = 0;
  let dragging = false;
  let grab = { dx: 0, dy: 0 };
  let interactive = false;
  let hitTicks = 0;
  let missTicks = 0;

  function applyIgnore(nextInteractive) {
    if (interactive === nextInteractive) return;
    interactive = nextInteractive;
    try {
      if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!interactive, { forward: false });
    } catch {
      /* ignore */
    }
  }

  const onHit = (_e, hit) => {
    if (disposed) return;
    if (hit === true) {
      hitTicks++;
      missTicks = 0;
      if (hitTicks >= HIT_ON_TICKS) applyIgnore(true);
    } else {
      missTicks++;
      hitTicks = 0;
      if (missTicks >= HIT_OFF_TICKS) applyIgnore(false);
    }
  };

  const onDrag = (_e, body) => {
    if (disposed || !body) return;
    if (body.phase === 'start') {
      dragging = true;
      try {
        const p = screen.getCursorScreenPoint();
        const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
        if (b) grab = { dx: b.x - p.x, dy: b.y - p.y };
      } catch {
        grab = { dx: 0, dy: 0 };
      }
    } else if (body.phase === 'end') {
      dragging = false;
    }
  };

  try {
    ipcMain.on(CH_HIT, onHit);
    ipcMain.on(CH_DRAG, onDrag);
  } catch (err) {
    diag('pet 窗: IPC 注册失败 ' + String(err && err.message));
    return null;
  }
  disposers.push(() => {
    try {
      ipcMain.removeListener(CH_HIT, onHit);
    } catch {
      /* ignore */
    }
    try {
      ipcMain.removeListener(CH_DRAG, onDrag);
    } catch {
      /* ignore */
    }
  });

  function tick() {
    if (disposed) return;
    const win = petWin;
    if (!win || win.isDestroyed()) return;
    let p = null;
    try {
      p = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    let b = null;
    try {
      b = win.getContentBounds();
    } catch {
      return;
    }
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (dragging) {
      try {
        win.setPosition(p.x + grab.dx, p.y + grab.dy);
      } catch {
        /* ignore */
      }
    }
    try {
      win.webContents.send(CH_CURSOR, inside ? { x: Math.round(p.x - b.x), y: Math.round(p.y - b.y) } : null);
    } catch {
      /* ignore */
    }
    if (!inside && !dragging) {
      // 光标在窗外：保持全穿透（页面此时收不到任何鼠标事件，命中判定交给主进程）
      hitTicks = 0;
      missTicks = 0;
      applyIgnore(false);
    }
  }

  // ② 建窗
  try {
    if (electron.app && typeof electron.app.whenReady === 'function') await electron.app.whenReady();
    if (disposed) return () => {};
    const origin = String(getOrigin() || '');
    if (!origin) throw new Error('webServer origin 不可用');
    const wa = screen.getPrimaryDisplay().workArea;
    petWin = new BrowserWindow({
      width: PET_W,
      height: PET_H,
      x: wa.x + wa.width - PET_W - MARGIN,
      y: wa.y + wa.height - PET_H - MARGIN,
      transparent: true,
      frame: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, // focusable:false 窗不节流 rAF，动画不停
        preload: preloadPath,
      },
    });
    petWin.setAlwaysOnTop(true, 'screen-saver');
    petWin.setIgnoreMouseEvents(true, { forward: false }); // 初始全穿透
    petWin.once('ready-to-show', () => {
      if (disposed || !petWin || petWin.isDestroyed()) return;
      petWin.showInactive();
      keepaliveTimer = setInterval(() => {
        keepaliveRounds++;
        if (disposed || keepaliveRounds > KEEPALIVE_ROUNDS || !petWin || petWin.isDestroyed()) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
          return;
        }
        // Win32「Win32 里可见、屏幕不画」救法（踩坑补充①尾）
        try {
          petWin.hide();
          petWin.showInactive();
          petWin.setAlwaysOnTop(true, 'screen-saver');
        } catch {
          /* ignore */
        }
      }, KEEPALIVE_MS);
      if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
      disposers.push(() => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      });
    });
    petWin.webContents.on('render-process-gone', (_e, details) => {
      let brief = '';
      try {
        brief = JSON.stringify(details || {}).slice(0, 200);
      } catch {
        brief = 'unknown';
      }
      diag('pet 窗: 渲染进程退出 ' + brief);
    });
    await petWin.loadURL(origin.replace(/\/+$/, '') + '/dsh-l2d/pet.html');
    pollTimer = setInterval(tick, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    diag('pet 窗: 已创建 ' + PET_W + 'x' + PET_H + ' @ ' + origin + '/dsh-l2d/pet.html');
  } catch (err) {
    diag('pet 窗: 建窗失败 ' + String(err && err.message ? err.message : err));
    try {
      if (petWin && !petWin.isDestroyed()) petWin.destroy();
    } catch {
      /* ignore */
    }
    petWin = null;
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    try {
      if (petWin && !petWin.isDestroyed()) petWin.destroy();
    } catch {
      /* ignore */
    }
    petWin = null;
  };
}
