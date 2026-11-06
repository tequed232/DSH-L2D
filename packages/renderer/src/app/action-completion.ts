/**
 * 真实完成事件总线（PR-D，PRD-RUNTIME-EVENT）。
 *
 * 裁决书「不得预估时长」：motion / keyframes 的完成信号必须来自运行时真实终点
 * （Cubism motion 的 onFinishedMotionHandler / kfTick 的 elapsed>=kfDuration 收敛），
 * 不得用 lifeMs / motionStopTimer 时长预估充当完成。
 *
 * 事件在此汇聚，overlay 经 window.DSH_L2D.onActionCompletion 订阅后按 executionId
 * （= /ai/call 的 callId）转发到 ai-inbox 事件通道，HttpActionExecutor 消费。
 * 纯逻辑模块：node:assert 形态单测直接 import 源码，不需要浏览器实例。
 */

export type CompletionKind = 'motion' | 'keyframes';

export interface ActionCompletionEvent {
  kind: CompletionKind;
  /** /ai/call 的 callId（字符串化）；缺失时事件不产生（无消费者可关联） */
  executionId: string;
  /** motion 组名；keyframes 为空串 */
  group: string;
  /**
   * 三态生命周期（PR-A）：end = 自然播完；interrupted = 被显式停止/抢占；
   * failed = 执行失败（如 start-rejected）。不得统一当作 completed。
   */
  phase: 'end' | 'interrupted' | 'failed';
  /** 失败/中断根因（failed/interrupted 时尽量携带，如 'start-rejected' / 'stop-called'） */
  reason?: string;
  /** 完成时刻仍被 Agent 认领的物理输出（ownership 出口核对用） */
  owned: string[];
}

export type CompletionListener = (event: ActionCompletionEvent) => void;

export interface CompletionBus {
  subscribe(cb: CompletionListener): () => void;
  emit(event: ActionCompletionEvent): void;
  listenerCount(): number;
}

export function createCompletionBus(): CompletionBus {
  const listeners = new Set<CompletionListener>();
  return {
    subscribe(cb: CompletionListener): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(event: ActionCompletionEvent): void {
      // 快照后派发：监听方在回调里退订不影响本次遍历
      for (const cb of [...listeners]) {
        try {
          cb(event);
        } catch {
          /* 监听方异常不反噬渲染循环 */
        }
      }
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}
