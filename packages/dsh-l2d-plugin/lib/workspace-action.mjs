/**
 * Workspace Action Channel —— 双向动作协议的插件侧封装。
 *
 * 复用而非重建：
 *   - 关联：requestId ↔ aiInbox callId（本模块维护映射，同一 requestId 重复提交在
 *     未完结前返回同一个 callId = 天然去重）；
 *   - 上下文：getSnapshot() 复用 W1 的 buildWorkspaceContextSnapshot；
 *   - 权限：每个动作过 guardAiCall（与 /ai/call 同一守卫）；
 *   - 状态：accepted(入队) → executing(start 事件) → completed/failed(执行回执)。
 */
import {
  validateWorkspaceActionRequest,
  validateWorkspaceActionResponse,
  deriveActionStatus,
  buildActionSummary,
  trimWorkspaceContext,
} from '../../core/src/workspace-protocol.ts';

export function createWorkspaceActionChannel(options = {}) {
  const {
    aiInbox,
    guardAiCall,
    getSnapshot,
    workspace = { id: 'dsh-l2d', name: 'DSH-L2D', type: 'development' },
    maxTracked = 128,
  } = options;
  if (!aiInbox) throw new Error('aiInbox required');
  if (typeof guardAiCall !== 'function') throw new Error('guardAiCall required');

  /** requestId → { callId, request, acceptedAt } */
  const tracked = new Map();

  function track(requestId, entry) {
    tracked.set(requestId, entry);
    while (tracked.size > maxTracked) tracked.delete(tracked.keys().next().value);
  }

  /**
   * 提交一个动作请求（信封）。返回 accepted 信封或 rejected 信封（都带 requestId）。
   * 重复 requestId：未完结时复用同一个 callId（去重）；已完结则生成新 callId。
   */
  function submit(request) {
    const errors = validateWorkspaceActionRequest(request);
    if (errors.length) {
      return envelope(request, 'rejected', { reason: 'invalid-request: ' + errors.join('; ') });
    }
    const requestId = request.requestId;
    const existing = tracked.get(requestId);
    if (existing && !existing.final) {
      return { ...envelope(request, 'accepted'), duplicate: true, callId: existing.callId };
    }

    // 权限校验：Agent/外部传入的动作与 /ai/call 走同一守卫（不能因为包了 JSON 就绕过）
    const actionName = request.action.name;
    let guarded;
    try {
      guarded = guardAiCall({ name: actionName, args: request.action.parameters || {} }, { index: options.modelIndex ? options.modelIndex() : null });
    } catch (err) {
      guarded = { ok: true, warnings: ['guard-error: ' + String((err && err.message) || err)] };
    }
    if (!guarded.ok) {
      return envelope(request, 'rejected', { reason: guarded.message || 'rejected-by-guard' });
    }

    const queued = aiInbox.call(actionName, request.action.parameters || {});
    track(requestId, { callId: queued.id, request, acceptedAt: Date.now() });
    return { ...envelope(request, 'accepted'), callId: queued.id, warnings: guarded.warnings || [] };
  }

  /** 读取响应信封：按 requestId 关联 callId，从回执 + 事件推导状态。 */
  function result(requestId) {
    const entry = tracked.get(requestId);
    if (!entry) return null;
    if (entry.final) return entry.final;
    // aiInbox.read 是破坏性读取（result/events 取走即删），只能调一次
    const read = aiInbox.read(entry.callId) || {};
    const events = read.events || [];
    const result = read.result || null;
    const st = deriveActionStatus({ queued: true, events, result });
    const receipt = result && result.ok !== undefined ? receiptLike(result) : null;
    const resp = envelope(entry.request, st.status, { reason: st.reason, receipt });
    resp.callId = entry.callId;
    // 终态缓存：accepted/executing 会被执行回执覆盖；completed/failed/rejected 定格
    if (st.status === 'completed' || st.status === 'failed' || st.status === 'rejected') entry.final = resp;
    return resp;
  }

  /** 把各工具的回执形状归一成 buildActionSummary 需要的字段。 */
  function receiptLike(result) {
    if (result && typeof result === 'object' && ('applied' in result || 'skipped' in result)) return result;
    return null;
  }

  function envelope(request, status, extra = {}) {
    const receipt = extra.receipt || null;
    const name = request ? request.action.name : '';
    // 摘要按状态生成：有结构化回执就给细节，简单回执（如 l2d_look_at）给状态级文案
    let summary;
    if (status === 'rejected') summary = `动作被拒绝：${extra.reason || '未通过权限校验'}。`;
    else if (status === 'failed') summary = `${name} 执行失败：${extra.reason || '未知原因'}。`;
    else if (status === 'executing') summary = `${name} 执行中…`;
    else if (status === 'accepted') summary = `${name} 已受理，等待执行结果。`;
    else summary = receipt ? buildActionSummary(receipt, name) : `${name} 已完成。`;
    const resp = {
      requestId: (request && request.requestId) || '',
      type: 'workspace.action.result',
      status,
      action: request ? { name: request.action.name, target: request.action.target, parameters: request.action.parameters } : { name: '' },
      summary,
    };
    if (status === 'failed' && extra.reason) resp.result = { success: false, message: extra.reason };
    if (status === 'completed') resp.result = { success: true, message: resp.summary };
    const errors = validateWorkspaceActionResponse(resp);
    if (errors.length) resp.__invalid = errors;
    return resp;
  }

  /** 供 workspace-agent 桥把上下文塞进提示词（精简版，限长）。 */
  function contextForPrompt(request) {
    const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : null;
    return trimWorkspaceContext(snapshot, workspace);
  }

  return { submit, result, contextForPrompt, _tracked: tracked };
}
