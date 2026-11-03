/**
 * 应用装配层：把导航 / 会话 / 草稿 / 跨窗口同步装成一个 WorkspaceApp。
 *
 * 两种运行角色：
 *   - authority（默认）：持有 ConversationService + WorkspaceSync(authority)，执行请求；
 *   - mirror（?role=mirror）：只有只读投影与 send-request 通道，没有第二份权威。
 *
 * 所有 UI 只依赖本文件暴露的 read/command 接口，不直接碰服务内部。
 */
import { ChatDraftStore } from '../services/drafts.ts';
import { WorkspaceNavigationService } from '../services/navigation.ts';
import {
  BroadcastChannelAdapter,
  LoopbackAdapter,
  type CrossWindowAdapter,
} from '../services/crossWindowAdapter.ts';
import { ConversationAuthority, InMemoryConversationService } from '../services/inMemoryConversation.ts';
import { MirrorChatStore, WorkspaceSync } from '../services/sync.ts';
import { ChatSessionController } from '../services/session.ts';
import type { BackendMode, ConversationSnapshot, NavigationState, WorkspaceView } from '../services/types.ts';

export type AppRole = 'authority' | 'mirror';

export const WORKSPACE_CHANNEL = 'dsh-l2d:whale-workspace';

export interface AppViewState {
  readonly role: AppRole;
  readonly mode: BackendMode;
  readonly view: WorkspaceView;
  readonly capsuleVisible: boolean;
  readonly conversationId: string;
  readonly draft: string;
  readonly unread: number;
  readonly unreadByConversation: Readonly<Record<string, number>>;
  readonly conversations: readonly ConversationSnapshot[];
  readonly current: ConversationSnapshot | null;
  readonly generating: boolean;
  readonly connected: boolean;
}

export interface WorkspaceApp {
  readonly role: AppRole;
  readonly mode: BackendMode;
  viewState(): AppViewState;
  subscribe(listener: () => void): () => void;
  openWorkspace(): void;
  openCapsule(): void;
  hideCapsule(): void;
  switchConversation(conversationId: string): void;
  createConversation(): void;
  updateDraft(text: string): void;
  send(): Promise<boolean>;
  dispose(): void;
}

function readRole(): AppRole {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('role') === 'mirror' ? 'mirror' : 'authority';
  } catch {
    return 'authority';
  }
}

function createAdapter(role: AppRole): CrossWindowAdapter {
  try {
    return new BroadcastChannelAdapter(WORKSPACE_CHANNEL, `${role}-${Math.random().toString(36).slice(2, 8)}`);
  } catch {
    // 老环境 / 测试宿主没有 BroadcastChannel 时退回进程内总线
    return new LoopbackAdapter(WORKSPACE_CHANNEL, `${role}-loopback`);
  }
}

function authorityService(): InMemoryConversationService {
  const existing = ConversationAuthority.current();
  if (existing) return existing.service;
  return ConversationAuthority.claim('whale-workspace', {
    // 40ms × 3 字：肉眼可见的流式，但不至于让截图等太久
    chunkDelayMs: 40,
    chunkSize: 3,
    seedGreeting: true,
  }).service;
}

class AuthorityWorkspaceApp implements WorkspaceApp {
  readonly role: AppRole = 'authority';
  readonly mode: BackendMode = 'memory-mock';

  private readonly nav: WorkspaceNavigationService;
  private readonly drafts: ChatDraftStore;
  private readonly service: InMemoryConversationService;
  private readonly controller: ChatSessionController;
  private readonly sync: WorkspaceSync;
  private readonly adapter: CrossWindowAdapter;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor() {
    this.service = authorityService();
    this.nav = new WorkspaceNavigationService(this.service.list()[0]?.id ?? '');
    this.drafts = new ChatDraftStore();
    this.controller = new ChatSessionController({ nav: this.nav, drafts: this.drafts, service: this.service });
    this.adapter = createAdapter('authority');
    this.sync = new WorkspaceSync({
      role: 'authority',
      nav: this.nav,
      drafts: this.drafts,
      adapter: this.adapter,
      service: this.service,
    });
    this.unsubscribers.push(this.nav.subscribe(() => this.emit()));
    this.unsubscribers.push(this.drafts.subscribe(() => this.emit()));
    this.unsubscribers.push(this.service.subscribe(() => this.emit()));
    this.sync.start();
  }

