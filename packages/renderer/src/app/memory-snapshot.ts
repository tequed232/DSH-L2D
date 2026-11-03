/**
 * P0 观测性：MemorySnapshot 适配层。
 *
 * 设计约束（docs/低配设备性能优化实施方案.md §P0）：
 * - 能读取的字段按运行环境能力分级；不支持的字段标记 unavailable，绝不伪造（尤其 GPU 显存）；
 * - 每个指标标注来源（source）、采样时间（sampledAt）和可用性（available）；
 * - JSON 导出不含聊天正文、文件路径、密钥或其他工作区敏感数据；
 * - Renderer 侧（浏览器）与插件 Host 侧（Node process）各自一份，指标能区分进程。
 */

export interface MemoryField {
  value: number | null;
  unit: 'bytes';
  available: boolean;
  /** 数据来源：performance.memory / process.memoryUsage / unavailable */
  source: string;
  /** 不可得原因（available=false 时给出） */
  reason?: string;
}

export interface MemorySnapshot {
  /** 指标归属进程：renderer（浏览器页面）或 plugin-host（Node 宿主） */
  process: 'renderer' | 'plugin-host';
  sampledAt: number;
  fields: Record<string, MemoryField>;
  /** 不可得字段名列表，方便一眼看出缺口 */
  unavailable: string[];
}

interface ChromiumMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function field(value: number | null, source: string, reason?: string): MemoryField {
  const available = value != null && Number.isFinite(value) && value >= 0;
  return available
    ? { value, unit: 'bytes', available: true, source }
    : { value: null, unit: 'bytes', available: false, source, reason: reason || 'not-available' };
}

function unavailableField(reason: string): MemoryField {
  return { value: null, unit: 'bytes', available: false, source: 'unavailable', reason };
}

/**
 * Renderer 侧快照（浏览器页面）。
 * Chromium 提供 performance.memory（jsHeap）；GPU 显存 Web 平台不暴露，永远标记 unavailable。
 */
export function collectBrowserMemorySnapshot(now: number = Date.now()): MemorySnapshot {
  const mem = (typeof performance !== 'undefined' ? (performance as { memory?: ChromiumMemory }).memory : undefined) as
    | ChromiumMemory
    | undefined;
  const heapSource = 'performance.memory';
  const fields: Record<string, MemoryField> = {
    jsHeapUsedBytes: mem
      ? field(mem.usedJSHeapSize, heapSource)
      : unavailableField('performance.memory-unsupported'),
    jsHeapTotalBytes: mem
      ? field(mem.totalJSHeapSize, heapSource)
      : unavailableField('performance.memory-unsupported'),
    jsHeapLimitBytes: mem ? field(mem.jsHeapSizeLimit, heapSource) : unavailableField('performance.memory-unsupported'),
    // Web 平台拿不到 GPU 显存读数，明确标 unavailable，不伪造估算值
    gpuMemoryBytes: unavailableField('gpu-memory-not-exposed-by-platform'),
  };
  return {
    process: 'renderer',
    sampledAt: now,
    fields,
    unavailable: Object.keys(fields).filter((k) => !fields[k].available),
  };
}

interface NodeMemoryUsage {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers?: number;
}

/**
 * 插件 Host 侧快照（Node 宿主进程，process.memoryUsage）。
 * 与 Renderer 侧完全独立，进程归属标 plugin-host。
 */
export function collectProcessMemorySnapshot(now: number = Date.now()): MemorySnapshot {
  const proc = (globalThis as { process?: { memoryUsage?: () => NodeMemoryUsage } }).process;
  const usage = proc && typeof proc.memoryUsage === 'function' ? proc.memoryUsage() : undefined;
  const source = 'process.memoryUsage';
  const fields: Record<string, MemoryField> = {
    rssBytes: usage ? field(usage.rss, source) : unavailableField('process-unavailable'),
    jsHeapUsedBytes: usage ? field(usage.heapUsed, source) : unavailableField('process-unavailable'),
    jsHeapTotalBytes: usage ? field(usage.heapTotal, source) : unavailableField('process-unavailable'),
    externalBytes: usage ? field(usage.external, source) : unavailableField('process-unavailable'),
    arrayBuffersBytes:
      usage && usage.arrayBuffers != null
        ? field(usage.arrayBuffers, source)
        : unavailableField('arraybuffers-not-exposed'),
    gpuMemoryBytes: unavailableField('gpu-memory-not-exposed-by-platform'),
  };
  return {
    process: 'plugin-host',
    sampledAt: now,
    fields,
    unavailable: Object.keys(fields).filter((k) => !fields[k].available),
  };
}

/** 通用快照采集器：由调用方注入 collect（浏览器/进程各自选择），支持定时采样与历史留存。 */
export function createMemorySampler(options: {
  collect: (now?: number) => MemorySnapshot;
  intervalMs?: number;
  keep?: number;
}) {
  const collect = options.collect;
  const intervalMs = Math.max(1, options.intervalMs ?? 5000);
  const keep = Math.max(1, options.keep ?? 12);
  let timer: ReturnType<typeof setInterval> | null = null;
  const history: MemorySnapshot[] = [];

  return {
    /** 立即采样一次并写入历史 */
    sample(now: number = Date.now()): MemorySnapshot {
      const snap = collect(now);
      history.push(snap);
      while (history.length > keep) history.shift();
      return snap;
    },
    start(): void {
      if (timer != null) return;
      timer = setInterval(() => this.sample(), intervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    },
    stop(): void {
      if (timer != null) clearInterval(timer);
      timer = null;
    },
    history(): readonly MemorySnapshot[] {
      return history;
    },
    toJSON(): { process: string; sampledAt: number; latest: MemorySnapshot; history: MemorySnapshot[] } {
      return { process: history.length ? history[history.length - 1].process : 'unknown', sampledAt: Date.now(), latest: history[history.length - 1] ?? null, history: [...history] };
    },
  };
}

/** JSON 导出：MemorySnapshot 本身已是纯数值 + 可用性标记，可直接序列化。 */
export function snapshotToJSON(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    process: snapshot.process,
    sampledAt: snapshot.sampledAt,
    fields: snapshot.fields,
    unavailable: [...snapshot.unavailable],
  };
}
