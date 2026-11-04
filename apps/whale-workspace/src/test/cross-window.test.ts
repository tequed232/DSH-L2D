/**
 * 跨窗口通信测试
 * 运行：node --experimental-strip-types apps/whale-workspace/src/test/cross-window.test.ts
 *
 * 覆盖：
 *   - Loopback 双实例：导航/草稿同步
 *   - BroadcastChannel 双实例：序列化后仍可应用远端状态
 *   - 同一 requestId 重复投递只执行一次模型请求
 *   - 会话权威单例 + 所有权检查（镜像窗口无法自建权威）
 */
import { assert, count, delay, section, summary, test, waitFor } from './harness.ts';
import { ChatDraftStore } from '../services/drafts.ts';
import { WorkspaceNavigationService } from '../services/navigation.ts';
import {
  BroadcastChannelAdapter,
  LoopbackAdapter,
} from '../services/crossWindowAdapter.ts';
import { ConversationAuthority, InMemoryConversationService } from '../services/inMemoryConversation.ts';
import { MirrorChatStore, WorkspaceSync } from '../services/sync.ts';

section('Whale Workspace · 跨窗口');
const base = count();

const CHANNEL = 'dsh-l2d:whale-workspace:test';

function makeRole(role: 'authority' | 'mirror', adapter: LoopbackAdapter | BroadcastChannelAdapter) {
  const service = new InMemoryConversationService({ seedGreeting: true, chunkDelayMs: 1, chunkSize: 4 });
  const conversationId = service.list()[0]!.id;
  const nav = new WorkspaceNavigationService(conversationId);
  const drafts = new ChatDraftStore();
  const mirror = new MirrorChatStore();
  const sync = new WorkspaceSync({
    role,
    nav,
    drafts,
    adapter,
    service: role === 'authority' ? service : undefined,
    mirror: role === 'mirror' ? mirror : undefined,
  });
  return { service, nav, drafts, mirror, sync, conversationId };
}

await test('Loopback：镜像端草稿同步到权威端（且不回声）', async () => {
  const authorityAdapter = new LoopbackAdapter(CHANNEL, 'auth');
  const mirrorAdapter = new LoopbackAdapter(CHANNEL, 'mirror');
  const authority = makeRole('authority', authorityAdapter);
  const mirror = makeRole('mirror', mirrorAdapter);
  authority.sync.start();
  mirror.sync.start();

  authority.drafts.set(authority.conversationId, '权威端草稿');
  await delay(5);
  assert.equal(mirror.drafts.get(mirror.conversationId), '权威端草稿');

  mirror.drafts.set(mirror.conversationId, '镜像端草稿');
  await delay(5);
  assert.equal(authority.drafts.get(authority.conversationId), '镜像端草稿');

  authority.sync.stop();
  mirror.sync.stop();
});

await test('Loopback：导航状态双向同步（工作区 ↔ 胶囊）', async () => {
  const authorityAdapter = new LoopbackAdapter(CHANNEL, 'auth-2');
  const mirrorAdapter = new LoopbackAdapter(CHANNEL, 'mirror-2');
  const authority = makeRole('authority', authorityAdapter);
  const mirror = makeRole('mirror', mirrorAdapter);
  authority.sync.start();
  mirror.sync.start();

  authority.nav.openCapsule();
  await delay(5);
  assert.equal(mirror.nav.state.view, 'capsule');
  assert.equal(mirror.nav.state.capsuleVisible, true);
  assert.equal(mirror.nav.state.conversationId, authority.conversationId);

  mirror.nav.openWorkspace();
  await delay(5);
  assert.equal(authority.nav.state.view, 'workspace');
  assert.equal(authority.nav.state.capsuleVisible, false);

  authority.sync.stop();
  mirror.sync.stop();
});

