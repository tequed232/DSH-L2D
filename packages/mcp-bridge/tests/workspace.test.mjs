/**
 * MCP Bridge PR-A 验收（B01-B04）。node:assert + 临时库，A2A 客户端注入 fake
 * （不发真实 HTTP）。直跑：node --experimental-sqlite packages/mcp-bridge/tests/workspace.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import { SCHEMA_VERSION } from '../../dsh-l2d-db/src/schema.mjs';import { Live2DWorkspaceManager, WorkBuddyWorkspaceRegistry, WorkBuddySessionController } from '../workspace-manager.mjs';
import { LocalMirrorChatMemorySource, SessionMemoryInjector } from '../session-memory.mjs';
import { Live2DMCPBridge, onPluginImport, onPluginDispose } from '../index.mjs';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

/** A2A fake：计数调用，确定性 id，不发 HTTP。 */
function fakeAgentClient() {
  const calls = { acquire: 0, createSession: 0 };
  let wsSeq = 0; let sessSeq = 0;
  return {
    calls,
    async acquireWorkspace({ pluginId }) { calls.acquire++; return { workspaceId: `ws-${pluginId}-${++wsSeq}` }; },
    async createSession({ workspaceId, key, title }) {
      calls.createSession++;
      assert.ok(workspaceId && key && title !== undefined, 'fake: createSession 参数必须完整');
      return { sessionId: `sess-${key}-${workspaceId.slice(-4)}-${++sessSeq}` };
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-a-'));
const db = openDb({ path: path.join(tmp, 'bridge.sqlite') });
const PLUGIN_ID = 'dsh-l2d';

console.log('PR-A Workspace / 双会话 / 记忆镜像（B01-B04）');

ok('migration v11：bridge_workspaces 含 action_session_id，SCHEMA_VERSION 与迁移数同步', () => {
  assert.equal(SCHEMA_VERSION, 11, 'SCHEMA_VERSION 应随 v11（action_session_id）推进到 11');
  const cols = db.prepare("SELECT name FROM pragma_table_info('bridge_workspaces')").all().map((c) => c.name);
  assert.deepEqual(cols.sort(), [
    'action_session_id', 'chat_session_id', 'control_session_id', 'created_at', 'plugin_id', 'workspace_id',
  ]);
});

ok('迁移幂等：同一库重复 openDb 不重复执行、不报错', () => {
  const again = openDb({ path: path.join(tmp, 'bridge.sqlite') });
  const rows = again.prepare('SELECT version FROM schema_migrations WHERE version = 11').all();
  assert.equal(rows.length, 1, 'v11 只记一行');
  again.close();
});

await okAsync('B01 首次 import plugin：创建一个 Workspace + 恰好两个活动会话（chat/action）', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const ws = await manager.ensureWorkspace(PLUGIN_ID);
  assert.ok(ws.id && ws.chatSessionId && ws.actionSessionId);
  assert.notEqual(ws.chatSessionId, ws.actionSessionId, '活动会话必须相互独立');
  assert.equal(ws.controlSessionId, '', '新库不创建旧 Control 会话（v11 起只读兼容列）');
  assert.equal(agentClient.calls.acquire, 1);
  assert.equal(agentClient.calls.createSession, 2, '恰好创建 2 个会话');
  const n = db.prepare('SELECT COUNT(*) n FROM bridge_workspaces').get().n;
  assert.equal(n, 1);
});

await okAsync('B02 重复 import plugin：复用原 Workspace（不新建、不重复会话）', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const again = await manager.ensureWorkspace(PLUGIN_ID);
  const first = await manager.ensureWorkspace(PLUGIN_ID);
  assert.equal(again.id, first.id);
  assert.equal(again.chatSessionId, first.chatSessionId);
  assert.equal(again.actionSessionId, first.actionSessionId);
  assert.equal(agentClient.calls.acquire, 0, '已注册 → 不再调 acquire');
  assert.equal(agentClient.calls.createSession, 0, '会话 id 已在本地行 → 不再调 createSession');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bridge_workspaces').get().n, 1, '重复 import 复用同一行');
});

await okAsync('B03 并发导入防重：ensureWorkspace 并行调用仍恰好两个会话', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const [a, b] = await Promise.all([manager.ensureWorkspace('dsh-l2d-b03a'), manager.ensureWorkspace('dsh-l2d-b03b')]);
  // 不同 plugin 各自一行；同一 plugin 重复 ensure（覆盖幂等路径）
  const [c, d] = await Promise.all([manager.ensureWorkspace('dsh-l2d-b03a'), manager.ensureWorkspace('dsh-l2d-b03a')]);
  assert.notEqual(a.chatSessionId, a.actionSessionId);
  assert.equal(c.chatSessionId, d.chatSessionId, '同一 plugin 并发重复 ensure 复用同一会话');
  assert.equal(c.actionSessionId, d.actionSessionId);
  const rows = db.prepare('SELECT COUNT(*) n FROM bridge_workspaces WHERE plugin_id LIKE ?').get('dsh-l2d-b03%').n;
  assert.equal(rows, 2);
});

