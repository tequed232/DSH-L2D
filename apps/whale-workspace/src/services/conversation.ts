/**
 * ConversationService —— 会话数据的唯一权威。
 *
 * 本仓没有真实聊天后端（DSH 宿主聊天页不归本仓所有），所以这里只定义接口，
 * 并提供一个内存实现用于 UI 与「会话连续性」验证。
 *
 * ⚠️ InMemoryConversationService 是 MOCK：不联网、不调模型、回复文本由固定模板
 *    流式吐出。任何文档/界面都不得把它描述成真实模型能力。
 */
import type {
  BackendMode,
  ChatMessage,
  ConversationSnapshot,
  ConversationSummary,
} from './types.ts';

export type ConversationEvent =
  | { readonly type: 'created'; readonly conversationId: string; readonly snapshot: ConversationSnapshot }
  | { readonly type: 'message-added'; readonly conversationId: string; readonly message: ChatMessage }
  | { readonly type: 'message-updated'; readonly conversationId: string; readonly message: ChatMessage }
  | { readonly type: 'message-settled'; readonly conversationId: string; readonly message: ChatMessage }
  | { readonly type: 'generation'; readonly conversationId: string; readonly generating: boolean };

export type ConversationListener = (event: ConversationEvent) => void;

export interface SendMessageOptions {
  /** 同一个 requestId 只发起一次生成（跨窗口转发的幂等键） */
  readonly requestId?: string;
}

export interface ConversationService {
  readonly mode: BackendMode;
  subscribe(listener: ConversationListener): () => void;
  list(): ConversationSummary[];
  get(conversationId: string): ConversationSnapshot | null;
  create(title?: string): ConversationSnapshot;
  sendMessage(conversationId: string, text: string, options?: SendMessageOptions): Promise<ChatMessage>;
  isGenerating(conversationId: string): boolean;
  /** 生成结束（或当前没有生成）时 resolve */
  whenSettled(conversationId: string): Promise<void>;
}

export class UnknownConversationError extends Error {
  constructor(id: string) {
    super(`未知会话：${id}`);
    this.name = 'UnknownConversationError';
  }
}

export class EmptyMessageError extends Error {
  constructor() {
    super('消息内容为空');
    this.name = 'EmptyMessageError';
  }
}

export class ConversationOwnershipError extends Error {
  constructor(owner: string, holder: string) {
    super(`会话权威已被 ${holder} 持有，${owner} 不能重复声明`);
    this.name = 'ConversationOwnershipError';
  }
}

/** 默认回复模板：确定性、可断言，明确标注是模拟。 */
export function mockReplyFor(text: string): string {
  return (
    `收到：「${text}」。\n` +
    '（MOCK 回复：本仓未接真实模型后端，这段文字由 InMemoryConversationService 按固定模板流式吐出，' +
    '仅用于验证工作区与胶囊之间的会话连续性。）'
  );
}