  viewState(): AppViewState {
    const nav = this.nav.state;
    const conversations = this.service
      .list()
      .map((summary) => this.service.get(summary.id))
      .filter((snapshot): snapshot is ConversationSnapshot => snapshot !== null);
    const current = this.service.get(nav.conversationId);
    return buildState({
      role: this.role,
      mode: this.mode,
      nav,
      draft: this.drafts.get(nav.conversationId),
      conversations,
      current,
      connected: true,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  openWorkspace(): void {
    this.nav.openWorkspace();
  }

  openCapsule(): void {
    this.nav.openCapsule();
  }

  hideCapsule(): void {
    this.nav.hideCapsule();
  }

  switchConversation(conversationId: string): void {
    this.nav.switchConversation(conversationId);
  }

  createConversation(): void {
    const created = this.service.create();
    this.nav.switchConversation(created.id);
  }

  updateDraft(text: string): void {
    this.controller.updateDraft(text);
  }

  send(): Promise<boolean> {
    return this.controller.sendCurrent();
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.controller.dispose();
    this.sync.stop();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

class MirrorWorkspaceApp implements WorkspaceApp {
  readonly role: AppRole = 'mirror';
  readonly mode: BackendMode = 'memory-mock';

  private readonly nav: WorkspaceNavigationService;
  private readonly drafts: ChatDraftStore;
  private readonly mirror: MirrorChatStore;
  private readonly sync: WorkspaceSync;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor() {
    this.nav = new WorkspaceNavigationService('');
    this.drafts = new ChatDraftStore();
    this.mirror = new MirrorChatStore();
    this.sync = new WorkspaceSync({
      role: 'mirror',
      nav: this.nav,
      drafts: this.drafts,
      adapter: createAdapter('mirror'),
      mirror: this.mirror,
    });
    this.unsubscribers.push(this.nav.subscribe(() => this.emit()));
    this.unsubscribers.push(this.drafts.subscribe(() => this.emit()));
    this.unsubscribers.push(this.mirror.subscribe(() => this.emit()));
    this.sync.start();
  }

  viewState(): AppViewState {
    const nav = this.nav.state;
    const conversations = this.mirror.list();
    return buildState({
      role: this.role,
      mode: this.mode,
      nav,
      draft: this.drafts.get(nav.conversationId),
      conversations,
      current: this.mirror.get(nav.conversationId),
      connected: conversations.length > 0,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  openWorkspace(): void {
    this.nav.openWorkspace();
  }

  openCapsule(): void {
    this.nav.openCapsule();
  }

  hideCapsule(): void {
    this.nav.hideCapsule();
  }

  switchConversation(conversationId: string): void {
    this.nav.switchConversation(conversationId);
  }

  createConversation(): void {
    // 镜像窗口不建会话：会话由权威端创建后经快照同步
  }

  updateDraft(text: string): void {
    this.drafts.set(this.nav.state.conversationId, text);
  }

  async send(): Promise<boolean> {
    const conversationId = this.nav.state.conversationId;
    const text = this.drafts.get(conversationId).trim();
    if (!text) return false;
    this.drafts.clear(conversationId);
    this.sync.sendFromMirror(conversationId, text);
    return true;
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.sync.stop();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

interface BuildStateInput {
  role: AppRole;
  mode: BackendMode;
  nav: Readonly<NavigationState>;
  draft: string;
  conversations: readonly ConversationSnapshot[];
  current: ConversationSnapshot | null;
  connected: boolean;
}

function buildState(input: BuildStateInput): AppViewState {
  return {
    role: input.role,
    mode: input.mode,
    view: input.nav.view,
    capsuleVisible: input.nav.capsuleVisible,
    conversationId: input.nav.conversationId,
    draft: input.draft,
    unread: input.nav.unread[input.nav.conversationId] ?? 0,
    unreadByConversation: input.nav.unread,
    conversations: input.conversations,
    current: input.current,
    generating: input.current?.generating === true,
    connected: input.connected,
  };
}

let singleton: WorkspaceApp | null = null;

export function getWorkspaceApp(): WorkspaceApp {
  if (!singleton) singleton = readRole() === 'mirror' ? new MirrorWorkspaceApp() : new AuthorityWorkspaceApp();
  return singleton;
}

export function resetWorkspaceApp(): void {
  singleton?.dispose();
  singleton = null;
}
