/**
 * HttpActionExecutor（PR-C，B18；PR-D，PRD-RUNTIME-EVENT 升级）——经 dev-server /ai/call + /ai/result 驱动浏览器侧。
 *
 * 链路（前置核查 A 结论：结果按 callId 持久于 ai-inbox 内存 Map，Node 可 GET 取回）：
 *   execute: POST /ai/call {name:'l2d_act', args:{chain, priority, silent:true}}
 *            → {ok, id: callId} → 等待完成判定：
 *              ① 事件订阅优先：注入 deps.subscribeEvents(callId, onEvent) 时走订阅；
 *              ② 轮询降级保留：GET /ai/result?id=<callId>（间隔 pollIntervalMs）。
 *            完成判定：event 通道 action-done 的 end / interrupted；
 *            result 通道的 {ok:false}（拒绝：priority-blocked / empty-chain）即时失败。
 *            end 回执若带 completionSource:'runtime-event'（PR-D 渲染包真实终点），
 *            结果附带 ownedParams（完成时刻浏览器仍被 Agent 认领的物理输出）。
 *
 *   release: PR-D 升级——由「TTL 宽限」升级为「完成事件 + ownership 出口核对」：
 *              · 完成事件存在：核对 ownedParams ∩ 本链 keyframes 参数 === ∅ → confirmed。
 *                有残留（ownedParams 仍含本链参数）→ 短宽限后如实返回 confirmed:false（不伪报）。
 *              · 无完成事件（Loop 动作 / 老渲染包 / 订阅与轮询都缺事件）：
 *                沿用 releaseGraceMs TTL 宽限，confirmed:false, via:'ttl-grace'。
 *            fail-closed 语义：预估从不冒充真实确认；confirmed 只在证据齐全时为 true。
 *
 * Runtime 就绪探测（B18）：GET /api/models，非 200 → throw 'RUNTIME_NOT_READY'（不伪报）。
 * 所有 fetch 经 fetchImpl 注入（测试/连续验收零真实浏览器）。
 */

export const RUNTIME_NOT_READY = 'RUNTIME_NOT_READY';

/** 数值 priority(0-100) → overlay act 优先级档位（admitAct 接受 BACKGROUND/NORMAL/FORCE） */
function mapPriority(priority) {
  const p = Number(priority ?? 50);
  if (!Number.isFinite(p)) return 'NORMAL';
  if (p >= 67) return 'FORCE';
  if (p >= 34) return 'NORMAL';
  return 'BACKGROUND';
}

