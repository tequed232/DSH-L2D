/**
 * ModelActionQueue（PR-C，B10-B18）——执行串行原则的落地。
 *
 * 状态机（裁决书 §7.2 + §修正）：
 *   idle → running（取队首，repo markRunning）
 *     → executor.execute 成功 → executor.release（完成+释放双确认）→ completed → next
 *     → execute 超时（timeoutMs）→ stopping（executor.cancel + 等待 release 确认）→ failed → next
 *     → execute 抛错（如 RUNTIME_NOT_READY）→ failed → next（不阻断后续）
 *     → cancel 失败 / release 抛错 → FAULTED（阻断全部，仅 recover() 解锁回 idle）
 *
 * 纪律：
 *  - enqueue 幂等（B15）：repo 已有同 requestId → 直接返回既有回执，不重复执行；
 *    repo 未注入时用内存 Set 去重（测试/无持久化宿主）。
 *  - 背压（裁决书 §十）：pending ≥ maxPending(32) → enqueue 返回 {error:'QUEUE_FULL'}，
 *    不抛穿。
 *  - 每次状态迁移同步写 repo（注入时）；repo 未注入时仅内存（不伪报已持久化）。
 *  - dispose：cancel 活动项 + pending 全部 cancelled 回执。
 *  - recover()：显式调用（宿主确认 Runtime 已清）解锁 FAULTED；recoverFromRestart()
 *    处理重启恢复（B17：findUnfinished → markInterruptedAll，不重放）。
 *  - clock 注入（测试用 fake timer）；生产缺省全局 setTimeout/clearTimeout。
 */

export const QUEUE_FULL_MAX_PENDING = 32;

/** 队列自身状态（与动作行 state 不同维度） */
const Q_STATE = Object.freeze({ IDLE: 'idle', RUNNING: 'running', STOPPING: 'stopping', FAULTED: 'faulted', DISPOSED: 'disposed' });

export class ModelActionQueue {
  /**
   * @param {object} deps
   * @param {{execute: (request) => Promise<object>, release: (request) => Promise<void>,
   *          cancel?: (request) => Promise<void>}} deps.executor
   *        execute 返回 {ok, ...}；ok:false 或抛错按失败处理。
   *        release 必须实现——完成但未释放不得启动下一条（B12/B14）。
   * @param {object} [deps.repo] bridge-actions-repo（注入则持久化，未注入仅内存）
   * @param {{setTimeout: Function, clearTimeout: Function}} [deps.clock]
   * @param {number} [deps.maxPending=32]
   */
  constructor({ executor, repo = null, clock, maxPending = QUEUE_FULL_MAX_PENDING }) {
    if (!executor || typeof executor.execute !== 'function') throw new Error('ModelActionQueue: executor.execute 必填');
    if (typeof executor.release !== 'function') throw new Error('ModelActionQueue: executor.release 必填（完成+释放双确认）');
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error('ModelActionQueue: maxPending 必须 ≥1');
    this.executor = executor;
    this.repo = repo;
    this.clock = clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
    this.maxPending = maxPending;

    this.pending = []; // { request, resolve }
    this.seen = new Set(); // 无 repo 时的幂等去重
    this.qState = Q_STATE.IDLE;
    this.activeRequestId = null;
    this.activeHandle = null; // F6：活动项句柄 {timer,resolve,timeoutReject,controller}
    this.disposed = false;
  }

