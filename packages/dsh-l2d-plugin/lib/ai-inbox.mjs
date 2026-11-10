/**
 * /ai/call、/ai/poll、/ai/result 的内存队列。
 * 宿主和调试服共用，避免回执语义分叉。
 *
 * result 是一次执行回执（accepted / 失败），一个 id 只留最新一份。
 * event 追加在同一个 id 上，给 action-done 的 start / end / interrupted。
 * GET 把已经到达的事件取走；结果还没到时也可以先把事件取走。
 *
 * 消费者租约（M1-d3，flag consumerLeaseEnabled 默认关）：
 *   - /ai/poll 单消费者接管：同一时刻只有一个页面消费队列，杜绝多页瓜分；
 *   - /ai/result token fencing：回执必须携带 poll 时下发的 token，旧消费者重放被拒；
 *   - 接管时对未回执 call 写入 { ok:false, reason:'lease-taken-over' }，
 *     调用方 read 立刻拿到明确失败，不复活重排（重发决策归调用方）。
 * 全部租约状态收敛在本闭包内（队列与租约同原子域），不持久化、不新建模块。
 *
 * 指令派发租约（宿主默认开，TTL 3s）：
 *   - poll 带 consumerId（页面实例 id）与 foreground（document.visibilityState==='visible'）；
 *   - 同一时刻只有一个持有者；前台页面可抢占后台持有者的租约；持有者每次 poll 即心跳续期；
 *   - 过期后交给下一个来 poll 的页面；原持有者过期后回来、期间没人接手 → 原 token 续上，已领出的指令不受影响；
 *   - 未持有租约的 poll 返回空 calls 并带 reason:'no-lease'；
 *   - 租约转移时，已领出未回执的指令写入明确失败 { ok:false, reason:'lease-taken-over' }（不静默丢弃、
 *     也不重发——指令可能已在旧页执行到一半，重发决策归调用方）。
 *
 * 完成事件订阅（PR-D，issue #33）：宿主 HttpActionExecutor 的 subscribeEvents deps。
 * 观察者是旁路通知——post 落账（event / result）即推送，事件仍留在 events Map 供
 * GET /ai/result 排空读取，call/poll/post/read 语义零改动（nodegraphExecutor 等
 * 轮询消费者不受影响）。subscribeCompletion 是 action-done 终态等待器：
 *   - event 通道 end / interrupted / failed → resolve 终态（executor 订阅路径直接返回）；
 *   - result 通道拒绝（ok:false，拒绝回执无 event）→ resolve(null)，executor 落轮询
 *     即时拿到拒绝，不等 deadline；
 *   - signal abort / deadline（缺省 30s，防 executor 无 signal 时订阅挂死）→ resolve(null)
 *     落轮询降级（fail-closed：订阅永远只是延迟优化，不是完成判定的唯一路径）。
 */

