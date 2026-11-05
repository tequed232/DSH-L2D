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

ok('migration v7：bridge_workspaces 表已建，SCHEMA_VERSION 与迁移数同步', () => {
  assert.equal(SCHEMA_VERSION, 7, 'SCHEMA_VERSION 应推进到 7');
  const cols = db.prepare("SELECT name FROM pragma_table_info('bridge_workspaces')").all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['chat_session_id', 'control_session_id', 'created_at', 'plugin_id', 'workspace_id']);
});

await okAsync('B01 首次 import plugin：创建一个 Workspace + 恰好两个会话', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const ws = await manager.ensureWorkspace(PLUGIN_ID);
  assert.ok(ws.id && ws.chatSessionId && ws.controlSessionId);
  assert.notEqual(ws.chatSessionId, ws.controlSessionId, '两会话必须相互独立');
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
  assert.equal(again.controlSessionId, first.controlSessionId);
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
  assert.notEqual(a.chatSessionId, a.controlSessionId);
  assert.equal(c.chatSessionId, d.chatSessionId, '同一 plugin 并发重复 ensure 复用同一会话');
  assert.equal(c.controlSessionId, d.controlSessionId);
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

await okAsync('Bridge 骨架：onPluginImport/onPluginDispose 生命周期与未接线守卫', async () => {
  const agentClient = fakeAgentClient();
  const manager = new Live2DWorkspaceManager({
    registry: new WorkBuddyWorkspaceRegistry({ db, agentClient }),
    sessions: new WorkBuddySessionController({ db, agentClient }),
  });
  const bridge = new Live2DMCPBridge({ workspaceManager: manager, pluginId: 'dsh-l2d-lifecycle' });
  const ws = await onPluginImport(bridge);
  assert.ok(ws.id && ws.chatSessionId && ws.controlSessionId);
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