  /**
   * 入队（FIFO，幂等，背压）。resolve 时机：该动作到达终态（或被拒）。
   * @returns {Promise<object>} ActionReceipt 形状 {requestId, state, error?} 或 {error:'QUEUE_FULL'|'FAULTED'|'DISPOSED', detail}
   */
  enqueue(request) {
    if (this.disposed) return Promise.resolve({ error: 'DISPOSED', detail: 'queue 已 dispose，拒绝新请求' });
    if (this.qState === Q_STATE.FAULTED) {
      return Promise.resolve({ error: 'FAULTED', detail: '队列 FAULTED，仅显式 recover() 可解锁' });
    }
    if (!request || typeof request.requestId !== 'string' || !request.requestId) {
      return Promise.resolve({ error: 'INVALID_ARGS', detail: 'requestId 必填' });
    }

    // 幂等（B15）：repo 既有行直接回执；无 repo 用内存 Set
    if (this.repo) {
      const existing = this.repo.findById(request.requestId);
      if (existing && existing.state !== 'queued') {
        // queued 且不在 pending/active（进程内重启扫描后遗留）不可能走到 worker，按幂等回执
        return Promise.resolve(toReceipt(existing));
      }
    } else if (this.seen.has(request.requestId)) {
      return Promise.resolve({ requestId: request.requestId, state: 'queued', duplicated: true });
    }

    if (this.pending.length >= this.maxPending) {
      return Promise.resolve({ error: 'QUEUE_FULL', detail: `pending ≥ ${this.maxPending}` });
    }

    if (this.repo) {
      const { row, inserted } = this.repo.insertRequest(request);
      if (!inserted) return Promise.resolve(toReceipt(row)); // 并发下幂等兜底（B15）
    } else {
      this.seen.add(request.requestId);
    }

    return new Promise((resolve) => {
      this.pending.push({ request, resolve });
      this.pump();
    });
  }

  /** 取下一条（FIFO 单 worker）。 */
  pump() {
    if (this.disposed || this.qState !== Q_STATE.IDLE || !this.pending.length) return;
    const entry = this.pending.shift();
    this.qState = Q_STATE.RUNNING;
    void this.runOne(entry);
  }

  /** F2：STOPPING 阶段单步超时预算（≤3s 且 ≤请求预算 1/4）。 */
  stoppingBudgetMs(request) {
    const budget = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : 30_000;
    return Math.max(1, Math.min(3000, Math.floor(budget / 4)));
  }