/** 可中断 sleep：signal abort 时立即 resolve，不遗留后台定时器。 */
const sleep = (ms, signal) => new Promise((resolve) => {
  if (!signal) { setTimeout(resolve, ms); return; }
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** cancel 的 /ai/call POST 独立短超时（与队列 STOPPING 预算对齐，不依赖 execute 的 signal）。 */
const CANCEL_TIMEOUT_MS = 3000;

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** 订阅路径的可中断占位：signal 存在时 abort 即 resolve(null)；无 signal 时永不 settle（仅作 race 占位）。 */
function abortPromise(signal) {
  if (!signal) return new Promise(() => {});
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/**
 * 链里会走 ParamInjector 认领的物理输出参数（ownership 出口核对的范围）。
 * 只有 keyframes 步骤由渲染端自动 own；motion/look/pose 不经 injector 认领。
 */
function chainOwnedParams(chain) {
  const out = [];
  for (const step of Array.isArray(chain) ? chain : []) {
    if (!step || step.kind !== 'keyframes') continue;
    for (const track of Array.isArray(step.tracks) ? step.tracks : []) {
      if (track && typeof track.param === 'string' && track.param) out.push(track.param);
    }
  }
  return out;
}

export class HttpActionExecutor {
  /**
   * @param {object} deps
   * @param {string} [deps.baseUrl='http://127.0.0.1:5300'] dev-server 地址
   * @param {typeof fetch} [deps.fetchImpl] 注入（缺省全局 fetch）
   * @param {number} [deps.pollIntervalMs=250] /ai/result 轮询间隔（降级路径）
   * @param {number} [deps.releaseGraceMs=0] 释放宽限（降级路径 / ownership 残留复查用）
   * @param {(callId: string, onEvent: (e: object) => void) => Promise<{phase: string, completionSource?: string, ownedParams?: string[]}>} [deps.subscribeEvents]
   *        事件订阅（PR-D，优先路径）。解析值需带终态 phase；订阅不可用/失败时自动落轮询。
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ baseUrl = 'http://127.0.0.1:5300', fetchImpl, pollIntervalMs = 250, releaseGraceMs = 0, subscribeEvents, log = () => {} } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('HttpActionExecutor: baseUrl 必填');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) throw new Error('HttpActionExecutor: pollIntervalMs 必须 ≥10ms');
    if (subscribeEvents !== undefined && typeof subscribeEvents !== 'function') {
      throw new Error('HttpActionExecutor: subscribeEvents 必须是函数或省略');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.pollIntervalMs = pollIntervalMs;
    this.releaseGraceMs = releaseGraceMs;
    this.subscribeEvents = subscribeEvents ?? null;
    this.log = log;
    /** 最近一次 execute 的释放核对上下文（队列串行，单槽即可）。 */
    this._pendingRelease = null;
  }

  /** Runtime 就绪探测：dev-server /api/models 200 即视为就绪。 */
  async probeReady() {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/models`, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`${RUNTIME_NOT_READY}: dev-server 不可达（${String(error && error.message || error)}）`);
    }
    if (!res.ok) throw new Error(`${RUNTIME_NOT_READY}: /api/models ${res.status}`);
    return true;
  }

  /**
   * 执行动作（挂起至浏览器回执完成事件或拒绝）。
   * @returns {Promise<{ok: boolean, executionId?: string, reason?: string, phase?: string,
   *                     completionSource?: string, ownedParams?: string[]}>}
   *          ok:true = end/interrupted 到达；ok:false = 链被拒绝（priority-blocked 等）。
   */
  async execute(request, options = {}) {
    // F1：queue 传入的 signal；三重退出（signal / 本地 deadline / 最大轮询次数）据此判定。
    const signal = options.signal || null;
    const cancelled = () => !!(signal && signal.aborted);
    const budgetMs = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : 30_000;
    // 本地 deadline 比队列预算少 500ms，给 STOPPING 收尾留余量
    const localDeadline = Date.now() + Math.max(0, budgetMs - 500);
    const MAX_POLLS = 240;
    await this.probeReady();

    const callRes = await this.fetchImpl(`${this.baseUrl}/ai/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'l2d_act',
        args: {
          chain: Array.isArray(request.args?.chain) ? request.args.chain : [],
          priority: mapPriority(request.priority),
          silent: true,
        },
      }),
    });
    if (!callRes.ok) throw new Error(`/ai/call ${callRes.status}`);
    const call = await callRes.json();
    if (!call.ok || !call.id) throw new Error(`/ai/call 未受理：${JSON.stringify(call).slice(0, 200)}`);
    const callId = String(call.id);
    const ownedScope = chainOwnedParams(request.args?.chain);
    const cancelledResult = () => ({ ok: false, executionId: callId, reason: 'cancelled' });
    this.log(`execute ${request.requestId} → callId=${callId}`);

    // 终态事件收集器：订阅与轮询共用一套判定语义。
    // PR-A 三态：end/interrupted = 完成终态；failed = 失败终态（ok:false，不冱充 completed）。
    const ctx = { terminal: null, completionInfo: null, failed: null };
    const onEvent = (e) => {
      if (!e || e.type !== 'action-done') return;
      if (e.phase === 'end' || e.phase === 'interrupted') ctx.terminal = e;
      else if (e.phase === 'failed' && !ctx.failed) ctx.failed = e;
      if (e.completionSource === 'runtime-event') ctx.completionInfo = e;
    };
    const failResult = () => ({
      ok: false,
      executionId: callId,
      reason: (ctx.failed && (ctx.failed.reason || ctx.failed.error)) || 'failed',
      phase: 'failed',
    });

    // ---- 事件订阅优先（F1：signal 透传 + abort 可脱离，避免订阅挂起拖死 execute）----
    if (this.subscribeEvents) {
      try {
        const sub = await Promise.race([
          Promise.resolve(this.subscribeEvents(callId, onEvent, { signal })),
          abortPromise(signal),
        ]);
        if (cancelled()) return cancelledResult();
        if (ctx.failed) return failResult();
        const phase = sub && (sub.phase || (ctx.terminal && ctx.terminal.phase));
        if (phase === 'end' || phase === 'interrupted') {
          return this._finalize(request, callId, phase, ctx, ownedScope);
        }
        // 订阅返回但无终态：订阅链路没交付，落轮询；已见终态直接采信（事件已被 read 排空）
      } catch (error) {
        if (cancelled() || isAbortError(error)) return cancelledResult();
        this.log(`subscribe ${request.requestId} unavailable → polling fallback（${String(error && error.message || error)}）`);
        if (ctx.failed) return failResult();
        if (ctx.terminal) return this._finalize(request, callId, ctx.terminal.phase, ctx, ownedScope);
      }
    }

    // ---- 轮询降级：三重退出（signal 中止 / 本地 deadline / 最大轮询次数）----
    // F1：queue 超时会 abort signal；此处必须真正停止后台轮询，不再泄漏连接。
    for (let polls = 0; ; polls += 1) {
      if (cancelled()) return cancelledResult();
      if (Date.now() >= localDeadline || polls >= MAX_POLLS) {
        return { ok: false, executionId: callId, reason: 'cancelled' };
      }
      await sleep(this.pollIntervalMs, signal);
      if (cancelled()) return cancelledResult();
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/ai/result?id=${encodeURIComponent(callId)}`, {
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (cancelled() || isAbortError(error)) return cancelledResult();
        continue; // 瞬时失败交给三重退出兜底，不再无限重试
      }
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      // 拒绝：result 通道 ok:false（acceptedAct 同步回执的失败形态）
      if (body.ready && body.result && body.result.ok === false) {
        return { ok: false, executionId: callId, reason: body.result.reason || body.result.error || 'rejected' };
      }
      // 完成：event 通道 end / interrupted；失败：event 通道 failed（PR-A 三态）
      const events = Array.isArray(body.events) ? body.events : [];
      for (const e of events) onEvent(e);
      if (ctx.failed) return failResult();
      if (ctx.terminal) {
        return this._finalize(request, callId, ctx.terminal.phase, ctx, ownedScope);
      }
    }
  }

  /** 终态结果组装：真实完成时携带 completionSource + ownedParams（释放核对证据链）。 */
  _finalize(request, callId, phase, ctx, ownedScope) {
    this.log(`execute ${request.requestId} done phase=${phase}${ctx.completionInfo ? ' (runtime-event)' : ''}`);
    const result = { ok: true, executionId: callId, phase };
    if (ctx.completionInfo) {
      result.completionSource = 'runtime-event';
      result.ownedParams = Array.isArray(ctx.completionInfo.ownedParams) ? ctx.completionInfo.ownedParams.slice() : [];
      const leaked = result.ownedParams.filter((p) => ownedScope.includes(p));
      result.ownershipExit = leaked.length === 0 ? 'clear' : 'residual';
      if (leaked.length) result.leakedParams = leaked;
    }
    this._pendingRelease = { executionId: callId, ownedScope, completionInfo: ctx.completionInfo };
    return result;
  }

  /** 取消：FORCE 最小链抢占 → 旧链 interrupted。 */
  async cancel(request) {
    const callRes = await this.fetchImpl(`${this.baseUrl}/ai/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'l2d_act',
        args: { chain: [{ kind: 'look', x: 0, y: 0 }], priority: 'FORCE', silent: true },
      }),
      // F2：独立短超时，宿主挂住时 cancel 不会把 STOPPING 永久卡死（与 execute 的 signal 无关）
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    if (!callRes.ok) throw new Error(`cancel: /ai/call ${callRes.status}`);
    this.log(`cancel ${request?.requestId ?? '(active)'} → FORCE 抢占已发`);
  }

  /**
   * 释放确认（PR-D）：完成事件 + ownership 出口核对优先；无事件证据时降级 TTL 宽限。
   * @returns {Promise<{confirmed: boolean, via: string, leaked?: string[]}>}
   *          confirmed=true 仅当真实完成事件存在且本链参数零残留（不伪报）。
   */
  async release(request) {
    const pending = this._pendingRelease;
    this._pendingRelease = null;
    // request.executionId 缺失（超时/取消路径直接传原始 request）时按最近一次 execute 归属
    if (pending && request?.executionId != null && String(request.executionId) !== String(pending.executionId)) {
      this._pendingRelease = pending; // 不是本次执行的释放请求，上下文留给正确的调用方
      return { confirmed: false, via: 'no-completion-evidence' };
    }
    if (pending && pending.completionInfo) {
      const owned = Array.isArray(pending.completionInfo.ownedParams) ? pending.completionInfo.ownedParams : [];
      const leaked = owned.filter((p) => pending.ownedScope.includes(p));
      if (!leaked.length) {
        return { confirmed: true, via: 'completion-event+ownership-exit' };
      }
      // 完成到了但本链参数仍在认领：短宽限复查 TTL 兜底，如实报告残留（fail-closed）
      if (this.releaseGraceMs > 0) await sleep(this.releaseGraceMs);
      this.log(`release residual: ${leaked.join(',')}`);
      return { confirmed: false, via: 'completion-event-ownership-residual', leaked };
    }
    // 降级：TTL 宽限（老渲染包 / Loop 动作 / 事件链路缺失）
    if (this.releaseGraceMs > 0) await sleep(this.releaseGraceMs);
    return { confirmed: false, via: 'ttl-grace' };
  }
}
