import assert from 'node:assert/strict';
import {
  FOREGROUND_DEFAULT_INTERVAL_MS,
  basenameOfExecutable,
  createForegroundProcessCollector,
  readForegroundProcess,
} from './foreground-process.mjs';

// 1) 进程名只留 basename（路径/大小写都不进快照）。
assert.equal(basenameOfExecutable('C:\\Program Files\\Microsoft VS Code\\Code.exe'), 'Code.exe');
assert.equal(basenameOfExecutable('/usr/bin/node'), 'node');
assert.equal(basenameOfExecutable(''), '');
assert.equal(basenameOfExecutable(null), '');

// 2) 假 Win32 绑定：只实现我们允许绑定的 5 个函数（测试同时证明没碰标题 API）。
function fakeBindings(overrides = {}) {
  const opts = {
    hwnd: 100,
    pid: 4242,
    exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    open: true,
    queryOk: true,
    ...overrides,
  };
  return {
    getForegroundWindow: () => opts.hwnd,
    getWindowThreadProcessId: (_hwnd, out) => {
      out[0] = opts.pid;
      return 1;
    },
    openProcess: () => (opts.open ? { handle: true } : null),
    queryFullProcessImageNameW: (_handle, _flags, buffer, sizeOut) => {
      if (!opts.queryOk) return false;
      const bytes = Buffer.from(opts.exe + '\0', 'utf16le');
      bytes.copy(buffer);
      sizeOut[0] = bytes.length / 2;
      return true;
    },
    closeHandle: () => true,
  };
}

// 3) 直接读一次：成功 / 无前景窗 / OpenProcess 被拒 / 查询失败。
const readOk = readForegroundProcess(fakeBindings(), { now: 1000 });
assert.deepEqual(readOk, { ok: true, name: 'Code.exe', at: 1000 });
assert.equal(readForegroundProcess(fakeBindings({ hwnd: 0 }), { now: 1 }).reason, 'no-foreground-window');
assert.equal(readForegroundProcess(fakeBindings({ open: false }), { now: 1 }).reason, 'process-open-denied');
assert.equal(readForegroundProcess(fakeBindings({ queryOk: false }), { now: 1 }).reason, 'process-name-unavailable');
assert.equal(readForegroundProcess(fakeBindings({ pid: 0 }), { now: 1 }).reason, 'no-process-id');

// 4) 默认关闭：不探测、不轮询、get() 明确 disabled。
const disabled = createForegroundProcessCollector({ bindingLoader: async () => fakeBindings() });
assert.deepEqual(disabled.get(), { ok: false, reason: 'disabled' });
assert.equal(disabled.status().enabled, false);
assert.equal(disabled.status().polling, false);
assert.deepEqual(await disabled.start(), { ok: false, reason: 'disabled' });

// 5) 打开后采到进程名；只给 basename。
let clock = 1000;
const collector = createForegroundProcessCollector({
  enabled: false,
  intervalMs: 60000, // 测试里不让定时器真正触发
  staleMs: 5000,
  now: () => clock,
  bindingLoader: async () => fakeBindings(),
});
collector.setEnabled(true);
await collector.start();
assert.deepEqual(collector.get(), { ok: true, name: 'Code.exe', at: 1000 });
assert.equal(collector.status().enabled, true);
assert.equal(collector.status().polling, true);
assert.equal(collector.status().available, true);

// 6) 超过 staleMs 视为过期（不返回旧值）。
clock += 6000;
assert.deepEqual(collector.get(), { ok: false, reason: 'stale' });

// 7) 关闭后立即停止并清空最后一次采样（不存历史）。
assert.deepEqual(collector.setEnabled(false), { ok: true, enabled: false });
assert.deepEqual(collector.get(), { ok: false, reason: 'disabled' });
assert.equal(collector.status().polling, false);
assert.equal(collector.status().lastAt, null);
// 重复关闭幂等
assert.deepEqual(collector.setEnabled(false), { ok: true, enabled: false });

// 8) 绑定加载失败：不抛、不阻塞，get/status 标不可用。
let loadAttempts = 0;
const broken = createForegroundProcessCollector({
  intervalMs: 60000,
  now: () => clock,
  bindingLoader: async () => {
    loadAttempts++;
    throw new Error('koffi-not-found');
  },
});
broken.setEnabled(true);
const startResult = await broken.start();
assert.equal(startResult.ok, false);
assert.equal(startResult.reason, 'koffi-not-found');
assert.deepEqual(broken.get(), { ok: false, reason: 'koffi-not-found' });
assert.equal(broken.status().available, false);
assert.equal(broken.status().polling, false);
assert.equal(loadAttempts, 1);

// 9) 采集器自身查询异常：只影响本采集器（返回 unavailable，不抛）。
const noWindow = createForegroundProcessCollector({
  intervalMs: 60000,
  now: () => clock,
  bindingLoader: async () => fakeBindings({ hwnd: 0 }),
});
noWindow.setEnabled(true);
await noWindow.start();
assert.equal(noWindow.get().ok, false);
assert.equal(noWindow.get().reason, 'no-sample');
assert.equal(noWindow.status().polling, true);
noWindow.setEnabled(false);

// 10) 默认间隔常量（文档/设置说明引用）。
assert.equal(FOREGROUND_DEFAULT_INTERVAL_MS, 2000);

console.log('foreground-process ok');
