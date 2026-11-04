/**
 * 跨窗口通信适配器
 *
 * 审计结论（详见 docs/WHALE-WORKSPACE-AUDIT.md）：
 *   - 本仓没有独立 Chat 窗口；DSH 宿主聊天页不属于本仓。
 *   - 真实存在的第二个窗口只有 Electron pet 窗（packages/dsh-l2d-plugin/lib/pet-window.mjs），
 *     它加载同源 /dsh-l2d/pet.html，已有 IPC 通道只服务于光标/命中/拖动。
 *   - 因此默认用 BroadcastChannel（同源窗口天然可用，pet.html 与宿主页同源），
 *     Electron IPC 作为后续替身注入点（实现同一个接口即可）。
 *
 * 硬性约束：适配器只搬运事件，不持有权威消息状态；镜像窗口不得自行发模型请求，
 * 必须把 send-request 交给权威端去重后执行。
 */
import type { ChatMessage, ConversationSnapshot, NavigationState } from './types.ts';

export interface SyncEnvelope {
  readonly origin: string;
}

export type SyncMessage =
  | (SyncEnvelope & { readonly type: 'sync/request' })
  | (SyncEnvelope & { readonly type: 'nav/state'; readonly state: NavigationState })
  | (SyncEnvelope & { readonly type: 'draft/set'; readonly conversationId: string; readonly text: string })
  | (SyncEnvelope & { readonly type: 'chat/snapshot'; readonly snapshots: readonly ConversationSnapshot[] })
  | (SyncEnvelope & { readonly type: 'chat/append'; readonly conversationId: string; readonly message: ChatMessage })
  | (SyncEnvelope & { readonly type: 'chat/update'; readonly conversationId: string; readonly message: ChatMessage })
  | (SyncEnvelope & { readonly type: 'chat/generation'; readonly conversationId: string; readonly generating: boolean })
  | (SyncEnvelope & {
      readonly type: 'chat/send-request';
      readonly requestId: string;
      readonly conversationId: string;
      readonly text: string;
    });

export type SyncListener = (message: SyncMessage) => void;

export interface CrossWindowAdapter {
  readonly id: string;
  readonly channelName: string;
  start(): void;
  stop(): void;
  publish(message: SyncMessage): void;
  subscribe(listener: SyncListener): () => void;
}

let adapterSeq = 0;
export function nextAdapterId(prefix: string): string {
  adapterSeq += 1;
  return `${prefix}-${adapterSeq}`;
}

function assertEnvelope(message: SyncMessage): void {
  if (!message || typeof message !== 'object' || typeof (message as SyncMessage).type !== 'string') {
    throw new Error('SyncMessage 结构非法');
  }
}

export class BroadcastChannelAdapter implements CrossWindowAdapter {
  readonly id: string;
  readonly channelName: string;
  private channel: BroadcastChannel | null = null;
  private readonly listeners = new Set<SyncListener>();

  constructor(channelName = 'dsh-l2d:whale-workspace', id?: string) {
    this.channelName = channelName;
    this.id = id ?? nextAdapterId('bc');
  }

  start(): void {
    if (this.channel) return;
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('当前环境没有 BroadcastChannel，请注入其他 CrossWindowAdapter 实现');
    }
    const channel = new BroadcastChannel(this.channelName);
    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const message = event.data;
      if (!message) return;
      // 兜底：同源窗口各自的 adapter id 不同，丢弃自己发出的回声
      if (message.origin === this.id) return;
      for (const listener of [...this.listeners]) listener(message);
    };
    this.channel = channel;
  }

  stop(): void {
    if (!this.channel) return;
    this.channel.onmessage = null;
    this.channel.close();
    this.channel = null;
  }

  publish(message: SyncMessage): void {
    assertEnvelope(message);
    if (!this.channel) return;
    this.channel.postMessage({ ...message, origin: this.id });
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * 测试替身 / 无 BroadcastChannel 环境兜底：同 channelName 的实例共享一个进程内总线。
 * 语义刻意与 BroadcastChannel 对齐——异步投递、不回声给发送者。
 */
export class LoopbackAdapter implements CrossWindowAdapter {
  private static readonly buses = new Map<string, Set<LoopbackAdapter>>();

  readonly id: string;
  readonly channelName: string;
  private readonly listeners = new Set<SyncListener>();
  private joined = false;

  constructor(channelName = 'dsh-l2d:whale-workspace', id?: string) {
    this.channelName = channelName;
    this.id = id ?? nextAdapterId('loop');
  }

  start(): void {
    if (this.joined) return;
    const bus = LoopbackAdapter.buses.get(this.channelName) ?? new Set<LoopbackAdapter>();
    bus.add(this);
    LoopbackAdapter.buses.set(this.channelName, bus);
    this.joined = true;
  }

  stop(): void {
    const bus = LoopbackAdapter.buses.get(this.channelName);
    bus?.delete(this);
    this.joined = false;
  }

  publish(message: SyncMessage): void {
    assertEnvelope(message);
    const bus = LoopbackAdapter.buses.get(this.channelName);
    if (!bus) return;
    const payload: SyncMessage = { ...message, origin: this.id };
    for (const peer of [...bus]) {
      if (peer === this) continue;
      queueMicrotask(() => {
        for (const listener of [...peer.listeners]) listener(payload);
      });
    }
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
