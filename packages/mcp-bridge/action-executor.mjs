/**
 * HttpActionExecutor（PR-C，B18）——经 dev-server /ai/call + /ai/result 驱动浏览器侧。
 *
 * 链路（前置核查 A 结论：结果按 callId 持久于 ai-inbox 内存 Map，Node 可 GET 取回，
 * 无需浏览器改动）：
 *   execute: POST /ai/call {name:'l2d_act', args:{chain, priority, silent:true}}
 *            → {ok, id: callId} → 轮询 GET /ai/result?id=<callId>
 *            → 完成判定走 **event 通道**（action-done 的 end / interrupted）；
 *              result 通道的 {ok:false}（拒绝：priority-blocked / empty-chain）即时失败。
 *   cancel:  act 打断语义——POST 一条 FORCE 优先级的最小 act 抢占当前链，旧链得到
 *            interrupted 回执；不用 l2d_reset（reset 不打断 act 槽，且影响面大）。
 *   release: ⚠ 前置核查 B 结论：end 回执 ≠ 释放确认——ActGate 只管优先级槽位，
 *            ParamInjector 的 own 释放是 TTL 驱动，与 end 事件无同步关系，浏览器侧
 *            不存在释放信号。release() 实现为 TTL 宽限等待（releaseGraceMs，缺省 0），
 *            这是宽限而非伪确认；真正的完成+释放双确认需 Runtime 新增事件（后续 PR）。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpActionExecutor {
  /**
   * @param {object} deps
   * @param {string} [deps.baseUrl='http://127.0.0.1:5300'] dev-server 地址
   * @param {typeof fetch} [deps.fetchImpl] 注入（缺省全局 fetch）
   * @param {number} [deps.pollIntervalMs=250] /ai/result 轮询间隔
   * @param {number} [deps.releaseGraceMs=0] 释放宽限（TTL 自动释放，无信号，见头注）
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ baseUrl = 'http://127.0.0.1:5300', fetchImpl, pollIntervalMs = 250, releaseGraceMs = 0, log = () => {} } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('HttpActionExecutor: baseUrl 必填');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) throw new Error('HttpActionExecutor: pollIntervalMs 必须 ≥10ms');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.pollIntervalMs = pollIntervalMs;
    this.releaseGraceMs = releaseGraceMs;
    this.log = log;
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
   * @returns {Promise<{ok: boolean, executionId?: string, reason?: string, phase?: string}>}
   *          ok:true = end/interrupted 到达；ok:false = 链被拒绝（priority-blocked 等）。
   */
  async execute(request) {
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
    const callId = call.id;
    this.log(`execute ${request.requestId} → callId=${callId}`);

    // 轮询结果（间隔 pollIntervalMs；总时限由 queue 的 timeoutMs 驱动 cancel）
    for (;;) {
      await sleep(this.pollIntervalMs);
      const res = await this.fetchImpl(`${this.baseUrl}/ai/result?id=${encodeURIComponent(String(callId))}`, { cache: 'no-store' });
      if (!res.ok) continue; // 瞬时 4xx/5xx 不放弃，交给超时
      const body = await res.json().catch(() => ({}));
      // 拒绝：result 通道 ok:false（acceptedAct 同步回执的失败形态）
      if (body.ready && body.result && body.result.ok === false) {
        return { ok: false, executionId: String(callId), reason: body.result.reason || body.result.error || 'rejected' };
      }
      // 完成：event 通道 end / interrupted（act 的完成回执只走 event，见核查 A）
      const events = Array.isArray(body.events) ? body.events : [];
      const done = events.find((e) => e && e.type === 'action-done' && (e.phase === 'end' || e.phase === 'interrupted'));
      if (done) {
        this.log(`execute ${request.requestId} done phase=${done.phase}`);
        return { ok: true, executionId: String(callId), phase: done.phase };
      }
    }
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
    });
    if (!callRes.ok) throw new Error(`cancel: /ai/call ${callRes.status}`);
    this.log(`cancel ${request?.requestId ?? '(active)'} → FORCE 抢占已发`);
  }

  /**
   * 释放宽限（非释放确认——浏览器侧无释放信号，见头注核查 B）。
   * releaseGraceMs=0 时立即返回。
   */
  async release() {
    if (this.releaseGraceMs > 0) await sleep(this.releaseGraceMs);
  }
}
