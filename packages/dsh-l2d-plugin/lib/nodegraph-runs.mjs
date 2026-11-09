/**
 * nodegraph-runs —— 节点图执行注册表（纯内存，零依赖，同步实现）
 *
 * 职责（docs/nodegraph/SPEC.md §4 run 通道的执行簿记层）：
 *   - 给每次 /dsh-l2d/nodegraphs/run 分配的 executionId 建档，使 receipts/状态可回查；
 *   - 同图重入互斥：同名图已有 status==='running' 的记录 → begin 返回 busy
 *     （**按图隔离**粒度：不同图允许并行执行，同一图同时只允许一个 run）；
 *   - 取消传播：requestCancel 置标志，宿主包装的 executor 在下一批下发前感知并停止；
 *   - LRU 簿记：maxRecords（默认 20）上限，超出淘汰最旧记录（优先淘汰终态记录，
 *     全为 running 时淘汰最旧 running，保证 begin 永不失败）。
 *
 * 设计约束：
 *   - 全部同步纯内存实现，时钟经 options.now 注入，便于单测；
 *   - 不持久化：进程重启即清空，与「执行中状态」的生命周期天然一致；
 *   - get() 返回内部记录的直引用（路由层只读序列化；宿主 executor 需要读到
 *     cancelRequested 的实时值），调用方不得改写。
 */

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 终态映射：runNodegraph / HTTP 层结果 → 注册表终态。
 *   - ok:true  + status:'completed'            → 'completed'
 *   - ok:false + status 为数字（409/404/500/422 等路由层映射）→ 'failed'
 *   - reason === 'timeout'                     → 'timeout'
 *   - status:'stopped' + 已请求取消            → 'cancelled'
 *   - 其余（stopped 未取消 / rejected / 未知）  → 'failed'
 * @param {{cancelRequested: boolean}} rec
 * @param {unknown} result
 * @returns {'completed'|'failed'|'cancelled'|'timeout'}
 */
function mapTerminal(rec, result) {
  if (!isPlain(result)) return 'failed';
  if (result.ok === false && typeof result.status === 'number') return 'failed';
  if (result.status === 'completed') return 'completed';
  if (result.reason === 'timeout') return 'timeout';
  if (result.status === 'stopped') return rec.cancelRequested ? 'cancelled' : 'failed';
  return 'failed';
}

/**
 * @param {{
 *   maxRecords?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createRunRegistry(options = {}) {
  const maxRecords = Math.max(1, Math.floor(Number(options.maxRecords) || 20));
  const now = options.now || Date.now;
  /** 插入序即 begin 时间序：最旧在前，LRU 淘汰直接取队首侧。 */
  const records = new Map();

  /**
   * 登记一次执行。同名图已有 running 记录 → busy（返回既有 executionId）。
   * @param {string} executionId
   * @param {string} name
   * @returns {{ok: true, executionId: string} | {ok: false, reason: 'busy', executionId: string}}
   */
  function begin(executionId, name) {
    for (const rec of records.values()) {
      if (rec.name === name && rec.status === 'running') {
        return { ok: false, reason: 'busy', executionId: rec.executionId };
      }
    }
    while (records.size >= maxRecords) {
      // 淘汰最旧终态记录；全为 running 时退化为淘汰绝对最旧（保证 begin 不失败）。
      const keys = [...records.keys()];
      let victim = keys[0];
      for (const key of keys) {
        if (records.get(key).status !== 'running') {
          victim = key;
          break;
        }
      }
      records.delete(victim);
    }
    records.set(executionId, {
      executionId,
      name,
      startedAt: now(),
      status: 'running',
      cancelRequested: false,
      finishedAt: null,
      result: null,
    });
    return { ok: true, executionId };
  }

  /**
   * 请求取消：仅对 running 记录生效（终态/缺失记录返回 false，路由层映射 404）。
   * @param {string} executionId
   * @returns {boolean}
   */
  function requestCancel(executionId) {
    const rec = records.get(executionId);
    if (!rec || rec.status !== 'running') return false;
    rec.cancelRequested = true;
    return true;
  }

  /**
   * 落终态：写入 result 并按映射置 status/finishedAt。仅对 running 记录生效。
   * @param {string} executionId
   * @param {unknown} result  runNodegraph 返回值或路由层异常形状
   * @returns {boolean}
   */
  function finish(executionId, result) {
    const rec = records.get(executionId);
    if (!rec || rec.status !== 'running') return false;
    rec.result = isPlain(result) ? result : { ok: false, reason: 'invalid-result' };
    rec.finishedAt = now();
    rec.status = mapTerminal(rec, rec.result);
    return true;
  }

  /**
   * 最近记录摘要（不含 receipts/result 全文），最新在前。
   * @param {{limit?: number}} [query]
   */
  function list(query = {}) {
    const parsed = Math.floor(Number(query.limit));
    const limit = Number.isFinite(parsed) && parsed >= 0 ? parsed : maxRecords;
    const items = [];
    for (const rec of [...records.values()].reverse()) {
      if (items.length >= limit) break;
      items.push({
        executionId: rec.executionId,
        name: rec.name,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
        status: rec.status,
        cancelRequested: rec.cancelRequested,
      });
    }
    return items;
  }

  /**
   * 完整记录（含 result 全文）；不存在返回 null（路由层映射 404）。
   * @param {string} executionId
   * @returns {object | null}
   */
  function get(executionId) {
    return records.get(executionId) || null;
  }

  return { begin, requestCancel, finish, list, get };
}
