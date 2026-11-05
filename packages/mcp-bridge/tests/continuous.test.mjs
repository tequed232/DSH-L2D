/**
 * 连续性验收（PR-C）：真实 dev-server + ai-inbox 全链路（Node 侧），claimant 为受控假执行器。
 * 链路：ModelActionQueue(真实) → HttpActionExecutor(真实 HTTP) → dev-server /ai/call（真实）
 *       → ai-inbox（真实）→ 假 claimant 轮询 /ai/poll（模拟 overlay 浏览器侧）→ POST /ai/result 回执。
 * 100 次动作断言：无重叠（claimant 受理→end 期间互斥）、无重复执行（requestId 唯一）、
 * 每条完成态回执齐全。真实浏览器端到端（浏览器内 100 次）不在本 PR，留 runtime-probe。
 * 直跑：node --experimental-sqlite packages/mcp-bridge/tests/continuous.test.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpActionExecutor } from '../action-executor.mjs';
import { ModelActionQueue } from '../action-queue.mjs';
import * as actionsRepo from '../../dsh-l2d-db/src/bridge-actions-repo.mjs';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOTAL = 100;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- 启动真实 dev-server（独立进程） ----
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server', 'index.mjs'), '--port', String(port)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[dev-server] ${d}`));
server.on('exit', (code) => { if (code && code !== 0) console.error(`[dev-server] 异常退出 code=${code}`); });

let serverReady = false;
for (let i = 0; i < 100 && !serverReady; i++) {
  try { serverReady = (await fetchJson(`${baseUrl}/api/models`)).status === 200; } catch { /* 未就绪 */ }
  if (!serverReady) await sleep(100);
}
assert.ok(serverReady, 'dev-server 15s 内未就绪');
console.log(`  dev-server 就绪：${baseUrl}`);

// ---- 持久化（真实 sqlite 临时库） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-cont-'));
const db = openDb({ path: path.join(tmp, 'actions.sqlite') });
const repo = {
  findById: (id) => actionsRepo.findById(db, id),
  insertRequest: (req) => actionsRepo.insertRequest(db, req),
  markRunning: (id) => actionsRepo.markRunning(db, id),
  markTerminal: (id, state, o) => actionsRepo.markTerminal(db, id, state, o),
  markInterruptedAll: () => actionsRepo.markInterruptedAll(db),
};

// ---- 真实 HttpActionExecutor（真实 HTTP；轮询间隔收窄到 40ms 加速验收） ----
const executor = new HttpActionExecutor({ baseUrl, pollIntervalMs: 40 });

// ---- 受控假 claimant：模拟 overlay 浏览器侧（/ai/poll 消费 + /ai/result 回执） ----
const claimant = {
  active: 0, maxActive: 0, served: 0,
  inFlight: new Set(), // 受理→end 之间的 callId（互斥断言依据）
};
const claimantTimer = setInterval(async () => {
  let calls = [];
  try { calls = (await fetchJson(`${baseUrl}/ai/poll`)).body.calls || []; } catch { return; }
  for (const c of calls) {
    claimant.served++;
    const callId = c.id;
    if (claimant.inFlight.has(callId)) continue; // 防御：ai-inbox 队列异常重复
    claimant.inFlight.add(callId);
    claimant.active++;
    claimant.maxActive = Math.max(claimant.maxActive, claimant.active);
    // exec 同步受理回执（result 通道，模拟 acceptedAct）
    await fetchJson(`${baseUrl}/ai/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: callId, result: { ok: true, accepted: true, settled: false, outcome: 'pending', runId: callId } }),
    }).catch(() => {});
    // 模拟执行耗时后 end 回执（event 通道，模拟 armActEnd → finishAct）
    setTimeout(() => {
      claimant.active--;
      claimant.inFlight.delete(callId);
      fetchJson(`${baseUrl}/ai/result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: callId, event: { type: 'action-done', phase: 'end', callId, runId: callId, source: 'ai', steps: 1, ts: Date.now() } }),
      }).catch(() => {});
    }, 20 + Math.floor(Math.random() * 40));
  }
}, 10);

// ---- 100 次动作循环 ----
console.log(`  连续执行 ${TOTAL} 次动作…`);
const queue = new ModelActionQueue({ executor, repo });
const receipts = [];
const t0 = Date.now();
for (let i = 0; i < TOTAL; i++) {
  const requestId = `cont-${i}`;
  const receipt = await queue.enqueue({
    requestId, workspaceId: 'ws-cont', controlSessionId: 'sess-cont',
    action: 'wave.right', args: { chain: [{ kind: 'look', x: 0.2, y: 0.1 }] },
    priority: 50, timeoutMs: 15_000, createdAt: Date.now(), memoryRevision: i,
  });
  assert.ok(!receipt.error, `第 ${i} 条入队被拒：${JSON.stringify(receipt)}`);
  receipts.push(receipt);
}
const elapsed = Date.now() - t0;

clearInterval(claimantTimer);
await queue.dispose();
server.kill();

// ---- 断言 ----
let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.error(`  ✗ ${msg}`); }
};

check(receipts.length === TOTAL, `回执数 = ${TOTAL}（实际 ${receipts.length}）`);
check(receipts.every((r) => r.state === 'completed'), '每条回执均为 completed');
check(new Set(receipts.map((r) => r.requestId)).size === TOTAL, 'requestId 集合唯一（无重复执行）');
check(claimant.maxActive <= 1, `无重叠：claimant 受理→end 期间互斥（峰值并发 ${claimant.maxActive}）`);
check(claimant.served === TOTAL, `claimant 恰好服务 ${TOTAL} 次（实际 ${claimant.served}）`);
const rows = db.prepare("SELECT state, COUNT(*) AS n FROM bridge_actions GROUP BY state").all();
const completed = rows.find((r) => r.state === 'completed');
check(completed && completed.n === TOTAL, `repo 持久化 ${TOTAL} 条 completed（实际 ${completed ? completed.n : 0}）`);
check(rows.every((r) => r.state === 'completed'), '无残留非终态行');
const unfinished = actionsRepo.findUnfinished(db);
check(unfinished.length === 0, 'findUnfinished 为空（无泄漏）');
console.log(`  耗时 ${elapsed}ms（均 ${Math.round(elapsed / TOTAL)}ms/动作，含 40ms 轮询间隔）`);

try { db.close(); } catch { /* 句柄可能已由运行时释放 */ }
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`\n连续性验收：${failed} 项断言失败`); process.exit(1); }
console.log(`\n连续性验收：全部通过（${TOTAL} 次动作，${TOTAL + 7} 项断言）`);
