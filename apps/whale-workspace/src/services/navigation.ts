/**
 * WorkspaceNavigationService —— 全应用唯一的导航状态源。
 *
 * 约束（需求书硬性要求）：
 *   - ChatCapsule 与 Workspace 不允许各自维护 conversationId；
 *   - 两个视图读的都是这一份 state，切换视图不改写会话内容；
 *   - hideCapsule() 只隐藏胶囊，不删除会话、不停止生成。
 */
import type { NavigationState, WorkspaceView } from './types.ts';

export type NavigationListener = (state: NavigationState) => void;

export interface NavigationService {
  readonly state: Readonly<NavigationState>;
  subscribe(listener: NavigationListener): () => void;
  openWorkspace(conversationId?: string): void;
  openCapsule(conversationId?: string): void;
  hideCapsule(): void;
  switchConversation(conversationId: string): void;
  markConversationRead(conversationId: string): void;
  /** 助手消息落地时调用：当前不可见则累计未读 */
  noteAssistantMessage(conversationId: string): void;
  isConversationVisible(conversationId?: string): boolean;
  unreadOf(conversationId: string): number;
  /** 跨窗口合并：仅接受更高 revision，避免回声覆盖 */
  applyRemoteState(state: NavigationState, options?: { acceptEqual?: boolean }): boolean;
  snapshot(): NavigationState;
}

function freeze(state: NavigationState): NavigationState {
  return Object.freeze({
    ...state,
    unread: Object.freeze({ ...state.unread }),
  });
}

export class WorkspaceNavigationService implements NavigationService {
  private current: NavigationState;
  private readonly listeners = new Set<NavigationListener>();

  constructor(initialConversationId: string, view: WorkspaceView = 'workspace') {
    this.current = freeze({
      view,
      conversationId: initialConversationId,
      capsuleVisible: view === 'capsule',
      unread: {},
      revision: 1,
    });
  }

  get state(): Readonly<NavigationState> {
    return this.current;
  }

  snapshot(): NavigationState {
    return this.current;
  }

  subscribe(listener: NavigationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  openWorkspace(conversationId?: string): void {
    const target = conversationId ?? this.current.conversationId;
    this.commit({
      view: 'workspace',
      capsuleVisible: false,
      conversationId: target,
      unread: this.clearedUnread(target),
    });
  }

  openCapsule(conversationId?: string): void {
    const target = conversationId ?? this.current.conversationId;
    this.commit({
      view: 'capsule',
      capsuleVisible: true,
      conversationId: target,
      unread: this.clearedUnread(target),
    });
  }

  hideCapsule(): void {
    if (!this.current.capsuleVisible) return;
    // view 保持 capsule：角色旁只剩收起后的入口，不自动弹工作区。
    this.commit({ capsuleVisible: false });
  }

  switchConversation(conversationId: string): void {
    if (!conversationId) throw new Error('switchConversation: conversationId 不能为空');
    if (conversationId === this.current.conversationId) {
      this.markConversationRead(conversationId);
      return;
    }
    this.commit({
      conversationId,
      unread: this.clearedUnread(conversationId),
    });
  }

  markConversationRead(conversationId: string): void {
    if (this.unreadOf(conversationId) === 0) return;
    this.commit({ unread: this.clearedUnread(conversationId) });
  }

  noteAssistantMessage(conversationId: string): void {
    if (this.isConversationVisible(conversationId)) return;
    const current = this.unreadOf(conversationId);
    this.commit({ unread: { ...this.current.unread, [conversationId]: current + 1 } });
  }

  isConversationVisible(conversationId = this.current.conversationId): boolean {
    if (conversationId !== this.current.conversationId) return false;
    return this.current.view === 'workspace' || this.current.capsuleVisible;
  }

  unreadOf(conversationId: string): number {
    return this.current.unread[conversationId] ?? 0;
  }

  applyRemoteState(state: NavigationState, options?: { acceptEqual?: boolean }): boolean {
    if (!state || typeof state.revision !== 'number') return false;
    if (state.revision < this.current.revision) return false;
    // 并发同 revision：由调用方按 origin 字典序裁决后传入 acceptEqual，保证两侧选出同一个赢家
    if (state.revision === this.current.revision && options?.acceptEqual !== true) return false;
    this.current = freeze({
      view: state.view === 'capsule' ? 'capsule' : 'workspace',
      conversationId: state.conversationId,
      capsuleVisible: state.capsuleVisible === true,
      unread: { ...state.unread },
      revision: state.revision,
    });
    this.emit();
    return true;
  }

  private clearedUnread(conversationId: string): Record<string, number> {
    const next: Record<string, number> = { ...this.current.unread };
    delete next[conversationId];
    return next;
  }

  private commit(patch: Partial<NavigationState>): void {
    this.current = freeze({
      ...this.current,
      ...patch,
      revision: this.current.revision + 1,
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.current);
  }
}
