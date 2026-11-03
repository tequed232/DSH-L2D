/**
 * dsh-l2d · 前台应用采集器（W1 可选能力，默认关）
 *
 * 只回答一个问题：**当前前台窗口属于哪个进程**（如 `Code.exe`）。
 * 明确不做（用户红线）：
 *   - 不读窗口标题（标题常含文档名/URL/聊天对象，属敏感信息）；
 *   - 不读完整路径（对外只给 basename）、不记历史、不截屏、不记键；
 *   - 不做"前台是 Code.exe 所以用户在写代码"的推断（见 context-analyzer）。
 *
 * 实现：DSH 插件宿主是 Electron 的 Node 子进程（ELECTRON_RUN_AS_NODE），拿不到
 * Electron API；这里用 Win32 FFI（user32!GetForegroundWindow + kernel32 进程查询），
 * 依赖是 profile 里已随 DSH 提供的 koffi（找不到就降级 unavailable，不影响其他功能）。
 *
 * 开关语义：`enabled=false` 时 `get()` 直接返回 disabled，`setEnabled(false)` 立即
 * 停止轮询并清空最后一次采样；任何失败都只影响本采集器自身，不抛、不阻塞。
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FOREGROUND_DEFAULT_INTERVAL_MS = 2000;
export const FOREGROUND_STALE_MS = 8000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** 进程名只保留 basename（不含路径）。 */
export function basenameOfExecutable(value) {
  if (typeof value !== 'string' || !value) return '';
  return value.split(/[\\/]/).pop() || '';
}

/** 默认 koffi 加载：先按包名，再按 profile 里已知的绝对路径（插件不在 profile 内）。 */
export async function defaultLoadKoffi(options = {}) {
  try {
    return await import('koffi');
  } catch {
    /* 继续尝试绝对路径 */
  }
  const home = options.homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    process.env.DSH_L2D_KOFFI_PATH,
    path.join(home, 'profiles', 'node_modules', 'koffi', 'index.cjs'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', 'koffi', 'index.cjs'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return await import(pathToFileURL(file).href);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('koffi-not-found');
}

/** 从 koffi 模块建立 Win32 绑定（只绑需要的 5 个函数）。 */
export function createWin32Bindings(koffiModule) {
  const koffi = koffiModule && koffiModule.default ? koffiModule.default : koffiModule;
  if (!koffi || typeof koffi.load !== 'function') throw new Error('koffi-invalid');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    getForegroundWindow: user32.func('void *GetForegroundWindow()'),
    getWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'),
    openProcess: kernel32.func('void *OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'),
    queryFullProcessImageNameW: kernel32.func(
      'bool QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)',
    ),
    closeHandle: kernel32.func('bool CloseHandle(void *hObject)'),
  };
}

/** 读一次前台进程名（只取 basename）。返回 {ok:true,name,at} 或 {ok:false,reason}。 */
export function readForegroundProcess(bindings, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  try {
    const hwnd = bindings.getForegroundWindow();
    if (!hwnd) return { ok: false, reason: 'no-foreground-window' };
    const pidOut = [0];
    bindings.getWindowThreadProcessId(hwnd, pidOut);
    const pid = Number(pidOut[0]) || 0;
    if (!pid) return { ok: false, reason: 'no-process-id' };
    const handle = bindings.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!handle) return { ok: false, reason: 'process-open-denied' };
    try {
      const buffer = Buffer.alloc(2048);
      const sizeOut = [1024];
      if (!bindings.queryFullProcessImageNameW(handle, 0, buffer, sizeOut)) {
        return { ok: false, reason: 'process-name-unavailable' };
      }
      const text = buffer.toString('utf16le').replace(/\0[\s\S]*$/, '');
      const name = basenameOfExecutable(text);
      if (!name) return { ok: false, reason: 'process-name-empty' };
      return { ok: true, name, at: now };
    } finally {
      try {
        bindings.closeHandle(handle);
      } catch {
        /* 句柄已失效不影响结果 */
      }
    }
  } catch (err) {
    return { ok: false, reason: 'query-failed', detail: String((err && err.message) || err).slice(0, 120) };
  }
}

/**
 * 采集器。默认关闭；`setEnabled(true)` 才开始轮询。
 *
 * @param {{
 *   enabled?: boolean,
 *   intervalMs?: number,
 *   staleMs?: number,
 *   now?: () => number,
 *   bindingLoader?: () => Promise<object>,
 *   homeDir?: string,
 * }} [options]
 */
export function createForegroundProcessCollector(options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs) || FOREGROUND_DEFAULT_INTERVAL_MS);
  // 显式 staleMs 优先（测试/调用方自定）；否则给轮询间隔留 2 拍余量。
  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : Math.max(intervalMs * 2, FOREGROUND_STALE_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const bindingLoader =
    typeof options.bindingLoader === 'function'
      ? options.bindingLoader
      : async () => createWin32Bindings(await defaultLoadKoffi({ homeDir: options.homeDir }));

  let enabled = options.enabled === true;
  let timer = null;
  let bindings = null;
  let available = null; // null=未探测, true/false
  let reason = null;
  let last = null;
  let polling = false;
  let loading = null;

  async function ensureBindings() {
    if (bindings) return bindings;
    if (!loading) {
      loading = (async () => {
        try {
          bindings = await bindingLoader();
          available = true;
          reason = null;
          return bindings;
        } catch (err) {
          available = false;
          reason = err && err.message === 'koffi-not-found' ? 'koffi-not-found' : 'bindings-unavailable';
          return null;
        } finally {
          loading = null;
        }
      })();
    }
    return loading;
  }

  function pollOnce() {
    if (!bindings) return;
    const sample = readForegroundProcess(bindings, { now: now() });
    if (sample.ok) last = { name: sample.name, at: sample.at };
  }

  async function start() {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (timer) return { ok: true, alreadyRunning: true };
    const loaded = await ensureBindings();
    if (!loaded) return { ok: false, reason };
    if (!enabled) return { ok: false, reason: 'disabled' }; // setup 期间被关掉
    if (timer) return { ok: true, alreadyRunning: true };
    pollOnce();
    timer = setInterval(pollOnce, intervalMs);
    timer.unref?.();
    polling = true;
    return { ok: true };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    polling = false;
    last = null; // 不留历史
    return { ok: true };
  }

  function setEnabled(next) {
    const value = next === true;
    if (value === enabled) {
      if (!value) stop();
      return { ok: true, enabled };
    }
    enabled = value;
    if (!value) {
      // 关闭后立即停止采集并清掉最后一次采样。
      stop();
      return { ok: true, enabled: false };
    }
    void start().catch(() => {});
    return { ok: true, enabled: true };
  }

  function get() {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (available === false) return { ok: false, reason };
    if (!last) return { ok: false, reason: available === null ? 'not-started' : 'no-sample' };
    if (now() - last.at > staleMs) return { ok: false, reason: 'stale' };
    return { ok: true, name: last.name, at: last.at };
  }

  function status() {
    return {
      enabled,
      available,
      reason,
      polling,
      intervalMs,
      staleMs,
      lastAt: last ? last.at : null,
    };
  }

  return { start, stop, setEnabled, get, status };
}