await test('Loopback：镜像窗口的发送请求由权威端执行，镜像端只读投影更新', async () => {
  const authorityAdapter = new LoopbackAdapter(CHANNEL, 'auth-3');
  const mirrorAdapter = new LoopbackAdapter(CHANNEL, 'mirror-3');
  const authority = makeRole('authority', authorityAdapter);
  const mirror = makeRole('mirror', mirrorAdapter);
  authority.sync.start();
  mirror.sync.start();
  await delay(5);

  const requestId = mirror.sync.sendFromMirror(mirror.conversationId, '从胶囊发出去');
  assert.ok(requestId.length > 0);
  await waitFor(
    () => authority.service.get(authority.conversationId)?.generating === false
      && (authority.service.get(authority.conversationId)?.messages.length ?? 0) > 1,
    '权威端完成生成',
  );
  await waitFor(
    () => mirror.mirror.get(mirror.conversationId)?.messages.at(-1)?.status === 'done',
    '镜像端投影收敛为 done',
  );
  const source = authority.service.get(authority.conversationId)!;
  assert.equal(source.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(source.messages.at(-1)!.status, 'done');
  const projected = mirror.mirror.get(mirror.conversationId)!;
  assert.equal(projected.messages.at(-1)!.status, 'done');
  assert.match(projected.messages.at(-1)!.text, /从胶囊发出去/);

  authority.sync.stop();
  mirror.sync.stop();
});

await test('同一 requestId 重复投递只产生一条用户消息（不重复发起请求）', async () => {
  const adapter = new LoopbackAdapter(CHANNEL, 'auth-4');
  const authority = makeRole('authority', adapter);
  authority.sync.start();
  let userMessages = 0;
  authority.service.subscribe((event) => {
    if (event.type === 'message-added' && event.message.role === 'user') userMessages += 1;
  });

  const duplicate = {
    type: 'chat/send-request' as const,
    origin: 'mirror-x',
    requestId: 'req-dup-1',
    conversationId: authority.conversationId,
    text: '只发一次',
  };
  authority.sync.handleRemote(duplicate);
  authority.sync.handleRemote({ ...duplicate });
  authority.sync.handleRemote({ ...duplicate });
  await delay(40);
  assert.equal(userMessages, 1);
  authority.sync.stop();
});

await test('BroadcastChannel：同源双实例可同步（走结构化克隆）', async () => {
  const name = `${CHANNEL}:bc-${Date.now()}`;
  const a = new BroadcastChannelAdapter(name, 'bc-a');
  const b = new BroadcastChannelAdapter(name, 'bc-b');
  a.start();
  b.start();
  const received: string[] = [];
  b.subscribe((message) => {
    if (message.type === 'draft/set') received.push(message.text);
  });
  a.publish({
    type: 'draft/set',
    origin: 'bc-a',
    conversationId: 'conv-1',
    text: '跨窗口草稿',
  });
  await delay(60);
  assert.deepEqual(received, ['跨窗口草稿']);
  a.stop();
  b.stop();
});

await test('BroadcastChannel：导航状态完整往返', async () => {
  const name = `${CHANNEL}:bc-nav-${Date.now()}`;
  const navA = new WorkspaceNavigationService('conv-nav');
  const navB = new WorkspaceNavigationService('conv-nav');
  const draftsA = new ChatDraftStore();
  const draftsB = new ChatDraftStore();
  const adapterA = new BroadcastChannelAdapter(name, 'bc-nav-a');
  const adapterB = new BroadcastChannelAdapter(name, 'bc-nav-b');
  const syncA = new WorkspaceSync({ role: 'mirror', nav: navA, drafts: draftsA, adapter: adapterA });
  const syncB = new WorkspaceSync({ role: 'mirror', nav: navB, drafts: draftsB, adapter: adapterB });
  syncA.start();
  syncB.start();
  await delay(10);

  navA.openCapsule();
  await delay(80);
  assert.equal(navB.state.view, 'capsule');
  assert.equal(navB.state.capsuleVisible, true);
  assert.equal(navB.state.conversationId, 'conv-nav');

  syncA.stop();
  syncB.stop();
});

await test('并发同 revision 的导航冲突按 origin 字典序收敛', () => {
  const navA = new WorkspaceNavigationService('conv-tie');
  const navB = new WorkspaceNavigationService('conv-tie');
  const adapterA = new LoopbackAdapter(CHANNEL, 'a');
  const adapterB = new LoopbackAdapter(CHANNEL, 'z');
  const syncA = new WorkspaceSync({ role: 'mirror', nav: navA, drafts: new ChatDraftStore(), adapter: adapterA });
  const syncB = new WorkspaceSync({ role: 'mirror', nav: navB, drafts: new ChatDraftStore(), adapter: adapterB });

  navA.openCapsule();
  navB.openWorkspace();
  const stateA = navA.snapshot();
  const stateB = navB.snapshot();
  assert.equal(stateA.revision, stateB.revision);

  syncA.handleRemote({ type: 'nav/state', origin: 'z', state: stateB });
  syncB.handleRemote({ type: 'nav/state', origin: 'a', state: stateA });

  assert.equal(navA.state.view, 'workspace');
  assert.equal(navB.state.view, 'workspace');
});

await test('会话权威单例：第二个权威声明被拒绝', () => {
  const authority = ConversationAuthority.claim('workspace-window', { seedGreeting: false });
  assert.equal(ConversationAuthority.current(), authority);
  let error: unknown = null;
  try {
    ConversationAuthority.claim('capsule-window', { seedGreeting: false });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.equal((error as Error).name, 'ConversationOwnershipError');
  authority.release();
  const next = ConversationAuthority.claim('capsule-window', { seedGreeting: false });
  assert.equal(next.owner, 'capsule-window');
  next.release();
});

await test('镜像窗口不能直接发送消息', () => {
  const adapter = new LoopbackAdapter(CHANNEL, 'mirror-only');
  const mirror = makeRole('mirror', adapter);
  assert.equal('sendMessage' in mirror.mirror, false);
  let error: unknown = null;
  try {
    mirror.sync.sendFromMirror(mirror.conversationId, '不该直接发');
  } catch (err) {
    error = err;
  }
  assert.equal(error, null);
  // 权威端调用会被拒绝，避免双份权威
  const authorityAdapter = new LoopbackAdapter(CHANNEL, 'auth-only');
  const authority = makeRole('authority', authorityAdapter);
  authority.sync.start();
  let thrown: unknown = null;
  try {
    authority.sync.sendFromMirror(authority.conversationId, '权威端不该走镜像路径');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error);
  authority.sync.stop();
});

summary('跨窗口', base);
