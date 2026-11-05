/**
 * /ai/call、/ai/poll、/ai/result 的内存队列。
 * 宿主和调试服共用，避免回执语义分叉。
 *
 * result 是一次执行回执（accepted / 失败），一个 id 只留最新一份。
 * event 追加在同一个 id 上，给 action-done 的 start / end / interrupted。
 * GET 把已经到达的事件取走；结果还没到时也可以先把事件取走。
 */

export function createAiInbox(options = {}) {
  const maxQueue = options.maxQueue || 32;
  const maxIds = options.maxIds || 64;
  const maxEventsPerId = options.maxEventsPerId || 16;
  let seq = 0;
  const queue = [];
  const results = new Map();
  const events = new Map();

  function trim(map) {
    while (map.size > maxIds) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  return {
    call(name, args) {
      const item = { id: ++seq, name, args: args || {}, ts: Date.now() };
      queue.push(item);
      let dropped = 0;
      while (queue.length > maxQueue) { queue.shift(); dropped++; }
      // 溢出必须显式反馈：静默丢弃会让调用方拿着 ok:true 的 id 永远等不到结果。
      return dropped ? { ok: true, id: item.id, queued: queue.length, dropped } : { ok: true, id: item.id, queued: queue.length };
    },

    poll() {
      return { calls: queue.splice(0, queue.length) };
    },

    post(body) {
      const id = Number(body && body.id);
      if (!id) return { ok: false, reason: 'id required' };
      const hasEvent = body.event !== undefined;
      const hasResult = body.result !== undefined;
      if (!hasEvent && !hasResult) return { ok: false, reason: 'event or result required' };
      // event 与 result 允许同一条 post：分开处理，互不挤占。
      if (hasEvent) {
        const list = events.get(id) || [];
        list.push(body.event);
        while (list.length > maxEventsPerId) list.shift();
        events.set(id, list);
        trim(events);
      }
      if (hasResult) {
        // 仅 undefined/null 视为空结果；false/0 等合法 falsy 值原样保留。
        results.set(id, body.result ?? { ok: false, reason: 'empty' });
        trim(results);
      }
      return { ok: true };
    },

    read(id) {
      const key = Number(id);
      const pending = events.get(key);
      const drained = pending && pending.length ? pending.splice(0, pending.length) : [];
      if (!pending || pending.length === 0) events.delete(key);
      if (results.has(key)) {
        const result = results.get(key);
        results.delete(key);
        const payload = { ready: true, result };
        if (drained.length) payload.events = drained;
        return payload;
      }
      if (drained.length) return { ready: false, events: drained };
      return { ready: false };
    },
  };
}
