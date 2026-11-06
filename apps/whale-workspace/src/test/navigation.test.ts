/**
 * 导航状态机测试
 * 运行：node --experimental-strip-types apps/whale-workspace/src/test/navigation.test.ts
 */
import { assert, count, section, summary, test } from './harness.ts';
import { WorkspaceNavigationService } from '../services/navigation.ts';
import { InMemoryConversationService } from '../services/inMemoryConversation.ts';

section('Whale Workspace · 导航');
const base = count();

const service = new InMemoryConversationService({ seedGreeting: true, chunkDelayMs: 1 });
const initial = service.list()[0]!.id;

await test('初始为 workspace，胶囊未展开', () => {
  const nav = new WorkspaceNavigationService(initial);
  assert.equal(nav.state.view, 'workspace');
  assert.equal(nav.state.capsuleVisible, false);
  assert.equal(nav.state.conversationId, initial);
});

await test('openCapsule：切到胶囊且保持同一会话', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.openCapsule();
  assert.equal(nav.state.view, 'capsule');
  assert.equal(nav.state.capsuleVisible, true);
  assert.equal(nav.state.conversationId, initial);
});

await test('胶囊最大化 → openWorkspace 定位当前会话并隐藏胶囊', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.openCapsule();
  nav.openWorkspace();
  assert.equal(nav.state.view, 'workspace');
  assert.equal(nav.state.capsuleVisible, false);
  assert.equal(nav.state.conversationId, initial);
});

await test('工作区 → openCapsule 呼出胶囊，不改会话', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.openCapsule();
  assert.equal(nav.state.view, 'capsule');
  assert.equal(nav.state.conversationId, initial);
});

await test('hideCapsule 只隐藏，不换会话', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.openCapsule();
  nav.hideCapsule();
  assert.equal(nav.state.view, 'capsule');
  assert.equal(nav.state.capsuleVisible, false);
  assert.equal(nav.state.conversationId, initial);
});

await test('切换不重建会话：服务里的会话对象与消息保持稳定', async () => {
  const nav = new WorkspaceNavigationService(initial);
  const before = service.get(initial)!;
  const beforeList = service.list();
  nav.openCapsule();
  nav.openWorkspace();
  nav.openCapsule(initial);
  nav.openWorkspace(initial);
  const after = service.get(initial)!;
  assert.deepEqual(
    after.messages.map((m) => m.id),
    before.messages.map((m) => m.id),
  );
  assert.equal(service.list().length, beforeList.length);
  assert.equal(nav.state.conversationId, initial);
});

await test('新建会话在两个界面同步', () => {
  const nav = new WorkspaceNavigationService(initial);
  const created = service.create('新会话');
  nav.switchConversation(created.id);
  nav.openCapsule();
  assert.equal(nav.state.conversationId, created.id);
  nav.openWorkspace();
  assert.equal(nav.state.conversationId, created.id);
});

await test('未读：胶囊收起时累计，展开后清零', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.openCapsule();
  nav.hideCapsule();
  nav.noteAssistantMessage(initial);
  nav.noteAssistantMessage(initial);
  assert.equal(nav.unreadOf(initial), 2);
  nav.openCapsule();
  assert.equal(nav.unreadOf(initial), 0);
});

await test('未读：当前可见会话不累计，其它会话累计', () => {
  const nav = new WorkspaceNavigationService(initial);
  nav.noteAssistantMessage(initial);
  assert.equal(nav.unreadOf(initial), 0);
  const other = service.create('另一个会话');
  nav.noteAssistantMessage(other.id);
  assert.equal(nav.unreadOf(other.id), 1);
});

await test('未读：切到目标会话自动标记已读', () => {
  const nav = new WorkspaceNavigationService(initial);
  const other = service.create('未读目标');
  nav.noteAssistantMessage(other.id);
  assert.equal(nav.unreadOf(other.id), 1);
  nav.switchConversation(other.id);
  assert.equal(nav.unreadOf(other.id), 0);
});

await test('revision 单调递增，旧远端状态被拒', () => {
  const nav = new WorkspaceNavigationService(initial);
  const stale = nav.snapshot();
  nav.openCapsule();
  assert.ok(nav.state.revision > stale.revision);
  assert.equal(nav.applyRemoteState(stale), false);
  const accepted = nav.applyRemoteState({ ...stale, revision: stale.revision + 99 });
  assert.equal(accepted, true);
  assert.equal(nav.state.view, 'workspace');
});

await test('同 revision 默认拒绝，显式 acceptEqual 才接受', () => {
  const nav = new WorkspaceNavigationService(initial);
  const remote = { ...nav.snapshot(), view: 'capsule' as const, capsuleVisible: true };
  assert.equal(nav.applyRemoteState(remote), false);
  assert.equal(nav.applyRemoteState(remote, { acceptEqual: true }), true);
  assert.equal(nav.state.view, 'capsule');
  assert.equal(nav.state.capsuleVisible, true);
});

await test('订阅者收到状态且可退订', () => {
  const nav = new WorkspaceNavigationService(initial);
  let calls = 0;
  const off = nav.subscribe(() => {
    calls += 1;
  });
  nav.openCapsule();
  nav.openWorkspace();
  assert.equal(calls, 2);
  off();
  nav.openCapsule();
  assert.equal(calls, 2);
});

summary('导航', base);
