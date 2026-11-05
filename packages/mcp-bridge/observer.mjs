/**
 * Workspace State Observer（SUPERVISOR-P12 / P1）。
 *
 * 职责（裁决书 §1 工作区 04）：只读观察各工作区状态 → 识别六种 WorkspaceStatus →
 * dispatchOnce 查重 → 按优先级交给注入的 onDispatch（不直改其他工作区上下文）。
 *
 * 状态源映射（docs/mcp-bridge/DATA-MODEL.md §4，字段级）：
 *   waiting_input   = substate waiting-approval（审批单未决）或 waiting-answer
 *                     （pendingTool 命中 ask-user）；子态新鲜度由 summarizeSession 的
 *                     ageSummaryState 编码（ageMs ≤ waitingHoldMs=600s），超期自动回落；
 *   waiting_subagent = jobs.runningCount>0 或 commands.runningCount>0（job 优先）；
 *   error           = state==='error'（turn/end error；errorHoldMs=600s 老化已由
 *                     ageSummaryState 编码）。⚠ 与 DATA-MODEL §4 的偏差：hasError 是
 *                     无时间戳布尔（见过错误即 true），不能做状态判定，否则陈旧值会
 *                     把 running 误判成 error——只认 state==='error'；
 *   succeeded       = lastTurnEnd.kind==='completed' 且 turn/end 是最新事件
 *                     （lastTurnEnd.time === lastEventAt，防旧 turn 压过新活动）；
 *   running         = pendingTool 在途（ask-user 已在 waiting-answer 拦截）；
 *   idle            = 老化后 idle/unknown。
 *
 * env-state 只修饰不判定：away → 本轮静默；stale(>30s) → 按 unknown 继续。
 *
 * dispatchOnce（Outbox 语义，observer_dispatch_log）：
 *   recordDispatchPending（INSERT OR IGNORE 抢占）→ onDispatch 成功 markDispatched /
 *   失败 markFailed；inserted:false 且 status∈{pending,failed} → 重试路径（崩溃恢复
 *   重放——状态条件持续存在，下一轮 poll 生成同一 eventId 命中 pending 行）；
 *   status==='dispatched' → 跳过（同事件恰好一次调度）。
 *
 * 依赖注入纪律：不 import 宿主模块——summary 由 source 注入（测试用真实
 * session-events.summarizeSession 产物），dedup/repo 形状注入，不直连宿主。
 */

import {
  recordDispatchPending,
  findDispatch,
  markDispatched as repoMarkDispatched,
  markFailed as repoMarkFailed,
} from '../dsh-l2d-db/src/observer-repo.mjs';

export const WORKSPACE_STATUSES = Object.freeze([
  'idle', 'running', 'error', 'waiting_subagent', 'waiting_input', 'succeeded',
]);

/** 调度优先级（裁决书 §2：error p100 > waiting_input p90 > waiting_subagent p75 > succeeded p40）。 */
export const STATUS_PRIORITY = Object.freeze({
  error: 100,
  waiting_input: 90,
  waiting_subagent: 75,
  succeeded: 40,
  running: 10,
  idle: 0,
});

const MIN_POLL_MS = 30_000;
const MAX_POLL_MS = 120_000;

/**
 * 六态归类（纯函数）。互斥判定，顺序即会话内优先级（waiting_input 最先——
 * 与 waiting_subagent 互斥，杜绝代答；见 DATA-MODEL §4）。
 * @param {object} summary summarizeSession 产物（老化后）
 * @returns {{status: string, taskId: string|null, waitingAgentId: string|null, errorCode: string|null, reason: string}}
 */
export function classifyWorkspaceStatus(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const state = String(s.state || 'idle');

  // 1. waiting_input（裁决书 §2：不得代答）
  if (s.substate === 'waiting-approval') {
    const approval = Array.isArray(s.approvals?.pending) ? s.approvals.pending[0] : null;
    return { status: 'waiting_input', taskId: null, waitingAgentId: approval ? String(approval.id) : null, errorCode: null, reason: 'waiting-approval' };
  }
  if (s.substate === 'waiting-answer') {
    return { status: 'waiting_input', taskId: null, waitingAgentId: s.pendingTool ? String(s.pendingTool.callId || '') : null, errorCode: null, reason: 'waiting-answer' };
  }

  // 2. waiting_subagent（后台 job / command 在跑；job 优先）
  if ((state === 'thinking' || state === 'working') && ((s.jobs?.runningCount || 0) > 0 || (s.commands?.runningCount || 0) > 0)) {
    const job = Array.isArray(s.jobs?.running) && s.jobs.running.length ? s.jobs.running[0] : null;
    const command = !job && Array.isArray(s.commands?.running) && s.commands.running.length ? s.commands.running[0] : null;
    const taskId = job ? String(job.jobId) : command ? String(command.commandId) : null;
    return { status: 'waiting_subagent', taskId, waitingAgentId: job ? String(job.owner || '') : null, errorCode: null, reason: job ? 'background-job' : 'background-command' };
  }

  // 3. error（老化已编码：error 停留 errorHoldMs=600s 后回 idle）
  if (state === 'error') {
    return { status: 'error', taskId: null, waitingAgentId: null, errorCode: String(s.lastTurnEnd?.code || s.lastError || 'TURN_ERROR').slice(0, 64), reason: 'turn-error' };
  }

  // 4. succeeded（turn/end completed 是最新事件才有效，防旧 turn 压过新活动）
  if (s.lastTurnEnd && s.lastTurnEnd.kind === 'completed' && s.lastTurnEnd.time === s.lastEventAt) {
    return { status: 'succeeded', taskId: null, waitingAgentId: null, errorCode: null, reason: 'turn-completed' };
  }

  // 5. running（前台工具在途；老化到 idle 后 pendingTool 是陈旧残留，须以 state 守卫）
  if (s.pendingTool && state === 'working') {
    return { status: 'running', taskId: String(s.pendingTool.callId || ''), waitingAgentId: null, errorCode: null, reason: 'tool-in-flight' };
  }

  // 6. idle（老化后 idle / unknown / 空会话）
  return { status: 'idle', taskId: null, waitingAgentId: null, errorCode: null, reason: state === 'unknown' ? 'unknown' : 'idle' };
}

