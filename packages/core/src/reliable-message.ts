/**
 * P3 消息可靠性地基（不涉及 Worker）。
 *
 * 文档《低配设备性能优化实施方案》P3 协议要求：
 * - 消息必须包含 sequence、requestId、type、timestamp 和版本化 payload；
 * - 状态快照可按 key 合并到最新值；动作请求、动作回执、错误、ACK、取消逐条保留，绝不合并/丢弃；
 * - 关键事件使用单调 sequence；超时重试必须幂等，接收端按 (type, requestId) 去重；
 * - 队列达到高水位时丢最旧的可合并 state 帧，动作事件永不上背压丢弃，且如实上报。
 *
 * 本文件全部为纯函数，无 I/O、无时钟依赖（timestamp 由调用方传入或缺省补齐）。
 */

export const RELIABLE_MESSAGE_SCHEMA_VERSION = 1;

/** 进入信封前的原始消息：type 必填，其余字段缺省时由 envelopeMessage 补齐。 */
export interface ReliableMessage {
  type: string;
  requestId?: string;
  timestamp?: number;
  /** state 帧的合并键（约定为 workspace + entity 组合）；无 key 的 state 帧不参与合并。 */
  key?: string;
  payload?: unknown;
  [extra: string]: unknown;
}

/** 补全后的消息信封。sequence 必须由调用方保证单调递增且唯一。 */
export interface ReliableEnvelope {
  sequence: number;
  requestId: string;
  type: string;
  timestamp: number;
  schemaVersion: number;
  key?: string;
  payload?: unknown;
  [extra: string]: unknown;
}

/** sequence 缺口（闭区间 [from, to]），由 reorder 检出。 */
export interface SequenceGap {
  from: number;
  to: number;
}

export interface BackpressureResult<T> {
  kept: T[];
  dropped: T[];
}

export interface RetryOptions {
  /** 最大重试次数（不含首次尝试），默认 3。 */
  retries?: number;
  /** 首次退避毫秒数，指数递增（backoffMs * 2^attempt）。默认 0（立即重试，测试友好）。 */
  backoffMs?: number;
}

/**
 * 幂等键：与 deduplicate 使用同一把 key。
 * 发送方重试时保持相同 requestId，接收端即可据此去重。
 */
export function idempotencyKey(msg: { type: string; requestId?: string }): string {
  return msg.type + '\u0000' + (msg.requestId ?? '');
}

/**
 * 单调递增 sequence 发生器（模块外自持状态，纯函数管线之外使用）。
 */
export function createSequence(start = 0): () => number {
  let n = start;
  return () => ++n;
}

/**
 * 消息信封补全：包装 sequence、requestId、type、timestamp、schemaVersion。
 * 调用方传入的 seq 必须是正整数且全局单调递增；消息内已有的
 * sequence / schemaVersion 一律以信封权威值覆盖，避免伪造旧序号。
 */
export function envelopeMessage(msg: ReliableMessage, seq: number): ReliableEnvelope {
  if (!msg || typeof msg.type !== 'string' || !msg.type) {
    throw new TypeError('reliable message requires a non-empty "type"');
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError('sequence must be a positive integer (monotonic, caller-owned)');
  }
  const { type, requestId, timestamp, key, payload, ...rest } = msg;
  delete rest.sequence;
  delete rest.schemaVersion;
  const envelope: ReliableEnvelope = {
    sequence: seq,
    requestId: requestId != null ? String(requestId) : `seq-${seq}`,
    type,
    timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now(),
    schemaVersion: RELIABLE_MESSAGE_SCHEMA_VERSION,
    ...rest,
  };
  if (key !== undefined) envelope.key = key;
  if (payload !== undefined) envelope.payload = payload;
  return envelope;
}

/**
 * 按 (type, requestId) 去重，保留最新（sequence 最大；同序号取 timestamp 更新者）。
 * 输出按 sequence 升序。动作/ACK 的重复投递与 state 帧的重发都收敛到一条。
 */
export function deduplicate<T extends ReliableEnvelope>(messages: T[]): T[] {
  const best = new Map<string, T>();
  for (const m of messages) {
    const k = idempotencyKey(m);
    const prev = best.get(k);
    if (!prev) {
      best.set(k, m);
      continue;
    }
    if (m.sequence > prev.sequence) best.set(k, m);
    else if (m.sequence === prev.sequence && (m.timestamp ?? 0) >= (prev.timestamp ?? 0)) best.set(k, m);
  }
  return [...best.values()].sort(bySequence);
}

