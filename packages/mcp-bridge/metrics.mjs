/**
 * OACA-4 · 指标收集器（纯内存、无 I/O、可单测）。
 *
 * 存在理由（用户 OACA 方案 §五「可观测性」）：要让「LLM 只在编译期出现、运行时 0 LLM」
 * 变成**可验证的数字**而不是口号，必须把三类提示词调用与运行时调用分开计数：
 *  - chatPromptCount   聊天提示词（对话主链路）
 *  - actionPromptCount 动作编译期提示词（compileModelActions / ai-plan 这类用户主动编译）
 *  - agentPromptCount  Agent 侧提示词（工作区规划等）
 *  - runtimeCallCount  运行时入口调用次数（不含 LLM 的网络入口，如 /ai-action.json 被请求）
 *  - runtimeLlmCallCount 运行时**真实** LLM 调用次数 —— 隔离目标就是让它可被观察
 *
 * 纪律（不伪报，本模块最容易被滥用成假指标）：
 *  - Token 三态：actual 拿不到就落 `unavailable: true` 且 `actual: null`，
 *    **绝不用字符数/估算值冒充 actual**；estimated 只放显式声明的估算值。
 *  - cacheHitRate 分母为 0 时返回 null（没有缓存事件 ≠ 命中率 100%）。
 *  - 纯函数式累加器，不写文件、不发请求、不读时钟：计数器在单测里可完全确定。
 */

/** 允许的计数器名（拼错必须抛错，避免指标静默丢失）。 */
export const COUNTER_NAMES = Object.freeze([
  'chatPromptCount',
  'actionPromptCount',
  'agentPromptCount',
  'runtimeCallCount',
  'runtimeLlmCallCount',
]);

function emptyCounters() {
  return Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
}

function isNonNegativeFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * @returns {{
 *   increment: (name: string, by?: number) => number,
 *   recordCacheHit: (by?: number) => void,
 *   recordCacheMiss: (by?: number) => void,
 *   recordCache: (hit: boolean, by?: number) => void,
 *   recordTokens: (input: {actual?: number|null, estimated?: number|null}) => void,
 *   snapshot: () => {counters: object, cacheHitRate: number|null, tokens: {actual: number|null, estimated: number|null, unavailable: boolean}, cache: {hits: number, misses: number}},
 *   reset: () => void,
 * }}
 */
export function createMetrics() {
  let counters = emptyCounters();
  let hits = 0;
  let misses = 0;
  // actual / estimated 均为「累计值」；null = 至今没有任何可信数值（≠ 0）。
  let tokenActual = null;
  let tokenEstimated = null;

  function increment(name, by = 1) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) {
      throw new Error(`metrics.increment: 未知计数器 ${String(name)}（合法值：${COUNTER_NAMES.join(', ')}）`);
    }
    if (!isNonNegativeFinite(by)) throw new Error(`metrics.increment: 增量必须是 ≥0 的有限数，收到 ${String(by)}`);
    counters[name] += by;
    return counters[name];
  }

  function recordCacheHit(by = 1) {
    if (!isNonNegativeFinite(by)) throw new Error(`metrics.recordCacheHit: 增量必须是 ≥0 的有限数，收到 ${String(by)}`);
    hits += by;
  }

  function recordCacheMiss(by = 1) {
    if (!isNonNegativeFinite(by)) throw new Error(`metrics.recordCacheMiss: 增量必须是 ≥0 的有限数，收到 ${String(by)}`);
    misses += by;
  }

  function recordCache(hit, by = 1) {
    if (hit) recordCacheHit(by);
    else recordCacheMiss(by);
  }

  /**
   * 记录 Token 用量。actual 缺失/非法时**不累加**（保持 null → unavailable），
   * 只有真实数值才进 actual；estimated 同理但单独累计。
   */
  function recordTokens(input = {}) {
    const { actual, estimated } = input || {};
    if (isNonNegativeFinite(actual)) tokenActual = (tokenActual ?? 0) + actual;
    if (isNonNegativeFinite(estimated)) tokenEstimated = (tokenEstimated ?? 0) + estimated;
  }

  function snapshot() {
    const total = hits + misses;
    return {
      counters: { ...counters },
      cacheHitRate: total === 0 ? null : hits / total,
      cache: { hits, misses },
      tokens: {
        actual: tokenActual,
        estimated: tokenEstimated,
        // actual 缺失即 unavailable：明确告诉消费方"这个数是拿不到的"，而不是给个 0
        unavailable: tokenActual === null,
      },
    };
  }

  function reset() {
    counters = emptyCounters();
    hits = 0;
    misses = 0;
    tokenActual = null;
    tokenEstimated = null;
  }

  return { increment, recordCacheHit, recordCacheMiss, recordCache, recordTokens, snapshot, reset };
}
