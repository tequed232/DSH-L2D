/**
 * 部位联动 bridge 的宿主侧 HTTP 处理器（传输无关，index.js 路由只读 body / 发 JSON）。
 *
 *   GET  /dsh-l2d/api/bridge/table?model=X → handleTable：分区表原文（overlay 启动时拉它建权威实例）
 *   GET  /dsh-l2d/api/bridge/state         → handleState：转发 l2d_regions_get，返回 overlay 的占用快照
 *   POST /dsh-l2d/api/bridge/act           → handleAct：静态校验（同一份 body-bridge.mjs）后转发 l2d_regions_act
 *   POST /dsh-l2d/api/bridge/release       → handleRelease：转发 l2d_regions_release
 *
 * 宿主不持有占用状态：谁占着哪个模块只有 overlay 里那一个 createBridge 实例说了算。
 * 宿主到 overlay 的通道复用 aiInbox（与 /ai/call、节点图 run 通道的 l2d_act 同一条：
 * aiInbox.call 入队 → overlay /ai/poll 取走执行 → /ai/result 回写 → 这里 read 取回）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileBodyTable, describeRegions, validateBridgeCommand, pickFaceUnitsFile, BRIDGE_REGIONS, MAX_WAIT_MS } from './body-bridge.mjs';
import { DEFAULT_MODEL_IDS_DIR, isSafeModelId } from './nodegraph-schema.mjs';
import { autoCutsForModel } from './motion-cuts.mjs';

export const MOTION_CUTS_FILE = 'motion-cutpoints.json';

/** overlay 侧工具名（只经本模块入队，不进 /ai/call 白名单——那样会绕过静态校验）。 */
export const BRIDGE_INBOX_TOOLS = Object.freeze(['l2d_regions_get', 'l2d_regions_act', 'l2d_regions_release', 'l2d_face_describe']);
export const BRIDGE_API_BODY_LIMIT = 32 * 1024;
/** 等 overlay 回执的基础预算（overlay 400ms 轮询一次，留足余量）。 */
export const BRIDGE_FORWARD_TIMEOUT_MS = 5000;
/** awaitDone 最长等待（等全部模块 action-done）。 */
export const MAX_AWAIT_DONE_MS = 60000;

const TABLE_CACHE = new Map();

/**
 * 读某模型的分区表 docs/nodegraph/models/<modelId>/body-regions.json（按 mtime 缓存）。
 * @returns {{ok:true, table, compiled, file, modelId} | {ok:false, reason:'table-unavailable', modelId, file?, message}}
 */
