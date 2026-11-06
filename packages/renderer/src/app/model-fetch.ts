/**
 * P0 修复（模型加载失败）：统一模型资源请求。
 *
 * 旧 loadAssets 直接 `fetch().then(arrayBuffer)`：
 *  - 不检查 response.ok —— 404 返回的错误页 HTML 被当成 model3.json 解析；
 *  - 无超时 —— 网络挂起时模型永久停在 Loading；
 *  - 失败只写日志 —— 上层（mount 的 waitForModel）无法感知，只能等 15s 超时。
 *
 * 这里收敛为单一入口：ok 检查 + 空体检查 + 超时 + fetchImpl 注入（node 单测可 stub）。
 * 调用方拿到 reject 后必须走 failLoad 通道向上传播，不允许静默吞错。
 */

export interface FetchedAsset {
  buffer: ArrayBuffer;
  byteLength: number;
}

export function fetchModelAsset(
  url: string,
  timeoutMs = 15000,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedAsset> {
  return new Promise((resolve, reject) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller && timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
            reject(new Error(`模型资源加载超时(${timeoutMs}ms): ${url}`));
          }, timeoutMs)
        : null;

    const finish = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      fn();
    };

    fetchImpl(url, {
      ...(controller ? { signal: controller.signal } : {}),
      cache: 'no-store',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`模型资源请求失败 HTTP ${response.status}: ${url}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (!buffer || buffer.byteLength === 0) {
          throw new Error(`模型资源为空(0 字节): ${url}`);
        }
        finish(() => resolve({ buffer, byteLength: buffer.byteLength }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(() => reject(new Error(message)));
      });
  });
}
