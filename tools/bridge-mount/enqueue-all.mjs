#!/usr/bin/env node
/**
 * BRIDGE-MOUNT v2 —— 动作库全量入队脚本。
 *
 * 把动作库里所有可判定动作，按「一条链 = 一个 requestId」串行排进 ModelActionQueue：
 *   A. 模型自带：7 个动作组（成对开合自动补齐 closeMotion）、21 个表情
 *   B. 动作库语义链：action_chains 表内 3 条（keyframes 步）
 *
 * 与 v1 的差别：
 *   - 队列层：串行 + 幂等 + 背压（maxPending 32）+ 终态落库，逐个 await 而不是并发打 /ai/call
 *   - 执行层：execute 按 request.args.tool 分发（默认 l2d_act；动作库链走渲染端 l2d_play_keyframes）
 *   - 完成判定：act 走 event 通道 action-done；keyframes 走 result 通道 ok:true
 *   - 动作库链的轨道名必须在 capability controls 里、且 status != unsupported，否则**拒入队**
 *     （不把没证据的映射塞进队列）
 *
 * 用法：node tools/bridge-mount/enqueue-all.mjs [--dry-run] [--only groups|expressions|library] [--runtime 2263]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const F = (p) => `file://${p.replace(/\\/g, '/')}`;

const { openDb } = await import(F(path.join(ROOT, 'packages/dsh-l2d-db/src/db.mjs')));
const actionsRepo = await import(F(path.join(ROOT, 'packages/dsh-l2d-db/src/bridge-actions-repo.mjs')));
const { ModelActionQueue } = await import(F(path.join(ROOT, 'packages/mcp-bridge/action-queue.mjs')));
const { HttpActionExecutor } = await import(F(path.join(ROOT, 'packages/mcp-bridge/action-executor.mjs')));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const dryRun = has('--dry-run');
const only = argOf('--only', null);
const PORT = argOf('--runtime', '2263');
const BASE = `http://127.0.0.1:${PORT}/dsh-l2d`;

// ---------------------------------------------------------------- 能力推断
const cap = await (await fetch(`${BASE}/capability.json`)).json();
const controls = new Map(cap.controls.map((c) => [c.id, c]));
// 动作组资产 id 形如 motion.<组名>.<动画名>；组名需要按「打开/关闭」配对词剥离，
// 不能简单 split('.')——首段是完整组名（含开/关后缀）。
const motionAssets = cap.assets
  .filter((a) => a.kind === 'motion')
  .map((a) => a.id.replace(/^motion\./, '').split('.')[0])
  .map((g) => g.replace(/(打开|关闭)$/, ''));
const expressionAssets = cap.assets.filter((a) => a.kind === 'expression').map((a) => a.id.replace(/^expression\./, ''));
const PARENTS = ['抚胸手', '竖手指', '狗尾巴草'];
const PAIR = { 抚胸手: '抚胸手关闭', 竖手指: '竖手指关闭', 狗尾巴草: '狗尾巴草关闭' };

// ---------------------------------------------------------------- 任务清单
const tasks = [];

if (!only || only === 'groups') {
  for (const p of PARENTS.filter((x) => motionAssets.includes(x))) {
    tasks.push({
      id: `bridge-motion-${p}-open`,
      action: `motion_group.${p}`,
      tool: 'l2d_act',
      priority: 52,
      args: { chain: [{ kind: 'motion', name: `${p}打开` }] },
    });
    tasks.push({
      id: `bridge-motion-${p}-close`,
      action: `motion_group.${p}.close`,
      tool: 'l2d_act',
      priority: 50,
      args: { chain: [{ kind: 'motion', name: PAIR[p] }] },
    });
  }
}

if (!only || only === 'expressions') {
  for (const e of expressionAssets) {
    tasks.push({
      id: `bridge-expression-${e}`,
      action: `expression.${e}`,
      tool: 'l2d_act',
      priority: 45,
      args: { chain: [{ kind: 'expression', name: e }] },
    });
  }
}

if (!only || only === 'library') {
  const db = openDb({ startDir: ROOT });
  const chains = db
    .prepare(
      `SELECT c.id AS chain_id, c.motion_id, m.semantic_key, m.status,
              s.step_index, s.kind, s.params_json, s.duration_ms
         FROM action_chains c
         JOIN motion_definitions m ON m.id = c.motion_id
         LEFT JOIN action_steps s ON s.chain_id = c.id
        ORDER BY c.created_at, s.step_index`
    )
    .all();
  const byChain = new Map();
  for (const r of chains) {
    if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, { ...r, steps: [] });
    if (r.step_index !== null) byChain.get(r.chain_id).steps.push(r);
  }
  for (const c of byChain.values()) {
    const tracks = [];
    const problems = [];
    for (const s of c.steps) {
      let p = {};
      try { p = JSON.parse(s.params_json || '{}'); } catch { problems.push(`step${s.step_index} 参数非法`); continue; }
      if (s.kind === 'keyframes') {
        const ctl = controls.get(p.track);
        if (!ctl) problems.push(`轨道 ${p.track} 不在 capability controls`);
        else if (ctl.status === 'unsupported') problems.push(`轨道 ${p.track} unsupported`);
        else tracks.push({ track: p.track, control: ctl, keys: p.keys, easing: p.easing ?? null, durationMs: s.duration_ms });
      } else if (s.kind === 'expression') {
        // 语义表情名（smile_open_mouth）不是本模型表情 ID，映射无证据 → 不猜
        if (!expressionAssets.includes(p.semantic)) problems.push(`语义表情 ${p.semantic} 无本模型映射证据`);
      } else {
        problems.push(`步类型 ${s.kind} 未支持`);
      }
    }
    tasks.push({
      id: `bridge-lib-${c.semantic_key.replace(/[^A-Za-z0-9]+/g, '-')}`,
      action: `library.${c.semantic_key}`,
      tool: 'l2d_play_keyframes',
      priority: 40,
      admissible: problems.length === 0 && tracks.length > 0,
      problems,
      libraryStatus: c.status,
      args: { tracks, stepCount: c.steps.length },
    });
  }
  db.close();
}

// ---------------------------------------------------------------- 入队
if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        total: tasks.length,
        groups: tasks.filter((t) => t.action.startsWith('motion_group')).length,
        expressions: tasks.filter((t) => t.action.startsWith('expression.')).length,
        library: tasks.filter((t) => t.action.startsWith('library.')).length,
        libraryDetail: tasks.filter((t) => t.action.startsWith('library.')).map((t) => ({ id: t.id, admissible: t.admissible, problems: t.problems })),
      },
      null,
      1
    )
  );
  process.exit(0);
}

/** 执行器：按 request.args.tool 分发；act 走事件通道，keyframes 走结果通道。 */
class DispatchExecutor extends HttpActionExecutor {
  async probeReady() {
    const res = await this.fetchImpl(`${this.baseUrl}/status.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error('RUNTIME_NOT_READY: /status.json');
    const body = await res.json().catch(() => null);
    if (!body || body.renderer !== true) throw new Error('RUNTIME_NOT_READY: renderer');
    this.runtime = { model: body.model, version: body.version };
    return true;
  }

  async execute(request) {
    await this.probeReady();
    const { tool = 'l2d_act', chain, tracks } = request.args ?? {};
    const payload = tool === 'l2d_play_keyframes'
      ? { name: tool, args: Object.fromEntries((tracks ?? []).map((t) => [t.track, { control: t.control, keys: t.keys, algorithm: 'sine' }])) }
      : { name: tool, args: { chain: chain ?? [], priority: this.priorityOf(request.priority), silent: true } };

    const callRes = await this.fetchImpl(`${this.baseUrl}/ai/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!callRes.ok) throw new Error(`/ai/call ${callRes.status}`);
    const call = await callRes.json();
    if (!call.ok || !call.id) throw new Error(`/ai/call 未受理：${JSON.stringify(call).slice(0, 160)}`);
    const callId = call.id;

    for (;;) {
      await new Promise((r) => setTimeout(r, 180));
      const res = await this.fetchImpl(`${this.baseUrl}/ai/result?id=${callId}`, { cache: 'no-store' });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      if (!body.ready) continue;
      const result = body.result ?? null;
      const events = Array.isArray(body.events) ? body.events : [];
      const done = events.find((e) => e?.type === 'action-done' && (e.phase === 'end' || e.phase === 'interrupted'));
      if (tool !== 'l2d_act') {
        if (result) return result.ok === false ? { ok: false, executionId: String(callId), reason: result.error || 'rejected' } : { ok: true, executionId: String(callId), phase: 'result' };
        if (done) return { ok: true, executionId: String(callId), phase: done.phase };
      } else {
        if (result && result.ok === false) return { ok: false, executionId: String(callId), reason: result.reason || result.error || 'rejected' };
        if (done) return { ok: true, executionId: String(callId), phase: done.phase };
      }
    }
  }