export function loadBodyRegionsForModel(modelId, options = {}) {
  const modelsDir = options.modelsDir || DEFAULT_MODEL_IDS_DIR;
  const fsImpl = options.fs || fs;
  if (!isSafeModelId(modelId)) return { ok: false, reason: 'table-unavailable', modelId: String(modelId || ''), message: 'modelId 缺失或非法' };
  const file = path.join(modelsDir, modelId, 'body-regions.json');
  let mtimeMs = 0;
  try {
    mtimeMs = fsImpl.statSync(file).mtimeMs;
  } catch {
    return { ok: false, reason: 'table-unavailable', modelId, file, message: '该模型还没有分区表 body-regions.json' };
  }
  // 神态部件表（可选）：同目录先找 face-units.json，没有再找 face-vocab.json；都没有就不开放 compose 步骤
  const dir = path.join(modelsDir, modelId);
  const faceName = pickFaceUnitsFile((n) => {
    try {
      return fsImpl.statSync(path.join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
  const faceFile = faceName ? path.join(dir, faceName) : '';
  let faceMtimeMs = -1;
  if (faceFile) {
    try {
      faceMtimeMs = fsImpl.statSync(faceFile).mtimeMs;
    } catch {
      faceMtimeMs = -1;
    }
  }
  // 动作衔接点（可选）：motion-cutpoints.json；没有标注的动作由宿主从许可模型目录现算兜底（不落盘）
  const cutsFile = path.join(dir, MOTION_CUTS_FILE);
  let cutsMtimeMs = -1;
  try {
    cutsMtimeMs = fsImpl.statSync(cutsFile).mtimeMs;
  } catch {
    cutsMtimeMs = -1;
  }
  const modelDir = options.modelDir || '';
  const key = file + '\0' + modelDir;
  const hit = TABLE_CACHE.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.faceFile === faceFile && hit.faceMtimeMs === faceMtimeMs && hit.cutsMtimeMs === cutsMtimeMs) return hit.result;
  try {
    const table = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    let faceUnits = null;
    let faceError = '';
    if (faceFile) {
      try {
        faceUnits = JSON.parse(fsImpl.readFileSync(faceFile, 'utf8'));
      } catch (err) {
        faceError = path.basename(faceFile) + ' 解析失败：' + String((err && err.message) || err);
      }
    }
    const compiled = compileBodyTable(table, { faceUnits });
    let motionCuts = null;
    let motionCutsError = '';
    if (cutsMtimeMs >= 0) {
      try {
        motionCuts = JSON.parse(fsImpl.readFileSync(cutsFile, 'utf8'));
      } catch (err) {
        motionCutsError = MOTION_CUTS_FILE + ' 解析失败：' + String((err && err.message) || err);
      }
    }
    const annotated = new Set(Object.keys((motionCuts && motionCuts.motions) || {}));
    const wanted = [...compiled.motionRegion.keys()].filter((g) => !annotated.has(g));
    const regionParams = (g) => {
      const r = compiled.motionRegion.get(g);
      return [...compiled.paramHome.entries()].filter(([, home]) => home === r).map(([id]) => id);
    };
    let autoCuts = {};
    try {
      autoCuts = modelDir ? autoCutsForModel(modelDir, modelId, regionParams, wanted, fsImpl) : {};
    } catch {
      autoCuts = {};
    }
    const result = { ok: true, table, faceUnits, faceFile: faceName || '', faceError, motionCuts, motionCutsError, autoCuts, compiled, file, modelId };
    TABLE_CACHE.set(key, { mtimeMs, faceFile, faceMtimeMs, cutsMtimeMs, result });
    return result;
  } catch (err) {
    return { ok: false, reason: 'table-unavailable', modelId, file, message: '分区表解析失败：' + String((err && err.message) || err) };
  }
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function terminal(ev) {
  return ev && ev.type === 'action-done' && (ev.phase === 'end' || ev.phase === 'interrupted' || ev.phase === 'failed');
}

/**
 * 创建 bridge 处理器。
 * @param {{
 *   getCurrentModelId: () => string,
 *   call: (name:string, args:object) => {ok:boolean, id?:number, reason?:string},
 *   read: (id:number) => {ready:boolean, result?:object, events?:object[]},
 *   modelsDir?: string, sleep?: (ms:number)=>Promise<void>, now?: ()=>number,
 *   pollIntervalMs?: number, forwardTimeoutMs?: number,
 * }} deps
 */
export function createBridgeApi(deps) {
  if (!deps || typeof deps.call !== 'function' || typeof deps.read !== 'function') {
    throw new Error('createBridgeApi: 需要 call 与 read（aiInbox）');
  }
  const sleep = deps.sleep || sleepDefault;
  const now = deps.now || Date.now;
  const pollIntervalMs = Math.max(1, Number(deps.pollIntervalMs) || 100);
  const forwardTimeoutMs = Math.max(1, Number(deps.forwardTimeoutMs) || BRIDGE_FORWARD_TIMEOUT_MS);

  function modelIdOf(param) {
    if (typeof param === 'string' && param) return param;
    try {
      return String((deps.getCurrentModelId && deps.getCurrentModelId()) || '');
    } catch {
      return '';
    }
  }

  function table(modelParam) {
    return loadBodyRegionsForModel(modelIdOf(modelParam), { modelsDir: deps.modelsDir, modelDir: deps.modelDir });
  }

  /** 入队并等 overlay 回执；awaitTargets 非空时继续收集 action-done 直到这些目标都终态。 */
  async function forward(name, args, timeoutMs, awaitDone) {
    let queued;
    try {
      queued = deps.call(name, args);
    } catch (err) {
      queued = { ok: false, reason: String((err && err.message) || err) };
    }
    if (!queued || queued.ok !== true || !queued.id) {
      return { status: 503, payload: { ok: false, reason: 'overlay-unavailable', detail: (queued && queued.reason) || 'enqueue-failed' } };
    }
    const id = queued.id;
    const deadline = now() + timeoutMs;
    let result = null;
    let events = [];
    while (true) {
      let back = null;
      try {
        back = deps.read(id);
      } catch {
        back = null;
      }
      if (back) {
        if (Array.isArray(back.events)) events = events.concat(back.events);
        if (back.ready) result = back.result && typeof back.result === 'object' ? back.result : { ok: false, reason: 'empty' };
      }
      if (result) {
        if (!awaitDone || result.ok !== true || !Array.isArray(result.accepted) || !result.commandId) break;
        const pending = result.accepted.filter((target) =>
          !events.some((ev) => terminal(ev) && ev.commandId === result.commandId && (ev.region === target || ev.layer === target || (ev.item && 'accessory:' + ev.item === target))));
        if (!pending.length) break;
        if (now() >= awaitDone.deadline) {
          result = { ...result, settled: false, pendingTargets: pending };
          break;
        }
      } else if (now() >= deadline) {
        return { status: 504, payload: { ok: false, reason: 'timeout', callId: id, detail: 'overlay 未在预算内回执（页面没开或渲染未就绪）' } };
      }
      await sleep(pollIntervalMs);
    }
    const payload = { ...result, callId: id };
    const own = events.filter((ev) => ev && ev.type === 'action-done' && (!result.commandId || ev.commandId === result.commandId));
    if (own.length || Array.isArray(result.events)) {
      const seen = new Set();
      payload.events = [...(Array.isArray(result.events) ? result.events : []), ...own].filter((ev) => {
        const k = [ev.commandId, ev.region || ev.layer, ev.item || '', ev.phase].join(':');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (awaitDone && payload.ok === true && payload.settled === undefined) payload.settled = true;
    return { status: statusOf(payload), payload };
  }

  function statusOf(payload) {
    if (!payload || payload.ok === true) return 200;
    if (payload.reason === 'region-busy' || payload.reason === 'expression-conflict') return 409;
    if (payload.reason === 'table-unavailable' || payload.reason === 'bridge-unavailable') return 503;
    if (payload.reason === 'not-found') return 404;
    return 400;
  }

  return {
    /** GET table?model=X：原表 + 给人/LLM 看的能力摘要。 */
    handleTable(modelParam) {
      const t = table(modelParam);
      if (!t.ok) return { status: 404, payload: { ok: false, reason: t.reason, modelId: t.modelId, message: t.message } };
      return { status: 200, payload: { ok: true, modelId: t.modelId, table: t.table, faceUnits: t.faceUnits, faceFile: t.faceFile || undefined, faceError: t.faceError || undefined, motionCuts: t.motionCuts, motionCutsError: t.motionCutsError || undefined, autoCuts: t.autoCuts, capabilities: describeRegions(t.compiled) } };
    },

    /** GET state：overlay 的权威快照 + 静态能力摘要。 */
    async handleState() {
      const t = table();
      const out = await forward('l2d_regions_get', {}, forwardTimeoutMs);
      if (t.ok && out.payload && out.payload.ok === true && !out.payload.capabilities) {
        out.payload.capabilities = describeRegions(t.compiled);
      }
      return out;
    },

    /** POST act：同一份规则先做静态校验，不合格直接 400，不打扰 overlay。 */
    async handleAct(body) {
      const t = table();
      if (!t.ok) return { status: 503, payload: { ok: false, reason: 'table-unavailable', modelId: t.modelId, message: t.message } };
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
      const command = input ? { source: input.source, priority: input.priority, onBusy: input.onBusy, waitMs: input.waitMs, steps: input.steps } : input;
      for (const key of Object.keys(command || {})) if (command[key] === undefined) delete command[key];
      const checked = validateBridgeCommand(t.compiled, command);
      if (!checked.ok) return { status: 400, payload: { ok: false, reason: checked.reason, errors: checked.errors } };
      const waitMs = checked.command.onBusy === 'wait' ? checked.command.waitMs : 0;
      let awaitDone = null;
      if (input.awaitDone === true) {
        const ms = Math.min(MAX_AWAIT_DONE_MS, Math.max(0, Number(input.awaitDoneMs) || 15000));
        awaitDone = { deadline: now() + waitMs + ms + forwardTimeoutMs };
      }
      const out = await forward('l2d_regions_act', { command }, Math.min(MAX_WAIT_MS, waitMs) + forwardTimeoutMs, awaitDone);
      if (out.payload && Array.isArray(checked.warnings) && checked.warnings.length) {
        const merged = new Set([...(out.payload.warnings || []), ...checked.warnings]);
        out.payload.warnings = [...merged];
      }
      return out;
    },

    /** GET face/vocab：神态部件表原文（face-units.json，旧名 face-vocab.json）+ 编译摘要（每个参数归哪个模块、是否被拦）。 */
    handleFaceVocab(modelParam) {
      const t = table(modelParam);
      if (!t.ok) return { status: 404, payload: { ok: false, reason: t.reason, modelId: t.modelId, message: t.message } };
      if (!t.faceUnits) return { status: 404, payload: { ok: false, reason: 'face-units-unavailable', modelId: t.modelId, message: t.faceError || '该模型没有 face-units.json / face-vocab.json' } };
      return { status: 200, payload: { ok: true, modelId: t.modelId, file: t.faceFile, vocab: t.faceUnits, summary: describeRegions(t.compiled).face } };
    },

    /** POST face/compose：{compose, priority?, source?, onBusy?, waitMs?, awaitDone?} → 一条只有 face compose 步的 act。 */
    async handleFaceCompose(body) {
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const step = { region: 'face' };
      if (typeof input.mood === 'string') step.mood = input.mood;
      else step.compose = input.compose;
      return this.handleAct({ ...input, steps: [step] });
    },

    /** GET face/describe：overlay 读当前参数做反推（部件强度）。 */
    async handleFaceDescribe() {
      return forward('l2d_face_describe', {}, forwardTimeoutMs);
    },

    /** POST release：{commandId} 释放整条指令，{region} 释放单个模块。 */
    async handleRelease(body) {
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const selector = {};
      if (input.commandId !== undefined && input.commandId !== null && input.commandId !== '') selector.commandId = String(input.commandId).slice(0, 64);
      else if (input.region !== undefined) {
        const region = String(input.region);
        if (!BRIDGE_REGIONS.includes(region)) return { status: 400, payload: { ok: false, reason: 'unknown-region', region } };
        selector.region = region;
      } else {
        return { status: 400, payload: { ok: false, reason: 'invalid-command', message: '需要 commandId 或 region' } };
      }
      return forward('l2d_regions_release', selector, forwardTimeoutMs);
    },
  };
}
