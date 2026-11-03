/**
 * /ai/call、/ai/poll、/ai/result 的内存队列。
 * 宿主和调试服共用，避免回执语义分叉。
 *
 * result 是一次执行回执（accepted / 失败），一个 id 只留最新一份。
 * event 追加在同一个 id 上，给 action-done 的 start / end / interrupted。
 * GET 把已经到达的事件取走；结果还没到时也可以先把事件取走。
 *
 * P0 观测性：内嵌通道计数器（queueDepth / 累计入队 / 消费 / 丢弃 / 过期 /
 * 最老未消费年龄），通过 stats() 读取。现有 call/poll/post/read 的返回形状不变。
 *
 * P3 补充：totalTimeouts 计数「迟到回执」——result/event 晚于 call 发出 timeoutMs
 * 才到达的次数（timeoutMs > 0 启用；迟到回执仍照常写入，只计数不丢弃）。
 * P0 的 totalStale 只覆盖队列内未消费的 call，覆盖不到已被 poll 取走后的迟到回执。
 */

export function createAiInbox(options = {}) {
  const maxQueue = options.maxQueue || 32;
  const maxIds = options.maxIds || 64;
  const maxEventsPerId = options.maxEventsPerId || 16;
  // 未消费 call 超过 staleMs 记为过期（stats() 时惰性判定，不在热路径上扫描）
  const staleMs = options.staleMs != null ? Number(options.staleMs) : 30_000;
  // 迟到回执判定窗口；默认 0 = 不启用（与 P0 版行为完全一致）
  const timeoutMs = options.timeoutMs > 0 ? Number(options.timeoutMs) : 0;
  let seq = 0;
  const queue = [];
  const results = new Map();
  const events = new Map();
  const issued = new Map(); // id -> call 发出时刻（仅 timeoutMs 启用时记录，有界 maxIds）

  // ---- P0 计数器：只做数字自增，采样开销 O(1) ----
  const counters = {
    totalEnqueued: 0, // 累计入队 call 数
    totalConsumed: 0, // 累计被 poll 取走的 call 数
    totalDropped: 0, // 队列满被挤掉的 call 数（背压丢弃）
    totalStale: 0, // 累计判定过期的 call 数（入队后 staleMs 未消费）
    totalResultsPosted: 0,
    totalResultsRead: 0,
    totalResultsExpired: 0, // 结果未读就被 trim 挤掉
    totalEventsPosted: 0,
    totalEventsExpired: 0, // 事件未读就被 trim 挤掉
    totalTimeouts: 0, // P3：迟到回执次数（result/event 晚于 timeoutMs 到达）
  };
  let staleCheckedUpTo = 0; // 已累计过期的最大 id，避免重复计数

  function trim(map, expireKey) {
    while (map.size > maxIds) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
      if (expireKey) counters[expireKey]++;
    }
  }

  return {
    call(name, args) {
      const item = { id: ++seq, name, args: args || {}, ts: Date.now() };
      queue.push(item);
      while (queue.length > maxQueue) {
        queue.shift();
        counters.totalDropped++;
      }
      counters.totalEnqueued++;
      if (timeoutMs) {
        issued.set(item.id, item.ts);
        trim(issued);
      }
      return { ok: true, id: item.id, queued: queue.length };
    },

    poll() {
      const calls = queue.splice(0, queue.length);
      counters.totalConsumed += calls.length;
      return { calls };
    },

    post(body) {
      const id = Number(body && body.id);
      if (!id) return { ok: false, reason: 'id required' };
      if (timeoutMs && issued.has(id) && Date.now() - issued.get(id) > timeoutMs) {
        counters.totalTimeouts++;
      }
      if (body.event) {
        const list = events.get(id) || [];
        list.push(body.event);
        counters.totalEventsPosted++;
        while (list.length > maxEventsPerId) {
          list.shift();
          counters.totalEventsExpired++;
        }
        events.set(id, list);
        trim(events, 'totalEventsExpired');
      }
      if (body.result !== undefined && body.event === undefined) {
        results.set(id, body.result || { ok: false, reason: 'empty' });
        counters.totalResultsPosted++;
        trim(results, 'totalResultsExpired');
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
        counters.totalResultsRead++;
        const payload = { ready: true, result };
        if (drained.length) payload.events = drained;
        return payload;
      }
      if (drained.length) return { ready: false, events: drained };
      return { ready: false };
    },

    /**
     * P0 通道计数读数。now 可注入（测试用）。
     * - queueDepth：当前未消费 call 数；
     * - oldestPendingAgeMs：最老未消费 call 的年龄（空队列 0）；
     * - stalePending：当前队列里已超过 staleMs 的 call 数（同时累计进 totalStale，不重复计）。
     */
    stats(now = Date.now()) {
      const queueDepth = queue.length;
      const oldestPendingAgeMs = queueDepth ? now - queue[0].ts : 0;
      let stalePending = 0;
      for (const item of queue) {
        if (item.id > staleCheckedUpTo && now - item.ts > staleMs) {
          counters.totalStale++;
          staleCheckedUpTo = item.id;
        }
        if (now - item.ts > staleMs) stalePending++;
      }
      return {
        queueDepth,
        oldestPendingAgeMs,
        staleMs,
        stalePending,
        seq,
        ...counters,
      };
    },
  };
}