  /** F2：给 STOPPING 的 cancel/release 套 Promise.race 超时兜底，任何结果都清 timer。 */
  async withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this.clock.setTimeout(() => reject(new Error(label)), ms);
    });
    try {
      return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
      if (timer !== null) this.clock.clearTimeout(timer);
    }
  }

  async runOne({ request, resolve }) {
    this.activeRequestId = request.requestId;
    if (this.repo) this.repo.markRunning(request.requestId);

    let timedOut = false;
    let timeoutReject = null;
    const controller = new AbortController();
    // 超时以 reject 参与 race：到点脱离 execute；F1 同时 abort 底层 execute，
    // 让 HttpActionExecutor 的轮询循环真正停止，不再后台泄漏连接。
    const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
    const timer = this.clock.setTimeout(() => {
      timedOut = true;
      try { controller.abort(new DOMException('queue-timeout', 'TimeoutError')); } catch { /* 忽略 */ }
      timeoutReject(new Error('timeout'));
    }, request.timeoutMs ?? 30_000);

    // F6：登记活动句柄，供 cancel(activeId) 精确结算/清理，避免两条 runOne 交错覆盖 qState。
    const handle = {
      requestId: request.requestId, timer, resolve, timeoutReject, controller,
      cancelled: false, timeoutMs: request.timeoutMs ?? 30_000,
    };
    this.activeHandle = handle;
    const cancelledExternally = () => handle.cancelled;

    let result = null;
    try {
      result = await Promise.race([
        this.executor.execute(request, { signal: controller.signal }),
        timeoutPromise,
      ]);
      if (cancelledExternally()) return;
      // 超时可能恰在 execute 正常返回前后触发：以 timedOut 为准走 STOPPING
      if (timedOut) throw new Error('timeout');

      if (result && result.ok === false) {
        finishFailed(this, request, resolve, result.reason || result.error || 'executor-rejected');
        this.advance();
        return;
      }
    } catch (error) {
      if (cancelledExternally()) return;
      const message = String(error && error.message || error);
      if (message !== 'timeout') {
        // execute 抛错（RUNTIME_NOT_READY / 拒绝等）：本条 failed，队列继续（不阻断）
        finishFailed(this, request, resolve, message);
        this.advance();
        return;
      }
      // ---- 超时 → STOPPING：cancel + 确认释放 → failed → next（B13）----
      this.qState = Q_STATE.STOPPING;
      try {
        if (typeof this.executor.cancel === 'function') {
          await this.withTimeout(this.executor.cancel(request), this.stoppingBudgetMs(request), 'cancel-timeout');
        }
        await this.withTimeout(this.executor.release(request), this.stoppingBudgetMs(request), 'release-timeout'); // 确认释放后才允许下一条
        finishFailed(this, request, resolve, 'timeout');
      } catch (cancelError) {
        const cancelMessage = String(cancelError && cancelError.message || cancelError);
        const budgetTimeout = cancelMessage === 'cancel-timeout' || cancelMessage === 'release-timeout';
        if (this.repo) this.repo.markTerminal(request.requestId, 'failed', { error: 'timeout' });
        resolve({ requestId: request.requestId, state: 'failed', error: 'timeout' });
        if (budgetTimeout) {
          this.advance(); // F2：兜底超时也要推进，绝不留 qState 永久 STOPPING
        } else {
          this.fault(cancelMessage); // 真实 cancel/release 抛错：保持 FAULTED 语义（B14）
        }
        return;
      }
      this.advance();
      return;
    } finally {
      // F5：任何退出路径都清 timer（clearTimeout 幂等）
      this.clock.clearTimeout(timer);
    }

    // ---- 完成但未释放不启动下一条（B12）；释放失败 → FAULTED（B14）----
    if (cancelledExternally()) return;
    try {
      await this.executor.release(request);
    } catch (releaseError) {
      const message = String(releaseError && releaseError.message || releaseError);
      if (this.repo) this.repo.markTerminal(request.requestId, 'failed', { error: `release-failed: ${message}` });
      this.fault(message); // FAULTED 不 advance：阻断全部，仅 recover() 解锁
      resolve({ requestId: request.requestId, state: 'failed', error: `release-failed: ${message}` });
      return;
    }
    if (cancelledExternally()) return; // F6：release 期间被外部 cancel 结算，不再二次 advance

    if (this.repo) {
      this.repo.markTerminal(request.requestId, 'completed', { result: result ?? null, executionId: result?.executionId });
    }
    resolve({ requestId: request.requestId, state: 'completed', result: result ?? null });
    this.advance();
  }

  /** 完成当前 worker，回到 idle 并尝试取下一条。 */
  advance() {
    this.activeRequestId = null;
    this.activeHandle = null;
    this.qState = Q_STATE.IDLE;
    this.pump();
  }

  /** FAULTED：阻断全部，仅显式 recover() 解锁（B14）。 */
  fault(reason) {
    this.qState = Q_STATE.FAULTED;
    this.faultReason = reason;
    this.activeRequestId = null;
    this.activeHandle = null;
  }

  /** 显式解锁 FAULTED（调用方确认 Runtime 已清）。@returns boolean 是否发生了解锁 */
  recover() {
    if (this.qState !== Q_STATE.FAULTED) return false;
    this.qState = Q_STATE.IDLE;
    this.faultReason = null;
    this.pump();
    return true;
  }

  /** 重启恢复（B17）：未完成行全部 interrupted，不重放。@returns 恢复条数 */
  recoverFromRestart() {
    if (!this.repo) return 0;
    return this.repo.markInterruptedAll();
  }

  /**
   * 取消：pending 直接 cancelled；活动项走 STOPPING（cancel + release 确认）。
   * 释放失败 → FAULTED（与超时路径同口径）。
   */
  async cancel(requestId) {
    if (this.disposed) return { requestId, state: 'cancelled' };
    const idx = this.pending.findIndex((e) => e.request.requestId === requestId);
    if (idx >= 0) {
      const [entry] = this.pending.splice(idx, 1);
      if (this.repo) this.repo.markTerminal(requestId, 'cancelled', { error: 'cancelled-while-queued' });
      entry.resolve({ requestId, state: 'cancelled' });
      return { requestId, state: 'cancelled' };
    }
    if (this.activeRequestId !== requestId) return { requestId, state: 'not-found' };

    // F6：命中活动项——先精确结算句柄、清 timer、abort 底层 execute，让该 runOne 的
    // race 脱离且不再 advance，避免两条 runOne 交错覆盖 qState / 重复消费。
    const handle = this.activeHandle && this.activeHandle.requestId === requestId ? this.activeHandle : null;
    this.qState = Q_STATE.STOPPING;
    if (handle && !handle.cancelled) {
      handle.cancelled = true;
      this.clock.clearTimeout(handle.timer);
      try { handle.controller.abort(new DOMException('queue-cancel', 'AbortError')); } catch { /* 忽略 */ }
      handle.timeoutReject(new Error('cancelled-by-cancel'));
      handle.resolve({ requestId, state: 'cancelled' });
    }
    const budget = this.stoppingBudgetMs(handle || { timeoutMs: 30_000 });
    try {
      if (typeof this.executor.cancel === 'function') {
        await this.withTimeout(this.executor.cancel({ requestId }), budget, 'cancel-timeout');
      }
      await this.withTimeout(this.executor.release({ requestId }), budget, 'release-timeout');
      if (this.repo) this.repo.markTerminal(requestId, 'cancelled', { error: 'cancelled-while-running' });
      this.advance();
      return { requestId, state: 'cancelled' };
    } catch (error) {
      const message = String(error && error.message || error);
      if (this.repo) this.repo.markTerminal(requestId, 'failed', { error: `cancel-failed: ${message}` });
      this.fault(message);
      return { requestId, state: 'failed', error: `cancel-failed: ${message}` };
    }
  }

  /** dispose：cancel 活动项 + pending 全部 cancelled 回执。幂等。 */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const activeId = this.activeRequestId;
    for (const entry of this.pending.splice(0, this.pending.length)) {
      if (this.repo) this.repo.markTerminal(entry.request.requestId, 'cancelled', { error: 'disposed-while-queued' });
      entry.resolve({ requestId: entry.request.requestId, state: 'cancelled' });
    }
    if (activeId) {
      try {
        if (typeof this.executor.cancel === 'function') await this.executor.cancel({ requestId: activeId });
        await this.executor.release({ requestId: activeId });
      } catch { /* dispose 阶段尽力而为，不再 FAULTED */ }
      if (this.repo) this.repo.markTerminal(activeId, 'cancelled', { error: 'disposed-while-running' });
    }
    // F1：dispose 也中止底层 execute，避免后台轮询继续泄漏连接
    if (this.activeHandle) {
      try { this.activeHandle.controller.abort(new DOMException('queue-dispose', 'AbortError')); } catch { /* 忽略 */ }
      this.activeHandle = null;
    }
    this.activeRequestId = null;
    this.qState = Q_STATE.DISPOSED;
  }

  /** 只读快照（StatusReporter / l2d_action_status 消费，与动作执行零共享可变状态）。 */
  getState() {
    return {
      depth: this.pending.length,
      activeRequestId: this.activeRequestId,
      processing: this.qState === Q_STATE.RUNNING || this.qState === Q_STATE.STOPPING,
      faulted: this.qState === Q_STATE.FAULTED,
      state: this.qState,
    };
  }
}

function finishFailed(queue, request, resolve, error) {
  if (queue.repo) queue.repo.markTerminal(request.requestId, 'failed', { error });
  resolve({ requestId: request.requestId, state: 'failed', error });
}

function toReceipt(row) {
  return { requestId: row.requestId, state: row.state, error: row.error ?? undefined, result: row.result ?? undefined };
}
