#!/usr/bin/env node
/**
 * BRIDGE-MOUNT（最小可运行挂载点）——把 bridge 的动作通道接到「正在运行的」DSH-L2D 插件运行时。
 *
 * 为什么单独一个入口：完整插件级挂载（plugin/lib/index.js 内建桥 + MCP 工具注册）需要重启 DSH，
 * 而这次只是要让桥把「一条参考神态链」真正排进队列并执行。本脚本复用桥的真实组件：
 *   ModelActionQueue（FIFO / 幂等 / 背压 / 终态持久化）
 *   + bridge-actions-repo（bridge_actions 落库）
 *   + HttpActionExecutor（POST /ai/call → 轮询 /ai/result 事件完成）
 * 唯一适配点是就绪探测：HttpActionExecutor 缺省探测 dev-server 的 /api/models，
 * 这里指向插件自身 /dsh-l2d/status.json（renderer 就绪即视为运行时可用）。
 *
 * 用法：
 *   node tools/bridge-mount/bridge-action.mjs --request-id <id> --action <name> \
 *        --chain '<JSON array>' [--priority 70] [--timeout 20000] [--dry-run]
 * 输出：入队回执 + bridge_actions 行 + executor 结果（一行 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const { openDb } = await import(`file://${ROOT.replace(/\\/g, '/')}/packages/dsh-l2d-db/src/db.mjs`);
const actionsRepo = await import(`file://${ROOT.replace(/\\/g, '/')}/packages/dsh-l2d-db/src/bridge-actions-repo.mjs`);
const { ModelActionQueue } = await import(`file://${ROOT.replace(/\\/g, '/')}/packages/mcp-bridge/action-queue.mjs`);
const { HttpActionExecutor, RUNTIME_NOT_READY } = await import(
  `file://${ROOT.replace(/\\/g, '/')}/packages/mcp-bridge/action-executor.mjs`
);

const argv = process.argv.slice(2);
const argOf = (flag, dflt = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (flag) => argv.includes(flag);

const requestId = argOf('--request-id', `bridge-${Date.now()}`);
const actionName = argOf('--action', 'gallery_reference_motion');
const priority = Number(argOf('--priority', '70'));
const timeoutMs = Number(argOf('--timeout', '20000'));
const dryRun = has('--dry-run');
const chainRaw = argOf('--chain', '[]');
let chain;
try {
  chain = JSON.parse(chainRaw.startsWith('@') ? fs.readFileSync(chainRaw.slice(1), 'utf8') : chainRaw);
} catch (e) {
  console.error(`--chain 不是合法 JSON：${e.message}`);
  process.exit(2);
}
if (!Array.isArray(chain) || chain.length === 0) {
  console.error('--chain 需要非空数组');
  process.exit(2);
}

/** 运行时适配：就绪探测走插件 /status.json（renderer 就绪），其余沿用 HttpActionExecutor。 */
class PluginActionExecutor extends HttpActionExecutor {
  async probeReady() {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/status.json`, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`${RUNTIME_NOT_READY}: 插件不可达（${String((error && error.message) || error)}）`);
    }
    if (!res.ok) throw new Error(`${RUNTIME_NOT_READY}: /status.json ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || body.renderer !== true) throw new Error(`${RUNTIME_NOT_READY}: renderer=${body && body.renderer}`);
    this.runtime = { model: body.model, avatar: body.avatar, version: body.version };
    return true;
  }
}

const db = openDb({ startDir: ROOT });
const repo = {
  findById: (id) => actionsRepo.findById(db, id),
  insertRequest: (req) => actionsRepo.insertRequest(db, req),
  markRunning: (id) => actionsRepo.markRunning(db, id),
  markTerminal: (id, state, o) => actionsRepo.markTerminal(db, id, state, o),
  markInterruptedAll: () => actionsRepo.markInterruptedAll(db),
};

const executor = new PluginActionExecutor({
  baseUrl: 'http://127.0.0.1:2263/dsh-l2d',
  pollIntervalMs: 200,
  releaseGraceMs: 1200, // ParamInjector 的 own 是 TTL 驱动，给一点宽限（桥文档 §release 语义）
  log: (m) => console.error(`[executor] ${m}`),
});
const queue = new ModelActionQueue({ executor, repo, maxPending: 8 });

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, requestId, actionName, priority, chain, queueState: queue.qState }, null, 1));
  db.close();
  process.exit(0);
}

const t0 = Date.now();
const receipt = await Promise.race([
  queue.enqueue({
    requestId,
    workspaceId: 'ws-live2d-agent',
    controlSessionId: 'model-control',
    action: actionName,
    priority,
    args: { chain },
  }),
  new Promise((resolve) => setTimeout(() => resolve({ error: 'ENQUEUE_TIMEOUT', detail: `${timeoutMs}ms` }), timeoutMs)),
]);

const row = actionsRepo.findById(db, requestId);
const out = {
  ok: row && row.state === 'completed',
  requestId,
  action: actionName,
  priority,
  queueReceipt: receipt,
  bridgeActionsRow: row
    ? {
        state: row.state,
        error: row.error,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        result: row.result,
      }
    : null,
  elapsedMs: Date.now() - t0,
  runtime: executor.runtime ?? null,
};
console.log(JSON.stringify(out, null, 1));
db.close();
process.exit(out.ok ? 0 : 1);
