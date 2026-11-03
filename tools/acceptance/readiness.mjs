/**
 * m1-smoke 就绪门禁（--readiness-wait）：把「宿主页 overlay 模型挂载延迟」固化成一等公民。
 *
 * 背景（docs/M1-F2-BASELINE.md §六）：3081 实例的 HTTP 早就 200，但 overlay 的 Cubism 模型
 * 还在异步挂载、或页面根本没在 poll——此时直接跑用例只会把环境问题记成 M1 用例 FAIL。
 * 门禁把「连得上」拆成三层，逐层判定后再决定是否进场：
 *
 *   L0 服务连通   GET /ai/result?id=0 → 200（进程在听端口）
 *   L1 消费者在线 发 l2d_get_state，限时内拿到回执（说明有页面在 poll AI 队列）
 *   L2 模型就绪   回执 ready===true（overlay 的 L.isReady()，模型已挂载）
 *
 * 分类（按第一处未达标层取）：
 *   READY          三层全绿 → 进场跑用例
 *   NO-CONSUMER    L0 通、L1 无回执 → AI 队列无人消费（页面没开 / 旧 overlay 降级）
 *   MODEL-LOADING  L1 通、L2 ready=false → 模型异步挂载中，值得继续等
 *   BLOCKED        L0 就不通（进程没起 / 端口错）
 *
 * 上限轮询：waitForReadiness 只在 [0, maxWaitMs] 内轮次探测，不无限等；到期仍未 READY
 * 即整体 BLOCKED（m1-smoke 侧 exit 3）——不可得就记不可得，绝不伪造 PASS。
 */
export const STATES = Object.freeze({
  READY: 'READY',
  MODEL_LOADING: 'MODEL-LOADING',
  NO_CONSUMER: 'NO-CONSUMER',
  BLOCKED: 'BLOCKED',
  SKIP: 'SKIP',
});

export const LAYERS = Object.freeze({
  L0: 'L0 服务连通',
  L1: 'L1 消费者在线',
  L2: 'L2 模型就绪',
});

export const DEFAULT_READINESS_WAIT_MS = 30000; // 裸 --readiness-wait 的上限
export const DEFAULT_READINESS_INTERVAL_MS = 1000;
export const DEFAULT_CONSUMER_TIMEOUT_MS = 3000; // L1/L2 单次探测的回执超时

export const EXIT_BLOCKED = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '?';
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
}

/**
 * 纯分类：探针结果 → 分层状态 + 结论。
 *
 * @param {{connected?:boolean, httpStatus?:number, error?:string,
 *          served?:boolean, latencyMs?:number, modelReady?:boolean|null}} probe
 * @returns {{ok:boolean, state:string, layer:string, layers:Array, exitCode:number}}
 */
export function classifyReadiness(probe) {
  const p = probe || {};
  const connected = p.connected === true;
  const served = connected && p.served === true;
  const modelReady = served && p.modelReady === true;
  const layers = [];

  layers.push({
    layer: LAYERS.L0,
    state: connected ? STATES.READY : STATES.BLOCKED,
    detail: connected
      ? `HTTP ${p.httpStatus || 200}`
      : p.error
        ? `连接失败：${p.error}`
        : `HTTP ${p.httpStatus || 0}`,
  });
  layers.push({
    layer: LAYERS.L1,
    state: !connected ? STATES.SKIP : served ? STATES.READY : STATES.NO_CONSUMER,
    detail: !connected
      ? '上游未就绪，不探测'
      : served
        ? `l2d_get_state 回执 ${fmtMs(p.latencyMs)}`
        : `l2d_get_state ${fmtMs(p.latencyMs)} 内无回执（AI 队列无人 poll）`,
  });
  layers.push({
    layer: LAYERS.L2,
    state: !served ? STATES.SKIP : modelReady ? STATES.READY : STATES.MODEL_LOADING,
    detail: !served ? '上游未就绪，不探测' : modelReady ? 'get_state ready=true' : `get_state ready=${String(p.modelReady)}`,
  });

  const bad = layers.find((l) => l.state !== STATES.READY && l.state !== STATES.SKIP);
  const state = bad ? bad.state : STATES.READY;
  return {
    ok: state === STATES.READY,
    state,
    layer: bad ? bad.layer : LAYERS.L2,
    layers,
    exitCode: state === STATES.READY ? 0 : EXIT_BLOCKED,
  };
}

/**
 * 上限轮询。probeFn(round) 每轮返回一个探针结果；READY 立即返回，否则等到 maxWaitMs 上限。
 * 每轮非 READY 时回调 onTick（用于打轮次进度行）。
 *
 * @param {(round:number)=>Promise<object>} probeFn
 * @param {{maxWaitMs?:number, intervalMs?:number, onTick?:(t:object)=>void}} [opts]
 */
export async function waitForReadiness(probeFn, opts = {}) {
  const maxWaitMs = Number.isFinite(Number(opts.maxWaitMs))
    ? Math.max(0, Number(opts.maxWaitMs))
    : DEFAULT_READINESS_WAIT_MS;
  const intervalMs = Number.isFinite(Number(opts.intervalMs))
    ? Math.max(0, Number(opts.intervalMs))
    : DEFAULT_READINESS_INTERVAL_MS;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;

  const started = Date.now();
  const deadline = started + maxWaitMs;
  let rounds = 0;
  let verdict = null;

  for (;;) {
    rounds++;
    let probe;
    try {
      probe = await probeFn(rounds);
    } catch (e) {
      probe = { connected: false, error: (e && e.message) || String(e) };
    }
    verdict = classifyReadiness(probe);
    if (verdict.ok) break;
    const waitedMs = Date.now() - started;
    if (onTick) onTick({ round: rounds, verdict, waitedMs, maxWaitMs });
    if (Date.now() + intervalMs > deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return { ...verdict, rounds, waitedMs: Date.now() - started, maxWaitMs };
}

/** 单轮进度行（轮询期间用，避免长时间静默）。 */
export function formatTick(t) {
  const detail = (t.verdict.layers.find((l) => l.layer === t.verdict.layer) || {}).detail || '';
  return `  · 轮次 ${t.round}  ${t.verdict.state}  ${detail}  已等 ${fmtMs(t.waitedMs)}/${fmtMs(t.maxWaitMs)}`;
}

/** 收尾的分层状态块（每层一行 + 总结论）。 */
export function formatReadinessLines(result) {
  const lines = [
    `[m1-smoke] 就绪门禁（${result.ok ? STATES.READY : 'BLOCKED'} · ${result.rounds} 轮 · ` +
      `${fmtMs(result.waitedMs)}/${fmtMs(result.maxWaitMs)}）`,
  ];
  for (const l of result.layers) lines.push(`  ${l.layer}  ${l.state}  ${l.detail}`);
  if (result.ok) lines.push('[m1-smoke] READY：进场跑用例');
  else {
    const label = result.state === STATES.BLOCKED ? '服务不可达' : result.state;
    lines.push(`[m1-smoke] BLOCKED（${label}）——${result.layer} 未就绪；不跑用例、不写状态，exit ${EXIT_BLOCKED}`);
  }
  return lines;
}
