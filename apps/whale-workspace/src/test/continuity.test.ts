/**
 * 会话连续性测试：同一 conversationId 在两个视图一致；流式中切换不中断；未读计数。
 * 运行：node --experimental-strip-types apps/whale-workspace/src/test/continuity.test.ts
 */
import { assert, count, section, summary, test } from './harness.ts';
import { ChatDraftStore } from '../services/drafts.ts';
import { WorkspaceNavigationService } from '../services/navigation.ts';
import { InMemoryConversationService } from '../services/inMemoryConversation.ts';
import { ChatSessionController } from '../services/session.ts';

section('Whale Workspace · 连续性');
const base = count();

function makeSession(chunkDelayMs = 2) {
  const service = new InMemoryConversationService({ seedGreeting: true, chunkDelayMs, chunkSize: 4 });
  const first = service.list()[0]!.id;
  const nav = new WorkspaceNavigationService(first);
  const drafts = new ChatDraftStore();
  const controller = new ChatSessionController({ nav, drafts, service });
  return { service, nav, drafts, controller, first };
}

await test('同一 conversationId：工作区与胶囊读到同一份消息', async () => {
  const { service, nav, controller, first } = makeSession();
  controller.updateDraft('两边的消息要一样');
  await controller.sendCurrent();
  const inWorkspace = service.get(nav.state.conversationId)!;
  nav.openCapsule();
  const inCapsule = service.get(nav.state.conversationId)!;
  assert.deepEqual(
    inCapsule.messages.map((m) => m.id),
    inWorkspace.messages.map((m) => m.id),
  );
  assert.equal(inCapsule.messages.length, 3);
  assert.equal(inCapsule.messages.at(-1)!.status, 'done');
  assert.equal(nav.state.conversationId, first);
});

await test('流式生成中切换视图：不中断、不换会话、消息最终完整', async () => {
  const { service, nav, controller, first } = makeSession(6);
  controller.updateDraft('生成过程中切换');
  const pending = controller.sendCurrent();
  assert.equal(service.isGenerating(first), true);
  nav.openCapsule();
  nav.hideCapsule();
  nav.openWorkspace();
  assert.equal(service.isGenerating(first), true);
  assert.equal(nav.state.conversationId, first);
  await pending;
  const settled = service.get(first)!;
  const reply = settled.messages.filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal(reply.status, 'done');
  assert.match(reply.text, /生成过程中切换/);
  assert.match(reply.text, /MOCK/);
  assert.equal(service.isGenerating(first), false);
});

await test('生成结果在两个视图一致（切换后读取同一权威）', async () => {
  const { service, nav, controller, first } = makeSession(3);
  controller.updateDraft('跨视图一致性');
  const pending = controller.sendCurrent();
  nav.openCapsule();
  await pending;
  const capsuleView = service.get(first)!;
  nav.openWorkspace();
  const workspaceView = service.get(first)!;
  assert.equal(capsuleView.messages.at(-1)!.text, workspaceView.messages.at(-1)!.text);
});

await test('胶囊收起时新消息累计未读，展开清零', async () => {
  const { nav, controller, first } = makeSession(2);
  nav.openCapsule();
  nav.hideCapsule();
  controller.updateDraft('收起后继续生成');
  await controller.sendCurrent();
  assert.equal(nav.unreadOf(first), 1);
  nav.openCapsule();
  assert.equal(nav.unreadOf(first), 0);
});

await test('工作区可见时不产生未读', async () => {
  const { nav, controller, first } = makeSession(2);
  controller.updateDraft('工作区里看得见');
  await controller.sendCurrent();
  assert.equal(nav.state.view, 'workspace');
  assert.equal(nav.unreadOf(first), 0);
});

await test('多次切换后消息数量与 id 序列不变', () => {
  const { service, nav, first } = makeSession(2);
  const before = service.get(first)!.messages.map((m) => m.id);
  for (let i = 0; i < 6; i += 1) {
    nav.openCapsule();
    nav.hideCapsule();
    nav.openWorkspace();
  }
  assert.deepEqual(service.get(first)!.messages.map((m) => m.id), before);
  assert.equal(nav.state.conversationId, first);
});

await test('切换会话时生成不被取消，另一会话的未读独立累计', async () => {
  const { service, nav, controller, first } = makeSession(8);
  const second = service.create('旁观会话').id;
  controller.updateDraft('在第一个会话里生成');
  const pending = controller.sendCurrent();
  controller.switchConversation(second);
  assert.equal(nav.state.conversationId, second);
  await pending;
  assert.equal(service.get(first)!.messages.at(-1)!.status, 'done');
  assert.equal(nav.unreadOf(first), 1);
  assert.equal(service.get(second)!.messages.filter((m) => m.role === 'user').length, 0);
});

summary('连续性', base);