/**
 * 组装 WorkspaceEvent（裁决书 §2 形状）。eventId = sessionId:seq:status——
 * seq 取事件流末位序号（JSONL 每行 seq 单调），同条件同 seq 生成稳定 eventId
 * 供 dispatchOnce 查重；source 无法提供 seq 时退化 0 并由 eventId 缺失唯一性
 * 风险自担（调用方须保证 seq 单调，见 BOOTSTRAP-PHASE0 对账）。
 */
export function buildWorkspaceEvent({ workspaceId, sessionId, status, taskId = null, waitingAgentId = null, errorCode = null, seq = 0, timestamp = Date.now(), revision = 0 }) {
  if (!workspaceId) throw new Error('buildWorkspaceEvent: workspaceId 必填');
  if (!sessionId) throw new Error('buildWorkspaceEvent: sessionId 必填');
  if (!WORKSPACE_STATUSES.includes(status)) throw new Error(`buildWorkspaceEvent: status 非法 ${String(status)}`);
  return {
    eventId: `${sessionId}:${Number(seq) || 0}:${status}`,
    workspaceId: String(workspaceId),
    sessionId: String(sessionId),
    status,
    taskId: taskId == null ? undefined : String(taskId),
    waitingAgentId: waitingAgentId == null ? undefined : String(waitingAgentId),
    errorCode: errorCode == null ? undefined : String(errorCode),
    timestamp: Number(timestamp) || Date.now(),
    revision: Number(revision) || 0,
  };
}

/**
 * Workspace Observer：轮询源注入 + dispatchOnce 查重 + 优先级排序调度。
 */
