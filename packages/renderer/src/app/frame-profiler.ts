/**
 * P0 观测性：FrameProfiler（帧间隔 / 帧耗时 / 丢帧 + P50/P95/P99 聚合）。
 *
 * 设计约束（docs/低配设备性能优化实施方案.md §P0）：
 * - 默认只保留低开销聚合：环形缓冲固定上限（默认 600 帧），不随时间增长；
 * - 高频明细（逐帧时间戳列表）由 detail 开关控制，默认关闭；
 * - 未启动 / 未注入时零成本：不创建 RAF、不碰帧循环；
 * - 百分位为纯函数，方便测试断言。
 *
 * 用法：
 *   const p = new FrameProfiler();
 *   p.start();                       // 被动采样：独立 RAF 只测帧间隔
 *   p.record(intervalMs, costMs);    // 或由宿主在帧循环里主动注入（间隔 + 帧耗时）
 *   p.aggregate();                   // { interval: {p50,p95,p99}, duration, droppedFrames, ... }
 *   p.stop(); p.reset();
 */

/** 线性插值百分位。values 必须是升序数组；空数组返回 null。 */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const clamped = Math.min(Math.max(p, 0), 1);
  const rank = clamped * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

/** 对任意样本集求 P50/P95/P99（内部拷贝排序，不改原数组）。 */
export function percentilesOf(values: readonly number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5) as number,
    p95: percentile(sorted, 0.95) as number,
    p99: percentile(sorted, 0.99) as number,
  };
}

export interface FrameProfilerOptions {
  /** 环形缓冲上限（帧），默认 600（约 10s@60Hz） */
  capacity?: number;
  /** 期望刷新率，用于丢帧判定，默认 60 */
  expectedFps?: number;
  /** 帧间隔超过 expectedInterval * dropFactor 记为丢帧，默认 1.5（60Hz 下 25ms） */
  dropFactor?: number;
  /** 高频明细开关，默认 false */
  detail?: boolean;
  /** 明细缓冲上限（条），默认 600 */
  detailCapacity?: number;
}

export interface FrameStatBlock {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  max: number | null;
}

export interface FrameAggregate {
  enabled: boolean;
  sampleCount: number;
  totalFrames: number;
  droppedFrames: number;
  dropRate: number | null;
  interval: FrameStatBlock;
  duration: FrameStatBlock | null;
  detail: Array<{ intervalMs: number; durationMs: number | null; ts: number }> | null;
  sampledAt: number;
  source: 'renderer.frame-profiler';
}

const DEFAULT_CAPACITY = 600;

export class FrameProfiler {
  private readonly capacity: number;
  private readonly expectedIntervalMs: number;
  private readonly dropFactor: number;
  private readonly detailEnabled: boolean;
  private readonly detailCapacity: number;

  private intervals: Float64Array;
  private durations: Float64Array;
  private durationSeen: Uint8Array;
  private head = 0; // 下一个写入位置
  private filled = 0; // 环内有效样本数

  private totalFrames = 0;
  private droppedFrames = 0;
  private intervalSum = 0;
  private intervalMax = 0;

  private detailBuffer: Array<{ intervalMs: number; durationMs: number | null; ts: number }> = [];

  private rafId: number | null = null;
  private lastRafTs = 0;
  private running = false;

  constructor(options: FrameProfilerOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.expectedIntervalMs = 1000 / Math.max(1, options.expectedFps ?? 60);
    this.dropFactor = Math.max(1, options.dropFactor ?? 1.5);
    this.detailEnabled = options.detail === true;
    this.detailCapacity = Math.max(1, Math.floor(options.detailCapacity ?? DEFAULT_CAPACITY));
    this.intervals = new Float64Array(this.capacity);
    this.durations = new Float64Array(this.capacity);
    this.durationSeen = new Uint8Array(this.capacity);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 记录一帧。intervalMs 必填（帧间隔）；durationMs 可选（帧耗时，来自宿主注入）。
   * 未 start 也可用（纯注入模式）。开销 O(1)。
   */
  record(intervalMs: number, durationMs?: number | null, now: number = Date.now()): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) return;
    const idx = this.head;
    this.intervals[idx] = intervalMs;
    if (durationMs != null && Number.isFinite(durationMs) && durationMs >= 0) {
      this.durations[idx] = durationMs;
      this.durationSeen[idx] = 1;
    } else {
      this.durationSeen[idx] = 0;
    }
    this.head = (idx + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;

    this.totalFrames++;
    this.intervalSum += intervalMs;
    if (intervalMs > this.intervalMax) this.intervalMax = intervalMs;
    if (intervalMs > this.expectedIntervalMs * this.dropFactor) this.droppedFrames++;

    if (this.detailEnabled) {
      this.detailBuffer.push({ intervalMs, durationMs: this.durationSeen[idx] ? this.durations[idx] : null, ts: now });
      if (this.detailBuffer.length > this.detailCapacity) this.detailBuffer.shift();
    }
  }

  /** 被动采样：独立 RAF 循环，只测帧间隔（帧耗时不可得，置 null）。不碰渲染帧循环。 */
  start(): void {
    if (this.running || typeof requestAnimationFrame !== 'function') return;
    this.running = true;
    this.lastRafTs = 0;
    const tick = (ts: number) => {
      if (!this.running) return;
      if (this.lastRafTs > 0) this.record(ts - this.lastRafTs, null, Date.now());
      this.lastRafTs = ts;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.lastRafTs = 0;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.totalFrames = 0;
    this.droppedFrames = 0;
    this.intervalSum = 0;
    this.intervalMax = 0;
    this.detailBuffer = [];
  }

  /** 聚合读数：对环内样本排序求 P50/P95/P99。仅在读取时计算，采样路径零排序开销。 */
  aggregate(): FrameAggregate {
    const n = this.filled;
    const intervalList: number[] = new Array(n);
    const durationList: number[] = [];
    // 未写满时样本占据 [0, filled)，写满后最老样本在 head
    const start = n < this.capacity ? 0 : this.head;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % this.capacity;
      intervalList[i] = this.intervals[idx];
      if (this.durationSeen[idx]) durationList.push(this.durations[idx]);
    }
    const intervalStats = this.statBlock(intervalList, this.intervalSum, this.intervalMax, this.totalFrames);
    const durationStats = durationList.length ? this.statBlock(durationList, -1, -1, durationList.length) : null;
    return {
      enabled: this.running,
      sampleCount: n,
      totalFrames: this.totalFrames,
      droppedFrames: this.droppedFrames,
      dropRate: this.totalFrames > 0 ? this.droppedFrames / this.totalFrames : null,
      interval: intervalStats,
      duration: durationStats,
      detail: this.detailEnabled ? [...this.detailBuffer] : null,
      sampledAt: Date.now(),
      source: 'renderer.frame-profiler',
    };
  }

  private statBlock(list: number[], sum: number, max: number, count: number): FrameStatBlock {
    if (!count) return { p50: null, p95: null, p99: null, mean: null, max: null };
    const ps = percentilesOf(list);
    const mean = sum >= 0 ? sum / count : list.reduce((a, b) => a + b, 0) / list.length;
    const maxVal = max >= 0 ? max : list.reduce((a, b) => (b > a ? b : a), -Infinity);
    return { p50: ps.p50, p95: ps.p95, p99: ps.p99, mean, max: maxVal };
  }

  /** JSON 导出：只含数值与可用性标记，不含聊天正文/路径/密钥。 */
  toJSON(): FrameAggregate {
    return this.aggregate();
  }
}