export function createAiInbox(options = {}) {
  const maxQueue = options.maxQueue || 32;
  const maxIds = options.maxIds || 64;
  const maxEventsPerId = options.maxEventsPerId || 16;
  // 租约参数：TTL 内未续期即视为断连；宽容期只对「无 token + 真 id + 无既有结果」放行
  const leaseTtlMs = options.leaseTtlMs || 15000;
  const legacyGraceMs = options.legacyGraceMs != null ? options.legacyGraceMs : 30 * 60 * 1000;
  const leaseEnabled = options.leaseEnabled || (() => false);
  // 已领出未回执的指令最多保留多久（之后按失联写失败）；缺省 4×TTL。
  // 宿主 TTL 只有 3s，但 blend 排队 / awaitFinish 的回执可能晚到数十秒，宿主单独传更长的值。
  const ownedStaleMs = options.ownedStaleMs || leaseTtlMs * 4;
  const diag = options.diag || (() => {});
  const nowFn = options.now || (() => Date.now());

  let seq = 0;
  const queue = [];
  const results = new Map();
  const events = new Map();
  // 完成事件观察者（PR-D）：Number(id) -> Set<cb>；cb 收到 {kind:'event',event} 或 {kind:'result',result}。
  // 旁路通知，不消费数据；生命周期由调用方 unsubscribe / subscribeCompletion 内部三重清理兜底。
  const observers = new Map();

  // 租约状态（flag 关时不读写，保证逐路径等价基线）
  let leaseSeq = 0;        // epoch 计数器，单调整数从 1 起
  let lease = null;        // null = 从未有租约
  const ownedCalls = new Map(); // callId -> { token, epoch, polledAt }；poll 出队登记，回执/清理删除
  const delivered = new Map();  // 已被 read 消费的 callId -> 1；防已消费 id 被宽容期/陈旧回执覆盖
  const answeredTokens = new Map(); // 已受理 result 的 callId -> 受理时 token；供晚到的 action-done event 校验
  let leaseEnabledAt = 0;  // flag 首次（或重新）生效时刻，宽容期计时起点
  let leaseArmed = false;  // flag 开→关→开时重新记 grace 起点

  function trim(map) {
    while (map.size > maxIds) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  function maskId(id) {
    const s = String(id || '');
    return s.length > 6 ? s.slice(0, 6) + '…' : s;
  }

  // 落账通知（PR-D）：快照遍历，观察者异常不反噬 post 路径。
  function notify(id, entry) {
    const set = observers.get(Number(id));
    if (!set || !set.size) return;
    for (const cb of [...set]) {
      try {
        cb(entry);
      } catch {
        /* 观察者故障不阻断回执落账 */
      }
    }
  }

  // ---- 完成事件订阅（PR-D）实现体：闭包函数声明，对象字面量仅引用（不受解构/this 影响）----

  /** 旁路观察：不消费数据；注册时补交付存量未排空 events。signal abort 自动退订。 */
  function observeById(id, cb, opts = {}) {
    const key = Number(id);
    if (typeof cb !== 'function') return () => {};
    let set = observers.get(key);
    if (!set) {
      set = new Set();
      observers.set(key, set);
    }
    set.add(cb);
    // 存量补交付：只补 event（result 不补——subscribeCompletion 注册时用 peekResultById 探测）
    const pending = events.get(key);
    if (pending && pending.length) {
      for (const ev of [...pending]) {
        try {
          cb({ kind: 'event', event: ev });
        } catch {
          /* 单条失败不影响其余补交付 */
        }
      }
    }
    const signal = opts.signal || null;
    const onAbort = () => unsubscribe();
    if (signal) {
      if (signal.aborted) {
        // 已中止：注册即退订，但仍先完成存量补交付（上面已做），数据不丢
        unsubscribe();
        return () => {};
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    function unsubscribe() {
      const cur = observers.get(key);
      if (cur) {
        cur.delete(cb);
        if (!cur.size) observers.delete(key);
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return unsubscribe;
  }

  /** 只读探测 result（不消费）：拒绝回执无 event，订阅方据此免白等。 */
  function peekResultById(id) {
    return results.get(Number(id));
  }

  /** action-done 终态等待器：终态 resolve；拒绝/abort/deadline resolve null 落轮询降级。 */
  function subscribeCompletionById(id, onEvent, opts = {}) {
    const key = Number(id);
    const signal = opts.signal || null;
    const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : 30000;
    return new Promise((resolve) => {
      let settled = false;
      let unsub = () => {};
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsub();
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      const onNotify = (entry) => {
        if (settled) return;
        if (entry.kind === 'event') {
          const e = entry.event;
          if (!e || e.type !== 'action-done') return; // start 等其他事件类型不触发终态
          try {
            onEvent(e);
          } catch {
            /* 收集器异常不反噬订阅链路 */
          }
          if (e.phase === 'end' || e.phase === 'interrupted' || e.phase === 'failed') {
            finish({ phase: e.phase, completionSource: e.completionSource, ownedParams: e.ownedParams });
          }
          return;
        }
        // result 落账：拒绝形态（无 event 会来）立即放行落轮询，executor 即时拿到拒绝
        if (entry.kind === 'result' && entry.result && entry.result.ok === false) finish(null);
      };
      unsub = observeById(key, onNotify);
      // 注册前已落账的拒绝 result：同样立即放行（事件不会来，等是白等）
      const existing = peekResultById(key);
      if (existing && existing.ok === false) {
        finish(null);
        return;
      }
      if (signal) {
        if (signal.aborted) {
          finish(null);
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (deadlineMs > 0) {
        // 兜底定时器不 unref：unref 会让它在事件循环空闲时不触发，挂死防护失效；
        // finish 三路径（终态/拒绝/abort）都 clearTimeout，遗留定时器仅在挂死场景存在。
        timer = setTimeout(() => finish(null), deadlineMs);
      }
    });
  }

  // flag 开→关→开：重新计时宽容期（flag 关期间 leaseEnabledAt 不动）
  function ensureArmed(now) {
    if (!leaseArmed) {
      leaseArmed = true;
      leaseEnabledAt = now;
    }
  }

  // 接管：epoch 单调 +1、token 轮换（旧 token 即刻作废）；
  // 未回执 call 写入 lease-taken-over 失败回执（失联语义），不复活重排。
  function takeover(consumerId, now, foreground, cause) {
    const epoch = ++leaseSeq;
    const prev = lease;
    lease = {
      token: 'lease-' + epoch + '-' + Math.random().toString(36).slice(2, 10),
      consumerId,
      epoch,
      foreground: foreground === true,
      acquiredAt: now,
      expiresAt: now + leaseTtlMs,
    };
    if (prev) diag('ai/poll lease ' + (cause || 'takeover') + ' ' + maskId(prev.consumerId) + ' → ' + maskId(consumerId) + ' (' + ownedCalls.size + ' 条未回执写失败)');
    for (const id of ownedCalls.keys()) {
      if (!results.has(id)) {
        results.set(id, { ok: false, reason: 'lease-taken-over' });
        notify(id, { kind: 'result', result: results.get(id) });
      }
    }
    if (ownedCalls.size) trim(results);
    ownedCalls.clear();
    answeredTokens.clear(); // 接管后 token 轮换，旧 lease 受理记录同步作废
    return issueCalls(now);
  }

  // 发放：整批 splice（与 legacy 同一批语义）+ 登记 ownedCalls 供回执校验。
  // 内存上限：任持期内超过 4×TTL 未回执的条目按失联处置，Map 不无界增长。
  function issueCalls(now) {
    for (const [id, rec] of ownedCalls) {
      if (now - rec.polledAt > ownedStaleMs) {
        if (!results.has(id)) {
          results.set(id, { ok: false, reason: 'lease-taken-over' });
          notify(id, { kind: 'result', result: results.get(id) });
        }
        ownedCalls.delete(id);
      }
    }
    trim(results);
    const calls = queue.splice(0, queue.length);
    for (const c of calls) {
      ownedCalls.set(c.id, { token: lease.token, epoch: lease.epoch, polledAt: now });
    }
    return { calls, lease: { token: lease.token, epoch: lease.epoch } };
  }

  // 回执落账（PR#19 × main 合并语义）：event 追加、result 覆盖，二者可同条 post。
  // 仅 undefined/null 视为空结果；false/0 等合法 falsy 值原样保留（main 侧基线）。
  function writeReceipt(body, id) {
    if (body.event !== undefined) {
      const list = events.get(id) || [];
      list.push(body.event);
      while (list.length > maxEventsPerId) list.shift();
      events.set(id, list);
      trim(events);
      notify(id, { kind: 'event', event: body.event });
    }
    if (body.result !== undefined) {
      results.set(id, body.result ?? { ok: false, reason: 'empty' });
      trim(results);
      notify(id, { kind: 'result', result: results.get(id) });
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

    /**
     * poll({ consumerId }) → { calls, reverse?, lease? }
     * flag 关：等价旧行为（整批 splice，忽略 consumerId）。
     * flag 开三分支：
     *   R1 携带 consumerId 且无租约/已过期 → 接管（epoch+1、token 轮换）；
     *   R2 租约属本人 → 续期发放（附 lease token/epoch）；
     *   R3 他人持有或无 consumerId（旧版本 overlay）→ 空队列，不瓜分不 403。
     *      没有 consumerId 的 poll 永远落在 R3——不可能借「无主」状态抢到调用。
     */
    poll(query) {
      const consumerId = (query && query.consumerId) || '';
      // foreground 只认显式 true：旧 overlay 不带，视作后台，不会抢占别人
      const foreground = !!(query && query.foreground === true);
      if (!leaseEnabled()) {
        leaseArmed = false; // 重开 flag 时 grace 从头计时
        return { calls: queue.splice(0, queue.length) };
      }
      const now = nowFn();
      ensureArmed(now);
      if (lease && consumerId && consumerId === lease.consumerId) {
        // R2 心跳续期；过期后回来但期间没人接手 → 同一 token 续上（已领出的指令照常回执）
        lease.expiresAt = now + leaseTtlMs;
        lease.foreground = foreground;
        return issueCalls(now);
      }
      if (consumerId && (!lease || now >= lease.expiresAt)) return takeover(consumerId, now, foreground, lease ? 'expired' : 'acquire');
      // 前台抢占后台
      if (consumerId && foreground && lease && !lease.foreground) return takeover(consumerId, now, foreground, 'foreground-preempt');
      return {
        calls: [],
        reason: 'no-lease',
        lease: { status: 'held', holder: lease ? maskId(lease.consumerId) : '', foreground: !!(lease && lease.foreground), expiresInMs: lease ? Math.max(0, lease.expiresAt - now) : 0 },
      };
    },

    /** 只读：当前租约（诊断用，不含 token）。 */
    leaseInfo() {
      if (!leaseEnabled() || !lease) return { enabled: !!leaseEnabled(), holder: '' };
      const now = nowFn();
      return { enabled: true, holder: maskId(lease.consumerId), epoch: lease.epoch, foreground: lease.foreground, expired: now >= lease.expiresAt, expiresInMs: Math.max(0, lease.expiresAt - now), outstanding: ownedCalls.size };
    },

    /**
     * post(body) → { ok: true } | { ok: false, reason }
     * flag 关：等价旧行为（无 token 校验）。
     * flag 开校验（V1-V4）：
     *   V1 id 基本校验；V2 call 归属（ownedCalls 存在且 token 全等——token 优先于 epoch）；
     *   V3 回执先到先得（result 已有该 id 即拒；含被 read 消费过的 id，防污染回执覆盖）；
     *   V4 通过才写入。失败统一 { ok:false, reason:'fenced' }（路由层回 409）。
     * 宽容期（V2 失败且 body.token 缺失时）：30 分钟窗口内，真 id（≤seq）且无既有结果
     * 照收并打 diag('ai/result legacy-grace …')；超窗/伪造未来 id/重复一律 fenced。
     */
    post(body) {
      const id = Number(body && body.id);
      if (!id) return { ok: false, reason: 'id required' };
      const hasEvent = body.event !== undefined;
      const hasResult = body.result !== undefined;
      if (!hasEvent && !hasResult) return { ok: false, reason: 'event or result required' };
      // event 与 result 允许同一条 post：分开处理，互不挤占（main 侧语义，租约路径同样适用）。
      if (!leaseEnabled()) {
        leaseArmed = false;
        writeReceipt(body, id);
        return { ok: true };
      }
      const now = nowFn();
      ensureArmed(now);
      const owned = ownedCalls.get(id);
      if (owned) {
        // V2：call 归属校验。不只验 epoch——接管后 token 轮换，旧 epoch 持有者报对 epoch 号也没用
        if (body.token !== owned.token) {
          diag('ai/result fenced id=' + id + ' (token mismatch)');
          return { ok: false, reason: 'fenced' };
        }
        // event 不受限：end/interrupted 可晚于 result 到达（V3 只约束 result）
        if (hasEvent) {
          const list = events.get(id) || [];
          list.push(body.event);
          while (list.length > maxEventsPerId) list.shift();
          events.set(id, list);
          trim(events);
          notify(id, { kind: 'event', event: body.event });
        }
        // V3：一次执行一份 result，先到先得（含被 read 消费过的 id，防污染回执覆盖）
        if (hasResult) {
          if (results.has(id) || delivered.has(id)) {
            diag('ai/result fenced id=' + id + ' (already answered)');
            ownedCalls.delete(id);
            return { ok: false, reason: 'fenced' };
          }
          // 仅 undefined/null 视为空结果；false/0 等合法 falsy 值原样保留。
          results.set(id, body.result ?? { ok: false, reason: 'empty' });
          trim(results);
          notify(id, { kind: 'result', result: results.get(id) });
          // result 受理即销毁归属，但记录受理时 token：end/interrupted 合法晚于 result 到达，
          // 届时归属已删，凭 answeredTokens 校验放行 event（见下方晚到分支）。
          answeredTokens.set(id, owned.token);
          trim(answeredTokens);
          ownedCalls.delete(id);
        }
        // 仅 event 的 post 不销毁归属：result 仍在途中，删除会导致后续 result 被 stale-token fence。
        return { ok: true };
      }
      // 晚到 event（result 已受理、归属已删）：凭受理时 token 放行，仅限纯 event post。
      // 带 result 的晚到回执仍走下方 stale-token / already-answered 拒绝路径。
      if (hasEvent && !hasResult && body.token && answeredTokens.get(id) === body.token) {
        const list = events.get(id) || [];
        list.push(body.event);
        while (list.length > maxEventsPerId) list.shift();
        events.set(id, list);
        trim(events);
        notify(id, { kind: 'event', event: body.event });
        return { ok: true };
      }
      // 无归属记录：带 token 的一律是陈旧消费者（token 已轮换/无主 id），拒绝
      if (body.token) {
        diag('ai/result fenced id=' + id + ' (stale token)');
        return { ok: false, reason: 'fenced' };
      }
      // 宽容期分支：只对「无 token + 真 id + 无既有结果」放行
      if (leaseEnabledAt <= 0 || now >= leaseEnabledAt + legacyGraceMs) {
        diag('ai/result fenced id=' + id + ' (grace expired)');
        return { ok: false, reason: 'fenced' };
      }
      if (id > seq) {
        diag('ai/result fenced id=' + id + ' (forged future id)');
        return { ok: false, reason: 'fenced' };
      }
      if (results.has(id) || delivered.has(id)) {
        diag('ai/result fenced id=' + id + ' (already answered)');
        return { ok: false, reason: 'fenced' };
      }
      diag('ai/result legacy-grace id=' + id);
      writeReceipt(body, id);
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
        // 已消费 id 记账：宽容期/陈旧回执不得再覆盖（污染回执封堵）
        if (leaseEnabled()) {
          delivered.set(key, 1);
          trim(delivered);
        }
        const payload = { ready: true, result };
        if (drained.length) payload.events = drained;
        return payload;
      }
      if (drained.length) return { ready: false, events: drained };
      return { ready: false };
    },

    /**
     * observe(id, cb, { signal }) → unsubscribe（PR-D）。
     * 旁路观察：cb 收到 {kind:'event',event} / {kind:'result',result}，不消费数据
     * （events Map / results Map 原样保留，read 排空语义不变）。注册时把已落账、
     * 未排空的存量 events 逐个补交付（订阅晚于回执到达的竞态窗口）。
     * signal abort 时自动退订。回调异常已在 notify 内隔离。
     */
    observe: observeById,

    /**
     * peekResult(id) → result | undefined（PR-D）。
     * 只读不消费：供订阅方注册时探测拒绝回执是否已落账（拒绝无 event，等是白等）。
     */
    peekResult: peekResultById,

    /**
     * subscribeCompletion(id, onEvent, { signal, deadlineMs }) → Promise<终态|null>（PR-D）。
     * HttpActionExecutor.subscribeEvents 的宿主实现。resolve 值：
     *   { phase:'end'|'interrupted'|'failed', completionSource?, ownedParams? } —— event 通道真实终态；
     *   null —— 拒绝已落账/接管失败/abort/deadline 超时，executor 落轮询降级（fail-closed）。
     * onEvent 对每个 action-done 事件透传（executor 统一收集器，progress 事件也能进 ctx）。
     */
    subscribeCompletion: subscribeCompletionById,
  };
}