export class WorkspaceObserver {
  /**
   * @param {object} deps
   * @param {object} deps.dedup observer-repo 形状（recordDispatchPending/findDispatch/markDispatched/markFailed）
   * @param {() => Array<{workspaceId, sessionId, summary, seq?, revision?, env?}>} deps.source 只读快照源（注入）
   * @param {(event: object) => Promise<void>|void} deps.onDispatch 调度指令出口（注入；Observer 不直改其他工作区）
   * @param {number} [deps.pollIntervalMs=60000] 30-120s 强约束（裁决书 §6；事件推送优先，轮询是兜底）
   * @param {{observer?: {enabled?: boolean}}} [deps.settings] observer.enabled 默认 true
   * @param {{setTimeout, clearTimeout, Date}} [deps.clock] 注入（测试 fake timer）
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ dedup, source, onDispatch, pollIntervalMs = 60_000, settings = {}, clock, log = () => {} } = {}) {
    if (!dedup || typeof dedup.recordDispatchPending !== 'function' || typeof dedup.markDispatched !== 'function') {
      throw new Error('WorkspaceObserver: dedup（observer-repo 形状）必填');
    }
    if (typeof source !== 'function') throw new Error('WorkspaceObserver: source 必填（只读快照注入）');
    if (typeof onDispatch !== 'function') throw new Error('WorkspaceObserver: onDispatch 必填（调度出口注入）');
    if (!Number.isFinite(Number(pollIntervalMs))) throw new Error('WorkspaceObserver: pollIntervalMs 必须是数字');
    // 裁决书 §6：轮询范围 30-120s，越界钳制（不 throw：轮询是兜底层，可用性优先）
    this.pollIntervalMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number(pollIntervalMs)));
    this.dedup = dedup;
    this.source = source;
    this.onDispatch = onDispatch;
    this.settings = settings;
    this.clock = clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), Date };
    this.log = log;
    this.timer = null;
    this.stopped = false;
    this.lastError = null;
    this.stats = { polls: 0, dispatched: 0, duplicates: 0, silenced: 0, failed: 0, pollErrors: 0, dispatchErrors: 0 };
  }

  start() {
    // M4：stop() 置位后，poll 在途的 finally 不得重新排程（原实现 poll 完成后
    // 无条件 start()，stop() 对已触发 timer 无效 → 观察器永远停不下来）。
    // start() 显式复位 stopped，支持 stop → start 重启生命周期。
    this.stopped = false;
    if (this.timer) return;
    this.timer = this.clock.setTimeout(() => {
      void this.poll()
        .catch((err) => {
          // L3：poll 异常不再静默吞掉——记 log + stats.pollErrors，连续失败可察觉
          this.lastError = String((err && err.message) || err);
          this.stats.pollErrors += 1;
          this.log(`poll failed: ${this.lastError}`);
        })
        .finally(() => {
          this.timer = null;
          if (!this.stopped) this.start();
        });
    }, this.pollIntervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() { this.stop(); }

  get enabled() { return this.settings?.observer?.enabled !== false; }

  /**
   * 一轮观察：source 快照 → 逐工作区 classify → 按优先级排序 → dispatchOnce。
   * @returns {Promise<Array<{workspaceId, eventId, status, outcome}>>}
   */
  async poll() {
    if (!this.enabled) return [];
    this.stats.polls += 1;
    const snapshots = this.source() || [];
    const pending = [];
    for (const snap of snapshots) {
      if (!snap || !snap.workspaceId || !snap.sessionId) continue;
      const verdict = classifyWorkspaceStatus(snap.summary);
      // idle 不产生调度事件（裁决书 §2：running/idle → 低频观察/回归待机）
      if (verdict.status === 'idle') {
        this.stats.silenced += 1;
        continue;
      }
      pending.push({ snap, verdict });
    }
    // 并发事件按优先级排序（obs.ordering.priority：p100 > p90 > p75 > p40）
    pending.sort((a, b) => (STATUS_PRIORITY[b.verdict.status] || 0) - (STATUS_PRIORITY[a.verdict.status] || 0));

    const results = [];
    for (const { snap, verdict } of pending) {
      // L3：单工作区故障（recordDispatchPending 抛错等）不得中断整轮——
      // try/catch 隔离，排在其后的工作区事件照常处理
      try {
        const event = buildWorkspaceEvent({
          workspaceId: snap.workspaceId,
          sessionId: snap.sessionId,
          status: verdict.status,
          taskId: verdict.taskId,
          waitingAgentId: verdict.waitingAgentId,
          errorCode: verdict.errorCode,
          seq: snap.seq,
          timestamp: this.clock.Date.now(),
          revision: snap.revision,
        });
        const outcome = await this.dispatchOnce(snap, event);
        results.push({ workspaceId: snap.workspaceId, eventId: event.eventId, status: verdict.status, outcome });
      } catch (error) {
        const msg = String((error && error.message) || error);
        this.stats.dispatchErrors += 1;
        this.lastError = msg;
        this.log(`dispatch setup failed for ${snap.workspaceId}: ${msg}`);
        results.push({ workspaceId: snap.workspaceId, eventId: null, status: verdict.status, outcome: 'error' });
      }
    }
    return results;
  }

  /**
   * dispatchOnce：同 (workspaceId, eventId) 恰好一次调度。
   * env 修饰在查重前（away 静默不消耗事件；stale 按 unknown 继续）。
   */
  async dispatchOnce(snap, event) {
    // env 只修饰不判定（DATA-MODEL §4）：离席静默，不登记不调度
    const env = snap.env;
    if (env && env.available && env.payload && env.payload.away === true) {
      this.stats.silenced += 1;
      return 'silenced-user-away';
    }

    const recorded = this.dedup.recordDispatchPending(event.workspaceId, event.eventId);
    if (!recorded.inserted) {
      const existing = this.dedup.findDispatch(event.workspaceId, event.eventId);
      const status = existing ? existing.status : recorded.status;
      if (status === 'dispatched') {
        this.stats.duplicates += 1;
        return 'duplicate';
      }
      // pending（崩溃恢复重放）/ failed（重试）→ 继续调度
      this.log(`replay ${event.eventId} (status=${status})`);
    }

    try {
      await this.onDispatch(event);
      this.dedup.markDispatched(event.workspaceId, event.eventId);
      this.stats.dispatched += 1;
      return 'dispatched';
    } catch (error) {
      this.dedup.markFailed(event.workspaceId, event.eventId, error && error.message || error);
      this.stats.failed += 1;
      this.lastError = String(error && error.message || error);
      return 'failed';
    }
  }
}

/** 便捷装配：把 observer-repo（db 绑定后）适配成 dedup 形状。 */
export function createDedupFromRepo(db) {
  return {
    recordDispatchPending: (workspaceId, eventId) => recordDispatchPending(db, workspaceId, eventId),
    findDispatch: (workspaceId, eventId) => findDispatch(db, workspaceId, eventId),
    markDispatched: (workspaceId, eventId) => repoMarkDispatched(db, workspaceId, eventId),
    markFailed: (workspaceId, eventId, error) => repoMarkFailed(db, workspaceId, eventId, error),
  };
}
