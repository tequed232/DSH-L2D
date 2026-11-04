/**
 * 跨窗口同步桥
 *
 * 角色划分：
 *   - authority：持有 ConversationService（唯一权威），执行模型请求，向其它窗口广播快照/增量；
 *   - mirror：只读投影（MirrorChatStore），发送请求时只 publish send-request，由 authority 去重执行。
 *
 * 导航与草稿是 last-writer-wins（带 revision），两侧都可以发起，但都只是「同一份状态」的副本。
 */
import type { ChatDraftStore } from './drafts.ts';
import type { WorkspaceNavigationService } from './navigation.ts';
import type { ConversationService } from './conversation.ts';
import type { CrossWindowAdapter, SyncMessage } from './crossWindowAdapter.ts';
import type { ChatMessage, ConversationSnapshot } from './types.ts';

export type SyncRole = 'authority' | 'mirror';

/** 镜像端只读消息投影。它刻意不实现 sendMessage，避免变成第二份权威。 */
export class MirrorChatStore {
  readonly mode = 'mirror' as const;
  private readonly records = new Map<string, {
    id: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
    generating: boolean;
  }>();
  private readonly listeners = new Set<() => void>();

  applySnapshot(snapshots: readonly ConversationSnapshot[]): void {
    this.records.clear();
    for (const snapshot of snapshots) {
      this.records.set(snapshot.id, {
        id: snapshot.id,
        title: snapshot.title,
        updatedAt: snapshot.updatedAt,
        messages: snapshot.messages.map((m) => ({ ...m })),
        generating: snapshot.generating,
      });
    }
    this.emit();
  }

