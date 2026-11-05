/**
 * 编译动作计划缓存（进程内 LRU，仅缓存可再生的编译产物）。
 *
 * 键 = `${modelHash}:${actionId}:${version}`；值为 compile(load(...)) 的产物
 * （编译计划，非实时参数状态/租约/执行上下文——禁项）。容量淘汰最旧（LRU，
 * 命中重插）。load 抛错不缓存失败结果，原样上抛（下次 resolve 重读——回退语义）。
 *
 * 一致性快照：getVersion 与 load 的同步读取在同一 snapshot 钩子内完成（如同一
 * 连接上 BEGIN IMMEDIATE … COMMIT 包裹），杜绝「版本读到 v2、内容读到 v1」错配。
 * load 允许返回 Promise（异步源）：其同步首段仍在快照内，await 之后的续段无法
 * 被同步事务覆盖，一致性由调用方保证（node:sqlite 为同步 API，主路径不受影响）。
 *
 * 并发合并：同键并发 resolve 共享同一个 in-flight Promise，只触发一次 load。
 * resolve 恒返回 Promise（同步 load 也会在微任务中执行，API 形状统一）。
 *
 * 禁项：禁 Redis 等外部缓存、禁新增表、禁缓存实时参数状态/租约/执行上下文。
 */

/** @param {{capacity?: number, getVersion: (actionId: string) => number, load: (actionId: string, version: number, modelHash: string|null) => any, compile?: (raw: any, ctx: {actionId: string, version: number, modelHash: string|null}) => any, snapshot?: <T>(fn: () => T) => T}} options */
export function createCompiledActionCache({
  capacity = 128,
  getVersion,
  load,
  compile = null,
  snapshot = null,
} = {}) {
  if (typeof getVersion !== 'function') throw new Error('createCompiledActionCache: getVersion 必填');
  if (typeof load !== 'function') throw new Error('createCompiledActionCache: load 必填');
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('createCompiledActionCache: capacity 须为正整数');
  if (snapshot !== null && typeof snapshot !== 'function') throw new Error('createCompiledActionCache: snapshot 须为函数');

  /** LRU：Map 保插入序，命中重插，超容淘汰最旧 */
  const entries = new Map();
  /** 同键 in-flight Promise（并发合并，避免重复读库） */
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, unbound: 0 };

  const keyPrefixOf = (modelHash) => {
    if (modelHash === null || modelHash === undefined || modelHash === '') {
      // 未绑模型：调用方未传 package_hash，键退化为 unbound 桶（统计单列计数）。
      stats.unbound++;
      return 'unbound';
    }
    return String(modelHash);
  };

  function store(key, value) {
    if (entries.has(key)) entries.delete(key);
    entries.set(key, value);
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      stats.evictions++;
    }
  }

  function keyStartsWith(prefix) {
    const out = [];
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  /**
   * 解析编译计划：getVersion（版本读取）→ 查缓存 → 未命中 load（SQLite）→
   * compile → 入缓存。版本与内容读取在同一 snapshot 钩子内完成。
   * @returns Promise<compiled>
   */
  function resolve(modelHash, actionId) {
    const prefix = keyPrefixOf(modelHash);
    const read = () => {
      const version = getVersion(actionId);
      const key = `${prefix}:${actionId}:${version}`;
      if (entries.has(key)) {
        // LRU 命中重插
        const value = entries.get(key);
        entries.delete(key);
        entries.set(key, value);
        stats.hits++;
        return Promise.resolve(value);
      }
      stats.misses++;
      const pending = inflight.get(key);
      if (pending) return pending;
      // load 同步首段在快照内执行；同步返回值当场编译入缓存（版本与内容同快照）
      let raw;
      try {
        raw = load(actionId, version, modelHash);
      } catch (err) {
        return Promise.reject(err); // 失败不缓存，原样上抛，下次重读
      }
      const compileIt = (r) => {
        const compiled = compile ? compile(r, { actionId, version, modelHash }) : r;
        store(key, compiled);
        return compiled;
      };
      if (raw && typeof raw.then === 'function') {
        const p = Promise.resolve(raw)
          .then(compileIt)
          .finally(() => { inflight.delete(key); });
        inflight.set(key, p);
        return p;
      }
      return Promise.resolve(compileIt(raw));
    };
    return snapshot ? snapshot(read) : read();
  }

  /** 失效：给 actionId 只清该动作，否则清该 modelHash 前缀全部。 */
  function invalidate(modelHash, actionId = null) {
    const prefix = modelHash === null || modelHash === undefined || modelHash === ''
      ? 'unbound'
      : String(modelHash);
    const scoped = actionId === null ? `${prefix}:` : `${prefix}:${actionId}:`;
    for (const key of keyStartsWith(scoped)) entries.delete(key);
  }

  function getStats() {
    return { ...stats, size: entries.size };
  }

  return { resolve, invalidate, getStats };
}
