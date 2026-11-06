/**
 * 真实子进程故障注入（不是 throw 模拟）：
 * - spawnWorker：spawn node 子进程（继承 --experimental-sqlite / strip-types 旗标）
 * - waitForMarker：轮询标记文件（子进程写到一半的证据）
 * - sigkill：父进程向子进程发真实 SIGKILL（非 throw / 非 graceful exit）
 * - waitExit：等待退出并返回 {code, signal}，signal==='SIGKILL' 即为被杀证据
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export function spawnWorker(workerPath, args = []) {
  const child = spawn(process.execPath, [...process.execArgv, workerPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { child._stderrTail = String(child._stderrTail || '') + d; });
  return child;
}

export function waitForMarker(markerPath, timeoutMs = 10000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      if (fs.existsSync(markerPath)) return res();
      if (Date.now() - t0 > timeoutMs) return rej(new Error(`waitForMarker 超时: ${markerPath}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export function sigkill(child) {
  child.kill('SIGKILL');
}

export function waitExit(child) {
  return new Promise((res) => {
    child.on('exit', (code, signal) => res({ code, signal, stderr: String(child._stderrTail || '') }));
  });
}

export function writeMarker(markerPath, payload = '') {
  fs.writeFileSync(markerPath, payload || String(process.pid));
}
