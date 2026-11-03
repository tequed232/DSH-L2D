/**
 * P2 · WebGL context lost/restored 恢复处理。
 *
 * 挂在渲染 canvas 上：
 *   - webglcontextlost：preventDefault()（否则浏览器不会派发 restored），
 *     记录诊断信息并通知上层停渲染循环——失效句柄（纹理/缓冲/shader）
 *     一律不保留，由上层整树销毁。
 *   - webglcontextrestored：通知上层重建资源并恢复渲染。
 *
 * 只做监听与状态记录，不持有任何 GL 对象引用，因此不会保留失效句柄。
 * 实现面向 EventTarget，Node（EventTarget + Event）即可做逻辑测试。
 */

/** 诊断快照 */
export interface WebglLostInfo {
  /** event.statusMessage（部分环境为空串） */
  message: string;
  /** 触发时间戳（Date.now()） */
  at: number;
}

export interface WebglRecoveryCallbacks {
  /** context lost：上层应停渲染循环并销毁/放弃全部 GL 资源 */
  onLost?: (info: WebglLostInfo) => void;
  /** context restored：上层应重建资源并恢复渲染 */
  onRestored?: () => void;
}

export interface WebglRecoveryHandle {
  /** 移除监听（destroy 时调用，防止重复挂接/泄漏） */
  detach(): void;
  /** 当前是否处于 lost 状态 */
  isLost(): boolean;
  /** 最近一次 lost 诊断；未发生过为 null */
  lastLost(): WebglLostInfo | null;
}

/** canvas 只需要事件能力，便于在 Node 里用 EventTarget 测试 */
interface EventTargetLike {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions | boolean,
  ): unknown;
  removeEventListener(type: string, listener: (event: Event) => void): unknown;
}

export function attachWebglRecovery(
  target: EventTargetLike,
  callbacks: WebglRecoveryCallbacks = {},
): WebglRecoveryHandle {
  let lost = false;
  let lastLostInfo: WebglLostInfo | null = null;
  let detached = false;

  const onContextLost = (event: Event): void => {
    // 必须阻止默认行为，否则浏览器不会派发 webglcontextrestored
    event.preventDefault();
    if (lost) return; // 重复派发只记第一次
    lost = true;
    const status = (event as { statusMessage?: string }).statusMessage;
    lastLostInfo = { message: typeof status === 'string' ? status : '', at: Date.now() };
    try {
      callbacks.onLost?.(lastLostInfo);
    } catch {
      /* 回调异常不影响事件处理 */
    }
  };

  const onContextRestored = (): void => {
    if (!lost) return; // 没经过 lost 的 restored 不当作恢复
    lost = false;
    try {
      callbacks.onRestored?.();
    } catch {
      /* 回调异常不影响事件处理 */
    }
  };

  target.addEventListener('webglcontextlost', onContextLost, { passive: false });
  target.addEventListener('webglcontextrestored', onContextRestored);

  return {
    detach(): void {
      if (detached) return;
      detached = true;
      target.removeEventListener('webglcontextlost', onContextLost);
      target.removeEventListener('webglcontextrestored', onContextRestored);
    },
    isLost(): boolean {
      return lost;
    },
    lastLost(): WebglLostInfo | null {
      return lastLostInfo;
    },
  };
}
