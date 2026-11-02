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
      while (queue.length > maxQueue) queue.shift();
      return { ok: true, id: item.id, queued: queue.length };
    },

    poll() {
      return { calls: queue.splice(0, queue.length) };
    },

    post(body) {
      const id = Number(body && body.id);
      if (!id) return { ok: false, reason: 'id required' };
      if (body.event) {
        const list = events.get(id) || [];
        list.push(body.event);
        while (list.length > maxEventsPerId) list.shift();
        events.set(id, list);
        trim(events);
      }
      if (body.result !== undefined && body.event === undefined) {
        results.set(id, body.result || { ok: false, reason: 'empty' });
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
