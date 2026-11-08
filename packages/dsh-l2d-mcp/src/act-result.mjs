/**
 * 把浏览器交回来的 accepted 回执和 action-done 事件拼成 MCP 要转发的那一份。
 * 不决定谁能打断谁，只整理已经发生的回执。
 */

export function actEventKey(event) {
  if (!event) return '';
  return String(event.type) + ':' + String(event.phase) + ':' + String(event.runId);
}

export function mergeActEvents(existing, incoming) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(out.map(actEventKey));
  for (const event of incoming || []) {
    if (!event || event.type !== 'action-done') continue;
    const key = actEventKey(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

export function actOutcome(result, events) {
  if (!result || result.accepted !== true) return 'rejected';
  const own = (events || []).filter((event) => event && event.runId === result.runId);
  // F3：failed 优先于 end/interrupted——避免「end+failed 并存」被误判为 completed。
  const failed = own.find((event) => event.phase === 'failed');
  if (failed) return 'failed';
  const terminal = own.find((event) => event.phase === 'end' || event.phase === 'interrupted');
  if (!terminal) return 'pending';
  return terminal.phase === 'end' ? 'completed' : 'interrupted';
}

export function actSettled(events, runId) {
  return (events || []).some(
    (event) => event && event.runId === runId &&
      (event.phase === 'end' || event.phase === 'interrupted' || event.phase === 'failed'),
  );
}

/**
 * accepted=true 只表示进了槽。
 * settled=true 才表示已经看到 end / interrupted / failed 终态。
 * 还在播时 ok 仍为 true，reason 为 pending，避免把「没播完」说成调用失败。
 */
export function shapeActReceipt(acceptResult, events) {
  const result = { ...(acceptResult || {}) };
  const own = (events || []).filter((event) => event && event.runId === result.runId);
  const outcome = actOutcome(result, own);
  if (result.accepted === true) {
    result.outcome = outcome;
    result.settled = outcome === 'completed' || outcome === 'interrupted' || outcome === 'failed';
    if (outcome === 'failed') {
      // F3：失败是终态且必须如实报失败，禁止 ok:true / completed + 失败 reason 的矛盾形状。
      result.ok = false;
      const failedEvent = own.find((event) => event && event.phase === 'failed');
      result.reason = (failedEvent && (failedEvent.reason || failedEvent.error)) ||
        (result.reason && result.reason !== 'pending' ? result.reason : 'failed');
    } else if (result.settled) {
      if (result.reason === 'pending') delete result.reason;
    } else {
      result.reason = 'pending';
    }
  } else {
    result.outcome = 'rejected';
    result.settled = false;
  }
  result.events = own;
  return result;
}
