/**
 * MCP 工具调用的 HTTP 转发核心（#31：统一截止时间覆盖全部 HTTP 边界）。
 *
 * 修复前：配置的 timeoutMs 只约束「结果轮询循环」的间隔检查；入队 POST 没有请求级
 * 超时，挂住的 /ai/result 响应体读取也会让循环里的截止时间检查永远走不到——总耗时
 * 可以远超预算，且第一份迟到回执仍会被误报为成功。
 *
 * 现在的语义：
 *  - deadline = 调用起点 + timeoutMs，统一约束入队 POST（连接/响应头/响应体读取）、
 *    结果 GET 与响应体读取（经 AbortSignal 在剩余预算内硬性中止）；
 *  - 请求已入队但预算内未拿到终态：返回 reason='timeout' 并保留可查询标识 id
 *    （及已累计 events），客户端可凭 id 查询终态，避免误重放；
 *  - 入队 POST 网络层失败（非截止中止）仍报 'unreachable'，由调用方清缓存地址。
 */
import { actSettled, mergeActEvents, shapeActReceipt } from './act-result.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isDeadlineAbort(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** 在 deadline 剩余预算内发起 fetch；signal 同时约束连接与响应体读取。 */
async function fetchWithDeadline(url, init, deadline, fetchImpl) {
  const ctrl = new AbortController();
  const remaining = deadline - Date.now();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('deadline-exceeded', 'TimeoutError')),
    Math.max(1, remaining),
  );
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'empty' };
  if (result.ok === false && !result.reason && result.error) {
    return { ...result, reason: String(result.error) };
  }
  return result;
}

/**
 * @param {object} opts
 * @param {string} opts.base 宿主根地址（不含 /dsh-l2d 路径）
 * @param {string} opts.name MCP 工具名（转发的 call name）
 * @param {object} [opts.args] 工具参数
 * @param {number} opts.timeoutMs 总预算（含入队 POST 与结果轮询）
 * @param {'act'|undefined} [opts.mode] act 模式：accepted 后等终态事件
 * @param {typeof fetch} [opts.fetchImpl] 注入（缺省全局 fetch）
 * @param {number} [opts.pollIntervalMs=120] 结果轮询间隔
 * @returns {Promise<object>} 与既有 forward 返回形态兼容；timeout 时带 id/events
 */
export async function forwardCall({
  base,
  name,
  args,
  timeoutMs,
  mode,
  fetchImpl = (...a) => fetch(...a),
  pollIntervalMs = 120,
}) {
  const deadline = Date.now() + timeoutMs;

  // ---- 入队 POST（受同一截止时间约束）----
  let queued;
  try {
    const res = await fetchWithDeadline(
      base + '/dsh-l2d/ai/call',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args: args || {} }),
      },
      deadline,
      fetchImpl,
    );
    // 守卫拒绝的 4xx 是 text/plain（如 "reserved-param: ParamMouthOpenY"），
    // 先 res.json() 会抛 SyntaxError 掉进 catch，被误报成 unreachable 并清掉缓存地址。
    // 正确顺序：先读文本 → 尽力解析 → 再看状态码。
    const text = await res.text();
    try {
      queued = text ? JSON.parse(text) : null;
    } catch {
      queued = { ok: false, reason: text.slice(0, 200) || 'call-rejected' };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: (queued && (queued.reason || queued.error)) || 'call-rejected',
        status: res.status,
      };
    }
    if (!queued || queued.ok === false) {
      return { ok: false, reason: (queued && (queued.reason || queued.error)) || 'call-rejected' };
    }
  } catch (err) {
    // 截止中止 ≠ 网络层失败：请求可能已被宿主受理但响应没回来，如实报 timeout
    if (isDeadlineAbort(err)) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'unreachable' };
  }

  const id = queued.id;
  let events = [];
  let acceptResult = null;
  while (Date.now() < deadline) {
    let res = null;
    try {
      res = await fetchWithDeadline(
        base + '/dsh-l2d/ai/result?id=' + encodeURIComponent(id),
        { cache: 'no-store' },
        deadline,
        fetchImpl,
      );
    } catch {
      /* 截止中止或瞬时失败：过截止由循环条件退出，否则下一轮再取 */
    }
    if (res && res.ok) {
      try {
        const body = await res.json();
        if (body && Array.isArray(body.events)) events = mergeActEvents(events, body.events);
        if (body && body.ready) {
          acceptResult = normalizeResult(body.result);
          if (acceptResult && Array.isArray(acceptResult.events)) {
            events = mergeActEvents(events, acceptResult.events);
          }
        }
        if (acceptResult) {
          const waitForTerminal = mode === 'act' && acceptResult.accepted === true;
          if (!waitForTerminal || actSettled(events, acceptResult.runId)) {
            return mode === 'act' ? shapeActReceipt(acceptResult, events) : acceptResult;
          }
        }
      } catch {
        /* 响应体读取被截止中止：走下一轮 / 退出 */
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
  }
  if (mode === 'act' && acceptResult && acceptResult.accepted === true) {
    // accepted 但终态未知：回执保留 pending 语义，附 id 供后续查询，不误报成功完成
    return { ...shapeActReceipt(acceptResult, events), id };
  }
  // 已入队、终态未知：保留可查询标识，明确等待超时，避免客户端误重放
  return { ok: false, reason: 'timeout', id, events };
}