  applyAppend(conversationId: string, message: ChatMessage): void {
    const record = this.ensure(conversationId);
    const index = record.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) record.messages[index] = { ...message };
    else record.messages.push({ ...message });
    record.updatedAt = Math.max(record.updatedAt, message.createdAt);
    this.emit();
  }

  applyUpdate(conversationId: string, message: ChatMessage): void {
    const record = this.ensure(conversationId);
    const index = record.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) record.messages[index] = { ...message };
    else record.messages.push({ ...message });
    this.emit();
  }

  applyGeneration(conversationId: string, generating: boolean): void {
    this.ensure(conversationId).generating = generating;
    this.emit();
  }

  get(conversationId: string): ConversationSnapshot | null {
    const record = this.records.get(conversationId);
    if (!record) return null;
    return {
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      generating: record.generating,
      messages: record.messages.map((m) => ({ ...m })),
    };
  }

  list(): ConversationSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        generating: record.generating,
        messages: record.messages.map((m) => ({ ...m })),
      }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensure(conversationId: string): {
    id: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
    generating: boolean;
  } {
    let record = this.records.get(conversationId);
    if (!record) {
      record = { id: conversationId, title: conversationId, updatedAt: 0, messages: [], generating: false };
      this.records.set(conversationId, record);
    }
    return record;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export interface WorkspaceSyncOptions {
  readonly role: SyncRole;
  readonly nav: WorkspaceNavigationService;
  readonly drafts: ChatDraftStore;
  readonly adapter: CrossWindowAdapter;
  readonly service?: ConversationService;
  readonly mirror?: MirrorChatStore;
  readonly onError?: (error: unknown) => void;
}

export class WorkspaceSync {
  private readonly options: WorkspaceSyncOptions;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly seenRequests = new Set<string>();
  private started = false;
  private applyingRemote = false;
  private requestSeq = 0;

  constructor(options: WorkspaceSyncOptions) {
    this.options = options;
  }

  get role(): SyncRole {
    return this.options.role;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { adapter, nav, drafts, service, role } = this.options;
    adapter.start();
    this.unsubscribers.push(adapter.subscribe((message) => this.handleRemote(message)));
    this.unsubscribers.push(
      nav.subscribe((state) => {
        if (this.applyingRemote) return;
        adapter.publish({ type: 'nav/state', origin: adapter.id, state });
      }),
    );
    this.unsubscribers.push(
      drafts.subscribe((change) => {
        adapter.publish({
          type: 'draft/set',
          origin: adapter.id,
          conversationId: change.conversationId,
          text: change.text,
        });
      }),
    );
    if (role === 'authority') {
      if (!service) throw new Error('authority 角色必须注入 ConversationService');
      this.unsubscribers.push(service.subscribe((event) => {
        switch (event.type) {
          case 'created':
            adapter.publish({
              type: 'chat/snapshot',
              origin: adapter.id,
              snapshots: this.snapshotAll(),
            });
            break;
          case 'message-added':
            adapter.publish({
              type: 'chat/append',
              origin: adapter.id,
              conversationId: event.conversationId,
              message: event.message,
            });
            break;
          case 'message-updated':
          case 'message-settled':
            adapter.publish({
              type: 'chat/update',
              origin: adapter.id,
              conversationId: event.conversationId,
              message: event.message,
            });
            break;
          case 'generation':
            adapter.publish({
              type: 'chat/generation',
              origin: adapter.id,
              conversationId: event.conversationId,
              generating: event.generating,
            });
            break;
          default:
            break;
        }
      }));
      this.publishFullState();
    } else {
      // 镜像窗口主动要一次全量状态（避免打开顺序决定谁先收到）
      adapter.publish({ type: 'sync/request', origin: adapter.id });
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.options.adapter.stop();
  }

  /** 镜像窗口发起发送：只广播 requestId，不直接调服务 */
  sendFromMirror(conversationId: string, text: string): string {
    if (this.role !== 'mirror') throw new Error('sendFromMirror 只能在 mirror 角色调用');
    this.requestSeq += 1;
    const requestId = `${this.options.adapter.id}:${this.requestSeq}`;
    this.options.adapter.publish({
      type: 'chat/send-request',
      origin: this.options.adapter.id,
      requestId,
      conversationId,
      text,
    });
    return requestId;
  }

  /** 公开给单测：直接喂一条远端消息（也用于模拟重复投递） */
  handleRemote(message: SyncMessage): void {
    if (!message || message.origin === this.options.adapter.id) return;
    const { nav, drafts } = this.options;
    switch (message.type) {
      case 'sync/request': {
        if (this.role !== 'authority') return;
        this.publishFullState();
        break;
      }
      case 'nav/state': {
        this.applyingRemote = true;
        try {
          const equalRevision = message.state.revision === nav.state.revision;
          nav.applyRemoteState(message.state, {
            acceptEqual: equalRevision && message.origin > this.options.adapter.id,
          });
        } finally {
          this.applyingRemote = false;
        }
        break;
      }
      case 'draft/set':
        drafts.applyRemote(message.conversationId, message.text);
        break;
      case 'chat/snapshot':
      case 'chat/append':
      case 'chat/update':
      case 'chat/generation':
        this.applyChatToMirror(message);
        break;
      case 'chat/send-request': {
        if (this.role !== 'authority') return;
        if (this.seenRequests.has(message.requestId)) return;
        this.seenRequests.add(message.requestId);
        const service = this.options.service;
        if (!service) return;
        void service
          .sendMessage(message.conversationId, message.text, { requestId: message.requestId })
          .catch((error) => this.options.onError?.(error));
        break;
      }
      default:
        break;
    }
  }

  private applyChatToMirror(message: SyncMessage): void {
    const mirror = this.options.mirror;
    if (!mirror) return;
    switch (message.type) {
      case 'chat/snapshot':
        mirror.applySnapshot(message.snapshots);
        break;
      case 'chat/append':
        mirror.applyAppend(message.conversationId, message.message);
        break;
      case 'chat/update':
        mirror.applyUpdate(message.conversationId, message.message);
        break;
      case 'chat/generation':
        mirror.applyGeneration(message.conversationId, message.generating);
        break;
      default:
        break;
    }
  }

  private publishFullState(): void {
    const { adapter, nav, drafts } = this.options;
    adapter.publish({ type: 'nav/state', origin: adapter.id, state: nav.snapshot() });
    adapter.publish({ type: 'chat/snapshot', origin: adapter.id, snapshots: this.snapshotAll() });
    for (const [conversationId, text] of Object.entries(drafts.snapshot())) {
      adapter.publish({ type: 'draft/set', origin: adapter.id, conversationId, text });
    }
  }

  private snapshotAll(): ConversationSnapshot[] {
    const service = this.options.service;
    if (!service) return [];
    return service
      .list()
      .map((summary) => service.get(summary.id))
      .filter((snapshot): snapshot is ConversationSnapshot => snapshot !== null);
  }
}