await okAsync('B04 Chat 产生新消息：下一次记忆快照包含更新（revision 递增）', async () => {
  const source = new LocalMirrorChatMemorySource();
  const injector = new SessionMemoryInjector({ source });
  const before = await injector.snapshot('ws-1', 'chat-1');
  assert.equal(before.revision, 0);
  assert.deepEqual(before.recentMessages, []);
  source.appendChatTurn('chat-1', 'user', '你好，挥挥手');
  source.appendChatTurn('chat-1', 'assistant', '好呀（挥手）');
  const after = await injector.snapshot('ws-1', 'chat-1');
  assert.equal(after.revision, 2, 'revision 单调递增');
  assert.equal(after.recentMessages.length, 2);
  assert.equal(after.recentMessages[1].content, '好呀（挥手）');
  assert.match(after.summary, /挥挥手/);
  // bounded：ring 截 10 条、summary 截 2KB
  for (let i = 0; i < 15; i++) source.appendChatTurn('chat-1', 'user', `消息${i}`);
  const bounded = await injector.snapshot('ws-1', 'chat-1');
  assert.equal(bounded.recentMessages.length, 10, 'recentMessages 上限 10 条');
  assert.equal(Buffer.byteLength(bounded.summary, 'utf8') <= 2048, true, 'summary ≤2KB');
  assert.ok(bounded.recentMessages.some((m) => m.content === '消息14'), '保留最新消息');
});

ok('非法输入拒绝：role 白名单 / key 白名单 / 注入接口必填', () => {
  const source = new LocalMirrorChatMemorySource();
  assert.throws(() => source.appendChatTurn('c', 'system', 'x'), /role/);
  const agentClient = fakeAgentClient();
  assert.throws(() => new WorkBuddyWorkspaceRegistry({ db, agentClient: {} }), /acquireWorkspace/);
  assert.throws(() => new WorkBuddySessionController({ db, agentClient: {} }), /createSession/);
  assert.throws(() => new Live2DMCPBridge({ workspaceManager: null, pluginId: 'p' }), /workspaceManager/);
});

