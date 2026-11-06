/**
 * 草稿隔离测试
 * 运行：node --experimental-strip-types apps/whale-workspace/src/test/draft.test.ts
 */
import { assert, count, section, summary, test } from './harness.ts';
import { ChatDraftStore } from '../services/drafts.ts';
import { WorkspaceNavigationService } from '../services/navigation.ts';
import { InMemoryConversationService } from '../services/inMemoryConversation.ts';
import { ChatSessionController } from '../services/session.ts';

section('Whale Workspace · 草稿');
const base = count();

function makeSession() {
  const service = new InMemoryConversationService({ seedGreeting: true, chunkDelayMs: 1, chunkSize: 8 });
  const first = service.list()[0]!.id;
  const nav = new WorkspaceNavigationService(first);
  const drafts = new ChatDraftStore();
  const controller = new ChatSessionController({ nav, drafts, service });
  return { service, nav, drafts, controller, first };
}

await test('切换工作区/胶囊保留草稿', () => {
  const { nav, drafts, controller, first } = makeSession();
  controller.updateDraft('半句话');
  nav.openCapsule();
  assert.equal(drafts.get(first), '半句话');
  nav.openWorkspace();
  assert.equal(drafts.get(first), '半句话');
  assert.equal(controller.currentDraft(), '半句话');
});

await test('按会话隔离：切走再切回恢复各自草稿', () => {
  const { service, controller, drafts, first } = makeSession();
  const second = service.create('第二会话').id;
  controller.switchConversation(first);
  controller.updateDraft('A 的草稿');
  controller.switchConversation(second);
  assert.equal(controller.currentDraft(), '');
  controller.updateDraft('B 的草稿');
  controller.switchConversation(first);
  assert.equal(controller.currentDraft(), 'A 的草稿');
  assert.equal(drafts.get(second), 'B 的草稿');
});

await test('发送成功只清除发送会话的草稿', async () => {
  const { service, controller, drafts, first } = makeSession();
  const second = service.create('不相关会话').id;
  controller.switchConversation(first);
  controller.updateDraft('发给第一个会话');
  controller.switchConversation(second);
  controller.updateDraft('第二个会话别动');
  controller.switchConversation(first);
  const sent = await controller.sendCurrent();
  assert.equal(sent, true);
  assert.equal(drafts.get(first), '');
  assert.equal(drafts.get(second), '第二个会话别动');
});

await test('关闭胶囊不删除草稿', () => {
  const { nav, drafts, controller, first } = makeSession();
  controller.updateDraft('草稿要留着');
  nav.openCapsule();
  nav.hideCapsule();
  assert.equal(drafts.get(first), '草稿要留着');
});

await test('发送中途切换会话：清除目标仍是发送时的会话', async () => {
  const { service, controller, drafts, first } = makeSession();
  const second = service.create('切换目标').id;
  controller.switchConversation(first);
  controller.updateDraft('要被发出去');
  const pending = controller.sendCurrent();
  controller.switchConversation(second);
  controller.updateDraft('切换后新输入的');
  await pending;
  assert.equal(drafts.get(first), '');
  assert.equal(drafts.get(second), '切换后新输入的');
  assert.equal(service.get(first)!.messages.filter((m) => m.text === '要被发出去').length, 1);
  assert.equal(service.get(second)!.messages.filter((m) => m.role === 'user').length, 0);
});

await test('空草稿不发送、不产生消息', async () => {  const { service, controller, first } = makeSession();
  const before = service.get(first)!.messages.length;
  const sent = await controller.sendCurrent();
  assert.equal(sent, false);
  assert.equal(service.get(first)!.messages.length, before);
});

await test('草稿写入事件可订阅，便于跨窗口同步', () => {
  const drafts = new ChatDraftStore();
  const seen: string[] = [];
  const off = drafts.subscribe((change) => seen.push(`${change.conversationId}:${change.text}`));
  drafts.set('conv-x', 'a');
  drafts.set('conv-x', 'ab');
  drafts.clear('conv-x');
  off();
  drafts.set('conv-x', 'after-off');
  assert.deepEqual(seen, ['conv-x:a', 'conv-x:ab', 'conv-x:']);
});

await test('applyRemote 不回声', () => {
  const drafts = new ChatDraftStore();
  let calls = 0;
  drafts.subscribe(() => {
    calls += 1;
  });
  drafts.applyRemote('conv-y', '远端草稿');
  assert.equal(calls, 0);
  assert.equal(drafts.get('conv-y'), '远端草稿');
});

summary('草稿', base);
