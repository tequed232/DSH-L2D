/**
 * Whale Workspace 领域类型
 *
 * 这一层不依赖 DOM / Vue，可在 node --experimental-strip-types 下直接单测。
 */

export type WorkspaceView = 'workspace' | 'capsule';
export type ChatRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'done' | 'error';

/** 后端模式：本仓没有真实聊天后端，内存实现只用于 UI 与连续性验证。 */
export type BackendMode = 'memory-mock';

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: number;
  readonly status: MessageStatus;
}

export interface ConversationSnapshot {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ChatMessage[];
  readonly generating: boolean;
  readonly updatedAt: number;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface NavigationState {
  readonly view: WorkspaceView;
  readonly conversationId: string;
  readonly capsuleVisible: boolean;
  /** conversationId → 未读条数（仅统计助手消息） */
  readonly unread: Readonly<Record<string, number>>;
  /** 单调递增，用于跨窗口 last-writer-wins 合并 */
  readonly revision: number;
}
