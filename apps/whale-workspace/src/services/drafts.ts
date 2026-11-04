/**
 * ChatDraftStore —— 按 conversationId 隔离的草稿箱。
 *
 * 规则（需求书）：
 *   - 切换 workspace/capsule 保留草稿；
 *   - 切换会话时恢复目标会话的草稿，绝不串稿；
 *   - 发送成功后只清除「发送时那个会话」的草稿；
 *   - 关闭胶囊不删除草稿。
 *
 * 默认纯内存；如需跨刷新保留，可注入 storage 适配器（本应用未启用）。
 */
export interface DraftChange {
  readonly conversationId: string;
  readonly text: string;
}

export type DraftListener = (change: DraftChange) => void;

export interface DraftStorage {
  read(): Record<string, string>;
  write(all: Record<string, string>): void;
}

export class ChatDraftStore {
  private readonly drafts = new Map<string, string>();
  private readonly listeners = new Set<DraftListener>();
  private readonly storage: DraftStorage | null;

  constructor(storage: DraftStorage | null = null) {
    this.storage = storage;
    if (!storage) return;
    for (const [conversationId, text] of Object.entries(storage.read())) {
      if (text) this.drafts.set(conversationId, text);
    }
  }

  get(conversationId: string): string {
    return this.drafts.get(conversationId) ?? '';
  }

  has(conversationId: string): boolean {
    return (this.drafts.get(conversationId) ?? '').length > 0;
  }

  keys(): string[] {
    return [...this.drafts.keys()];
  }

  set(conversationId: string, text: string): void {
    if (!conversationId) throw new Error('setDraft: conversationId 不能为空');
    const current = this.drafts.get(conversationId) ?? '';
    if (current === text) return;
    if (text) this.drafts.set(conversationId, text);
    else this.drafts.delete(conversationId);
    this.persist();
    this.emit({ conversationId, text });
  }

  clear(conversationId: string): void {
    this.set(conversationId, '');
  }

  /** 应用远端草稿：不发事件，避免跨窗口回声 */
  applyRemote(conversationId: string, text: string): void {
    if (!conversationId) return;
    if ((this.drafts.get(conversationId) ?? '') === text) return;
    if (text) this.drafts.set(conversationId, text);
    else this.drafts.delete(conversationId);
    this.persist();
  }

  subscribe(listener: DraftListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.drafts);
  }

  private persist(): void {
    if (this.storage) this.storage.write(this.snapshot());
  }

  private emit(change: DraftChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