/**
 * 按 sequence 排序（稳定），并检测缺口（缺号区间，闭区间列表）。
 * 重复 sequence（重复投递）不产生缺口；去重请先走 deduplicate。
 */
export function reorder<T extends ReliableEnvelope>(messages: T[]): { ordered: T[]; gaps: SequenceGap[] } {
  if (messages.length === 0) return { ordered: [], gaps: [] };
  const ordered = [...messages].sort(bySequence);
  const seen = [...new Set(ordered.map((m) => m.sequence))].sort((a, b) => a - b);
  const gaps: SequenceGap[] = [];
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] !== seen[i - 1] + 1) gaps.push({ from: seen[i - 1] + 1, to: seen[i] - 1 });
  }
  return { ordered, gaps };
}

/**
 * 白名单：只有 type=state（含 state.* 前缀）且带 key 的帧可合并。
 * 动作（action*）、回执（receipt*）、错误（error*）、ACK（ack*）、取消（cancel*）
 * 等离散事件均不匹配该白名单，逐条保留——这是 P3 的硬规则。
 */
export function isCoalescableStateFrame(msg: { type: string }): boolean {
  return msg.type === 'state' || msg.type.startsWith('state.');
}

function isKeyedStateFrame<T extends ReliableEnvelope>(msg: T): msg is T & { key: string } {
  return isCoalescableStateFrame(msg) && typeof msg.key === 'string' && msg.key.length > 0;
}

function bySequence(a: ReliableEnvelope, b: ReliableEnvelope): number {
  return a.sequence - b.sequence;
}

/**
 * 状态帧 latest-value 合并：同 key 的可合并 state 帧只保留 sequence 最新一条。
 * 非 state 帧（动作/回执/错误/ACK/取消）与无 key 的 state 帧原样保留。
 * 输出按 sequence 升序（消费侧语义：快照按最终态应用）。
 */
export function coalesceStateFrames<T extends ReliableEnvelope>(messages: T[]): T[] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort(bySequence);
  const latestByKey = new Map<string, T>();
  for (const m of sorted) {
    if (isKeyedStateFrame(m)) latestByKey.set(m.key, m);
  }
  if (latestByKey.size === 0) return sorted;
  return sorted.filter((m) => !(isKeyedStateFrame(m) && latestByKey.get(m.key) !== m));
}

/**
 * 队列背压：超过 highWaterMark 时，先丢「每 key 最新之外」的旧 state 帧，
 * 再丢每 key 最新 state 帧（最后手段）；动作/回执/错误/ACK/取消绝不丢弃。
 * 若不可丢事件本身超过水位，kept 会如实超过水位（上报而非静默丢关键事件）。
 * dropped 按丢弃顺序（先旧后新）排列，供上层上报（文档：不静默 drop）。
 */
export function backpressure<T extends ReliableEnvelope>(messages: T[], highWaterMark: number): BackpressureResult<T> {
  if (!Number.isInteger(highWaterMark) || highWaterMark < 0) {
    throw new RangeError('highWaterMark must be a non-negative integer');
  }
  const sorted = [...messages].sort(bySequence);
  if (sorted.length <= highWaterMark) return { kept: sorted, dropped: [] };

  const keyedState = sorted.filter(isKeyedStateFrame);
  if (keyedState.length === 0) return { kept: sorted, dropped: [] };

  // 每 key 最新帧最后丢；其余旧 state 帧按 sequence 从旧到新丢。
  const latestByKey = new Map<string, T>();
  for (const m of keyedState) latestByKey.set(m.key, m);
  const dropOrder = [...keyedState].sort((a, b) => {
    const la = latestByKey.get(a.key) === a ? 1 : 0;
    const lb = latestByKey.get(b.key) === b ? 1 : 0;
    return la - lb || a.sequence - b.sequence;
  });

  let overflow = sorted.length - highWaterMark;
  const droppedSet = new Set<T>();
  for (const candidate of dropOrder) {
    if (overflow <= 0) break;
    droppedSet.add(candidate);
    overflow--;
  }
  if (droppedSet.size === 0) return { kept: sorted, dropped: [] };

  const dropped = dropOrder.filter((m) => droppedSet.has(m));
  const kept = sorted.filter((m) => !droppedSet.has(m));
  return { kept, dropped };
}

/**
 * 带重试的执行包装：失败后按指数退避重试（retries 次），重试耗尽抛最后错误。
 * 幂等语义：重试时由调用方对同一逻辑操作保持相同 requestId，
 * 接收端用 deduplicate（同 (type, requestId) 保留一条）完成幂等。
 */
export async function withRetry<T>(fn: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 0;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('retries must be a non-negative integer');
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}