  priorityOf(p) {
    const n = Number(p ?? 50);
    return n >= 67 ? 'FORCE' : n >= 34 ? 'NORMAL' : 'BACKGROUND';
  }
}

const db = openDb({ startDir: ROOT });
const repo = {
  findById: (id) => actionsRepo.findById(db, id),
  insertRequest: (req) => actionsRepo.insertRequest(db, req),
  markRunning: (id) => actionsRepo.markRunning(db, id),
  markTerminal: (id, s, o) => actionsRepo.markTerminal(db, id, s, o),
  markInterruptedAll: () => actionsRepo.markInterruptedAll(db),
};
const executor = new DispatchExecutor({ baseUrl: BASE, pollIntervalMs: 180, releaseGraceMs: 250 });
const queue = new ModelActionQueue({ executor, repo, maxPending: 32 });

const results = [];
for (const t of tasks) {
  if (t.admissible === false) {
    results.push({ id: t.id, action: t.action, state: 'rejected-precheck', problems: t.problems });
    continue;
  }
  const receipt = await Promise.race([
    queue.enqueue({
      requestId: t.id,
      workspaceId: 'ws-live2d-agent',
      controlSessionId: 'model-control',
      action: t.action,
      priority: t.priority,
      args: { tool: t.tool, ...t.args },
    }),
    new Promise((r) => setTimeout(() => r({ error: 'ENQUEUE_TIMEOUT' }), 30000)),
  ]);
  const row = actionsRepo.findById(db, t.id);
  results.push({ id: t.id, action: t.action, state: row?.state ?? receipt?.state ?? receipt?.error, error: row?.error ?? receipt?.error ?? null });
}
db.close();

const ok = results.filter((r) => r.state === 'completed').length;
const failed = results.filter((r) => ['failed', 'cancelled', 'interrupted'].includes(r.state)).length;
const rejected = results.filter((r) => r.state === 'rejected-precheck').length;
console.log(JSON.stringify({ total: tasks.length, completed: ok, failed, rejectedPrecheck: rejected, results }, null, 1));
process.exit(0);