await okAsync('PR-1 旧库升级：control_session_id 原样保留，action 新建（不自动复用旧 Control）', async () => {
  const { findBridgeWorkspace } = await import('../../dsh-l2d-db/src/bridge-repo.mjs');
  const OLD = 'dsh-l2d-legacy';
  // 模拟 v10 旧行：只有 chat + control，action 空
  db.prepare('INSERT OR REPLACE INTO bridge_workspaces (plugin_id, workspace_id, chat_session_id, control_session_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(OLD, 'ws-legacy', 'ws-legacy:chat', 'ws-legacy:model-control', Date.now());
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const ws = await manager.ensureWorkspace(OLD);
  const row = findBridgeWorkspace(db, OLD);
  assert.equal(row.controlSessionId, 'ws-legacy:model-control', '旧 Control 值不得被改写或清空');
  assert.equal(row.chatSessionId, 'ws-legacy:chat', '旧 Chat 保留');
  assert.ok(ws.actionSessionId, '升级后补建 action 会话');
  assert.notEqual(ws.actionSessionId, 'ws-legacy:model-control', '不得未经检查直接复用旧 Control Session');
  assert.equal(agentClient.calls.createSession, 1, '只补建 action，不动既有 chat');
});

await okAsync('PR-1 并发同 key：进程内去重，同 (workspaceId,key) 不重复建会话', async () => {
  const PLUG = 'dsh-l2d-p1-dedupe';
  const agentClient = fakeAgentClient();
  const registry = new WorkBuddyWorkspaceRegistry({ db, agentClient });
  const controller = new WorkBuddySessionController({ db, agentClient });
  const created = await registry.create({ pluginId: PLUG });
  const wsId = created.id;
  const results = await Promise.all([
    controller.ensureSession({ workspaceId: wsId, key: 'action', title: 'L2D Action' }),
    controller.ensureSession({ workspaceId: wsId, key: 'action', title: 'L2D Action' }),
    controller.ensureSession({ workspaceId: wsId, key: 'action', title: 'L2D Action' }),
  ]);
  assert.equal(agentClient.calls.createSession, 1, '三次并发只建一个会话');
  const ids = new Set(results.map((r) => r.id));
  assert.equal(ids.size, 1, '三次返回同一 id');
});

await okAsync('PR-1 跨进程竞态：CAS 败者回读赢家 id 并上报孤儿，不静默丢弃', async () => {
  const PLUG = 'dsh-l2d-p1-cas';
  const agentClient = fakeAgentClient();
  const registry = new WorkBuddyWorkspaceRegistry({ db, agentClient });
  const created = await registry.create({ pluginId: PLUG });
  // 两个独立 controller = 两个"进程"，都先查空再各自建会话
  const c1 = new WorkBuddySessionController({ db, agentClient });
  const c2 = new WorkBuddySessionController({ db, agentClient });
  const [r1, r2] = await Promise.all([
    c1.ensureSession({ workspaceId: created.id, key: 'action', title: 'A' }),
    c2.ensureSession({ workspaceId: created.id, key: 'action', title: 'A' }),
  ]);
  assert.equal(agentClient.calls.createSession, 2, '两进程各建了一次（真实竞态前提）');
  assert.equal(r1.id, r2.id, '最终绑定同一个 action 会话');
  const losers = [r1, r2].filter((r) => r.orphanSessionId);
  assert.equal(losers.length, 1, '恰好一方为败者');
  assert.notEqual(losers[0].orphanSessionId, losers[0].id, '孤儿 id 与在用 id 不同（供调用方清理）');
});

await okAsync('PR-1 会话真实性标记：占位客户端 → sessionKind=logical（禁止宣称宿主两会话）', async () => {
  const agentClient = { ...fakeAgentClient(), kind: 'logical-placeholder' };
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const ws = await manager.ensureWorkspace('dsh-l2d-p1-kind');
  assert.equal(ws.sessionKind, 'logical', '占位客户端必须暴露 logical 标记');
});

await okAsync('Bridge 骨架：onPluginImport/onPluginDispose 生命周期与未接线守卫', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const bridge = new Live2DMCPBridge({ workspaceManager: manager, pluginId: 'dsh-l2d-lifecycle' });
  const ws = await onPluginImport(bridge);
  assert.ok(ws.id && ws.chatSessionId && ws.actionSessionId);
  const inject = await bridge.injectControlContext({ summary: '', revision: 0 });
  assert.equal(inject.wired, false, 'injectControlContext 是宿主适配点，不伪造已接通');
  await assert.rejects(() => bridge.enqueueAction({ requestId: 'r1' }), /PR-C/);
  await onPluginDispose(bridge);
  assert.equal(bridge.initialized, false);
  assert.equal(bridge.workspace, null, '卸载释放运行时引用，不删除工作区历史');
  const n = db.prepare('SELECT COUNT(*) n FROM bridge_workspaces WHERE plugin_id = ?').get('dsh-l2d-lifecycle').n;
  assert.equal(n, 1, '工作区历史保留');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
