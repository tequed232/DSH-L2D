/**
 * UI 状态上报（PR-B，B05-B09）。
 *
 * 三原则之二：状态解耦——状态通道与模型动作执行完全独立，上报失败不影响动作，
 * 动作故障不停止上报。Reporter 只经注入的 source/getQueueState/getMemoryRevision
 * 读**只读快照**，与动作队列零共享可变状态。
 *
 * 语义（裁决书 §六全量）：
 *  - intervalMs 强校验 [30_000, 120_000]（B05/B07 构造时 throw）；
 *  - start() 先采一次（不阻塞定时器挂载）；
 *  - flush 非重入（running 锁）；
 *  - reportable = crashed / success / waiting；running 仅作快照附带，idle 不发（B06）；
 *  - status.revision === lastRevision 跳过（B09）；
 *  - sink.report 抛错 → lastRevision 不推进（下周期重试）；
 *  - stop()/dispose() 清定时器。
 *
 * clock 注入：测试用 fake timer（30s 下限使真实定时器不可用于单测），生产缺省
 * 走全局 setInterval/clearInterval。
 */

const REPORTABLE = Object.freeze(['crashed', 'success', 'waiting']);
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 120_000;

export class StatusReporter {
  /**
   * @param {object} deps
   * @param {string} deps.workspaceId
   * @param {number} deps.intervalMs 30_000–120_000
   * @param {{getLatest: () => Promise<UiStatusSnapshot>}} deps.source
   * @param {{report: (input: object) => Promise<void>}} deps.sink
   * @param {() => {depth: number, activeRequestId?: string}} deps.getQueueState
   * @param {() => Promise<number>} deps.getMemoryRevision
   * @param {{setInterval: Function, clearInterval: Function}} [deps.clock] 注入定时器（测试用）
   */
  constructor({ workspaceId, intervalMs, source, sink, getQueueState, getMemoryRevision, clock } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      throw new Error(`StatusReporter: intervalMs 必须在 [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}] 区间（收到 ${String(intervalMs)}）`);
    }
    if (!source || typeof source.getLatest !== 'function') throw new Error('StatusReporter: source.getLatest 必填');
    if (!sink || typeof sink.report !== 'function') throw new Error('StatusReporter: sink.report 必填');
    if (typeof getQueueState !== 'function') throw new Error('StatusReporter: getQueueState 必填');
    if (typeof getMemoryRevision !== 'function') throw new Error('StatusReporter: getMemoryRevision 必填');

    this.workspaceId = String(workspaceId ?? '');
    this.intervalMs = intervalMs;
    this.source = source;
    this.sink = sink;
    this.getQueueState = getQueueState;
    this.getMemoryRevision = getMemoryRevision;
    this.clock = clock ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };
    this.timer = null;
    this.lastRevision = -1;
    this.running = false;
    this.lastError = null;
    this.reportCount = 0;
  }

  start() {
    if (this.timer) return;
    void this.flush(); // 启动即采一次，不阻塞定时器挂载
    // 回调返回 flush promise：生产 setInterval 忽略之；注入 clock（测试）可 await 排空
    this.timer = this.clock.setInterval(() => this.flush(), this.intervalMs);
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      const status = await this.source.getLatest();
      // running 作快照附带字段，不独立上报；idle 默认不重复发送（B06）
      const reportable = REPORTABLE.includes(status.status);
      if (!reportable || status.revision === this.lastRevision) return; // B09：同 revision 跳过

      const queue = this.getQueueState();
      const memoryRevision = await this.getMemoryRevision();
      await this.sink.report({
        workspaceId: this.workspaceId,
        status, // crashed/success/waiting 全量；running/idle 不会走到这里
        queueDepth: queue.depth,
        activeRequestId: queue.activeRequestId,
        memoryRevision,
      });
      // 只有发送成功才推进 revision（B08/B09 依据）
      this.lastRevision = status.revision;
      this.reportCount += 1;
      this.lastError = null;
    } catch (error) {
      // 上报失败不改变 lastRevision，下周期重试
      this.lastError = String(error && error.message || error);
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  dispose() {
    this.stop();
  }
}

/**
 * 内存状态源：dev-server 与测试共用。push 即 revision 自增（单调），
 * running/idle 也占 revision——Reporter 侧负责「是否上报」的判定。
 */
export class InMemoryStatusSource {
  constructor() {
    this.snapshot = { status: 'idle', message: '', errorCode: '', revision: 0, updatedAt: Date.now() };
  }

  /** @param {{status: UiStatus, message?: string, errorCode?: string}} input */
  push({ status, message = '', errorCode = '' }) {
    this.snapshot = { status: String(status), message: String(message), errorCode: String(errorCode), revision: this.snapshot.revision + 1, updatedAt: Date.now() };
    return { ...this.snapshot };
  }

  /** @returns {Promise<UiStatusSnapshot>} 只读快照（副本） */
  async getLatest() {
    return { ...this.snapshot };
  }
}
