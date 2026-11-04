/**
 * InMemoryConversationService —— ⚠️ MOCK 实现（memory-mock）
 *
 * 用途：在没有真实聊天后端的前提下，验证两条产品要求：
 *   1. 同一 conversationId 在 workspace / capsule 两个视图里读到同一份消息；
 *   2. 流式生成过程中切换视图不会中断生成。
 *
 * 明确不做：不发起任何网络/模型请求，不持久化，不跨进程同步。
 * 权威性：进程内单例由 ConversationAuthority 保证，重复声明会抛错。
 */
import {
  ConversationOwnershipError,
  EmptyMessageError,
  UnknownConversationError,
  mockReplyFor,
  type ConversationEvent,
  type ConversationListener,
  type ConversationService,
  type SendMessageOptions,
} from './conversation.ts';
import type {
  ChatMessage,
  ConversationSnapshot,
  ConversationSummary,
} from './types.ts';

export interface InMemoryConversationOptions {
  readonly owner?: string;
  /** 每个分片的间隔；测试可调到 1ms */
  readonly chunkDelayMs?: number;
  /** 每片字符数 */
  readonly chunkSize?: number;
  readonly replyFactory?: (text: string) => string;
  readonly seedGreeting?: boolean;
  /** 注入时钟，便于测试确定性推进 */
  readonly now?: () => number;
}

interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  generating: boolean;
}

export class InMemoryConversationService implements ConversationService {
  readonly mode = 'memory-mock' as const;
  readonly owner: string;

  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly listeners = new Set<ConversationListener>();
  private readonly settledWaiters = new Map<string, Array<() => void>>();
  private readonly inflight = new Map<string, Promise<ChatMessage>>();
  private readonly chunkDelayMs: number;
  private readonly chunkSize: number;
  private readonly replyFactory: (text: string) => string;
  private readonly now: () => number;
  private seq = 0;
  private messageSeq = 0;

  constructor(options: InMemoryConversationOptions = {}) {
    this.owner = options.owner ?? 'whale-workspace';
    this.chunkDelayMs = Math.max(0, options.chunkDelayMs ?? 45);
    this.chunkSize = Math.max(1, options.chunkSize ?? 6);
    this.replyFactory = options.replyFactory ?? mockReplyFor;
    this.now = options.now ?? (() => Date.now());
    if (options.seedGreeting !== false) this.seed();
  }

  subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
      }));
  }

  get(conversationId: string): ConversationSnapshot | null {
    const record = this.conversations.get(conversationId);
    return record ? this.snapshotOf(record) : null;
  }

  create(title?: string): ConversationSnapshot {
    this.seq += 1;
    const id = `conv-${this.seq}`;
    const at = this.now();
    const record: ConversationRecord = {
      id,
      title: title?.trim() || `会话 ${this.seq}`,
      createdAt: at,
      updatedAt: at,
      messages: [],
      generating: false,
    };
    this.conversations.set(id, record);
    const snapshot = this.snapshotOf(record);
    this.emit({ type: 'created', conversationId: id, snapshot });
    return snapshot;
  }

  sendMessage(
    conversationId: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<ChatMessage> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.reject(new EmptyMessageError());

    const requestKey = options.requestId ? `${conversationId}:${options.requestId}` : '';
    if (requestKey) {
      const existing = this.inflight.get(requestKey);
      if (existing) return existing;
    }

    const record = this.conversations.get(conversationId);
    if (!record) return Promise.reject(new UnknownConversationError(conversationId));

    this.messageSeq += 1;
    const userMessage: ChatMessage = {
      id: `msg-${this.messageSeq}-u`,
      conversationId,
      role: 'user',
      text: trimmed,
      createdAt: this.now(),
      status: 'done',
    };
    this.messageSeq += 1;
    const replyId = `msg-${this.messageSeq}-a`;
    const assistantMessage: ChatMessage = {
      id: replyId,
      conversationId,
      role: 'assistant',
      text: '',
      createdAt: this.now(),
      status: 'streaming',
    };

    record.messages.push(userMessage, assistantMessage);
    record.updatedAt = this.now();
    this.emit({ type: 'message-added', conversationId, message: userMessage });
    this.emit({ type: 'message-added', conversationId, message: assistantMessage });
    record.generating = true;
    this.emit({ type: 'generation', conversationId, generating: true });

    const promise = this.streamInto(record, replyId, this.replyFactory(trimmed));
    if (requestKey) this.inflight.set(requestKey, promise);
    return promise;
  }

  isGenerating(conversationId: string): boolean {
    return this.conversations.get(conversationId)?.generating === true;
  }

  whenSettled(conversationId: string): Promise<void> {
    if (!this.isGenerating(conversationId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.settledWaiters.get(conversationId) ?? [];
      list.push(resolve);
      this.settledWaiters.set(conversationId, list);
    });
  }

  private streamInto(record: ConversationRecord, messageId: string, full: string): Promise<ChatMessage> {
    const chars = Array.from(full);
    let cursor = 0;

    return new Promise<ChatMessage>((resolve) => {
      const tick = () => {
        cursor = Math.min(chars.length, cursor + this.chunkSize);
        const text = chars.slice(0, cursor).join('');
        this.updateMessage(record, messageId, (prev) => ({ ...prev, text }));
        if (cursor < chars.length) {
          setTimeout(tick, this.chunkDelayMs);
          return;
        }
        const settled = this.updateMessage(record, messageId, (prev) => ({ ...prev, status: 'done' }));
        record.generating = false;
        record.updatedAt = this.now();
        this.emit({ type: 'generation', conversationId: record.id, generating: false });
        this.emit({ type: 'message-settled', conversationId: record.id, message: settled });
        this.flushSettled(record.id);
        resolve(settled);
      };
      setTimeout(tick, this.chunkDelayMs);
    });
  }

  private updateMessage(
    record: ConversationRecord,
    messageId: string,
    patch: (prev: ChatMessage) => ChatMessage,
  ): ChatMessage {
    const index = record.messages.findIndex((m) => m.id === messageId);
    if (index < 0) throw new Error(`消息不存在：${messageId}`);
    const next = patch(record.messages[index]!);
    record.messages[index] = next;
    this.emit({ type: 'message-updated', conversationId: record.id, message: next });
    return next;
  }

  private flushSettled(conversationId: string): void {
    for (const key of [...this.inflight.keys()]) {
      if (key.startsWith(`${conversationId}:`)) this.inflight.delete(key);
    }
    const waiters = this.settledWaiters.get(conversationId);
    if (!waiters) return;
    this.settledWaiters.delete(conversationId);
    for (const waiter of waiters) waiter();
  }

  private snapshotOf(record: ConversationRecord): ConversationSnapshot {
    return {
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      generating: record.generating,
      messages: record.messages.map((m) => ({ ...m })),
    };
  }

  private seed(): void {
    this.seq += 1;
    const at = this.now();
    const id = `conv-${this.seq}`;
    const record: ConversationRecord = {
      id,
      title: '和鲸鱼娘的第一次聊天',
      createdAt: at,
      updatedAt: at,
      messages: [],
      generating: false,
    };
    this.messageSeq += 1;
    record.messages.push({
      id: `msg-${this.messageSeq}-a`,
      conversationId: id,
      role: 'assistant',
      text: '嗨，我是这条鲸鱼娘。工作区和胶囊是同一段对话的两个入口，随时切换都不会丢消息。',
      createdAt: at,
      status: 'done',
    });
    this.conversations.set(id, record);
    this.emit({ type: 'created', conversationId: id, snapshot: this.snapshotOf(record) });
  }

  private emit(event: ConversationEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/**
 * 会话权威的进程内单例 + 所有权检查。
 *
 * 任何第二个窗口如果想「自己再建一个权威服务」，必须走 claim()，会拿到
 * ConversationOwnershipError —— 从机制上杜绝双份权威消息状态。
 */
export class ConversationAuthority {
  private static holder: ConversationAuthority | null = null;
  private released = false;

  readonly owner: string;
  readonly service: InMemoryConversationService;

  private constructor(owner: string, service: InMemoryConversationService) {
    this.owner = owner;
    this.service = service;
  }

  static current(): ConversationAuthority | null {
    return ConversationAuthority.holder;
  }

  static claim(owner: string, options: InMemoryConversationOptions = {}): ConversationAuthority {
    const holder = ConversationAuthority.holder;
    if (holder && !holder.released) throw new ConversationOwnershipError(owner, holder.owner);
    const service = new InMemoryConversationService({ ...options, owner });
    const authority = new ConversationAuthority(owner, service);
    ConversationAuthority.holder = authority;
    return authority;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (ConversationAuthority.holder === this) ConversationAuthority.holder = null;
  }
}
