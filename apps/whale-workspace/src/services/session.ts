/**
 * ChatSessionController —— 把「导航 / 草稿 / 会话」粘在一起的应用服务。
 *
 * 它不持有任何重复状态：会话内容来自 ConversationService，视图与当前会话来自
 * WorkspaceNavigationService，草稿来自 ChatDraftStore。切换视图不会重建会话，
 * 也不会取消生成（服务端生成不感知视图）。
 */
import type { ConversationService } from './conversation.ts';
import type { ChatDraftStore } from './drafts.ts';
import type { WorkspaceNavigationService } from './navigation.ts';
import type { WorkspaceView } from './types.ts';

export interface ChatSessionOptions {
  readonly nav: WorkspaceNavigationService;
  readonly drafts: ChatDraftStore;
  readonly service: ConversationService;
}

export class ChatSessionController {
  private readonly nav: WorkspaceNavigationService;
  private readonly drafts: ChatDraftStore;
  private readonly service: ConversationService;
  private readonly unsubscribeService: () => void;

  constructor(options: ChatSessionOptions) {
    this.nav = options.nav;
    this.drafts = options.drafts;
    this.service = options.service;
    // 未读只在「生成落地且当前视图看不到该会话」时累计。
    this.unsubscribeService = this.service.subscribe((event) => {
      if (event.type === 'message-settled') this.nav.noteAssistantMessage(event.conversationId);
    });
  }

  get conversationId(): string {
    return this.nav.state.conversationId;
  }

  get view(): WorkspaceView {
    return this.nav.state.view;
  }

  openWorkspace(conversationId?: string): void {
    this.nav.openWorkspace(conversationId);
  }

  openCapsule(conversationId?: string): void {
    this.nav.openCapsule(conversationId);
  }

  hideCapsule(): void {
    this.nav.hideCapsule();
  }

  switchConversation(conversationId: string): void {
    this.nav.switchConversation(conversationId);
  }

  currentDraft(): string {
    return this.drafts.get(this.conversationId);
  }

  /** 输入框永远把内容写到「写入这一刻」的会话上，避免切换后串稿 */
  updateDraft(text: string): void {
    this.drafts.set(this.nav.state.conversationId, text);
  }

  async sendCurrent(): Promise<boolean> {
    const conversationId = this.nav.state.conversationId;
    const text = this.drafts.get(conversationId).trim();
    if (!text) return false;
    this.drafts.clear(conversationId);
    try {
      await this.service.sendMessage(conversationId, text);
      return true;
    } catch (error) {
      // 发送失败把原文还给原会话，不影响其它会话草稿
      if (!this.drafts.has(conversationId)) this.drafts.set(conversationId, text);
      throw error;
    }
  }

  dispose(): void {
    this.unsubscribeService();
  }
}
