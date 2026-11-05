/**
 * dsh-l2d · Capability Registry 接线（P0-C）
 *
 * 依据：docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md P0-C
 * 数据源：现有 tools/w3-registry/registry.json（不另建平行数据源）。
 *
 * 真实结构（实测）：
 *   { schemaVersion:1, generatedBy, model:{ id, model3, moc3, ... },
 *     sourceCommit, entries:[ { id, kind, label, slot, api, assets:[{durationMs,...}],
 *                               controlledParams:[{ id, min, max, end }] } ] }
 *
 * 语义规则：
 *  - entries[].id 即动作能力的 semantic_key（如 gesture.right_finger）；
 *    动作链只保存该语义键，具体参数 ID（Movement / Param 系列）由 Model Adapter 执行期映射。
 *  - 可选 paramSemantics（per-entry）：声明语义参数键的 {min,max,type}，
 *    声明即强校验；未声明的语义参数仅做类型检查（范围校验随 Phase 4 Model Adapter 落地）。
 *  - fail-closed：文件缺失/JSON 损坏/Schema 不匹配 → registry.status='unavailable'/'invalid'，
 *    一切能力断言拒绝放行。
 */
import fs from 'node:fs';
import path from 'node:path';

export const REGISTRY_KINDS = ['motion-pair', 'motion', 'expression', 'pose', 'look', 'posture'];

function findRepoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

export function defaultRegistryPath(startDir = process.cwd()) {
  return path.join(findRepoRoot(startDir), 'tools', 'w3-registry', 'registry.json');
}

/** 数值或可解析为有限数值的字符串（真实 registry 的 min/max 存为字符串，实测确认）。 */
function isNumericLike(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}

function toNumber(v) {
  return typeof v === 'number' ? v : Number(v);
}

/** registry 文档自身 Schema 校验（防字段漂移，fail-closed）。 */
export function validateRegistryDocument(doc) {
  const errors = [];
  if (typeof doc !== 'object' || doc === null) return ['registry 根必须是对象'];
  if (doc.schemaVersion !== 1) errors.push(`schemaVersion 必须为 1，实际 ${JSON.stringify(doc.schemaVersion)}`);
  if (typeof doc.sourceCommit !== 'string' || doc.sourceCommit.length === 0) errors.push('sourceCommit 缺失');
  if (typeof doc.model?.id !== 'string' || doc.model.id.length === 0) errors.push('model.id 缺失');
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) errors.push('entries 必须为非空数组');
  (doc.entries ?? []).forEach((e, i) => {
    if (typeof e.id !== 'string' || e.id.length === 0) errors.push(`entries[${i}].id 缺失`);
    if (typeof e.kind !== 'string') errors.push(`entries[${i}].kind 缺失`);
    if (e.controlledParams !== undefined) {
      if (!Array.isArray(e.controlledParams)) errors.push(`entries[${i}].controlledParams 必须为数组`);
      else e.controlledParams.forEach((p, j) => {
        if (typeof p.id !== 'string') errors.push(`entries[${i}].controlledParams[${j}].id 缺失`);
        // min/max 为可选字段（真实数据 pose 类仅 {id, end}）；存在时须为数值或数值字符串
        if (p.min !== undefined && !isNumericLike(p.min)) errors.push(`entries[${i}].controlledParams[${j}].min 非法：${JSON.stringify(p.min)}`);
        if (p.max !== undefined && !isNumericLike(p.max)) errors.push(`entries[${i}].controlledParams[${j}].max 非法：${JSON.stringify(p.max)}`);
      });
    }
  });
  return errors;
}

/**
 * 加载 registry。options.raw 可注入文本（测试用）。
 * @returns {{ status:'available'|'unavailable'|'invalid', revision?, model?, errors?, get, has, list, checkModel, checkStep }}
 */
export function loadCapabilityRegistry(options = {}) {
  const failClosed = (status, errors) => ({
    status,
    errors,
    revision: null, model: null,
    get: () => null, has: () => false, list: () => [],
    checkModel: () => ({ ok: false, code: 'REGISTRY_UNAVAILABLE' }),
    checkStep: () => ({ ok: false, code: 'REGISTRY_UNAVAILABLE' }),
  });

  let doc;
  try {
    const raw = options.raw ?? fs.readFileSync(options.registryPath ?? defaultRegistryPath(), 'utf8');
    doc = JSON.parse(raw);
  } catch (err) {
    return failClosed('unavailable', [`registry 加载失败：${err.message}`]);
  }
  const errors = validateRegistryDocument(doc);
  if (errors.length > 0) return failClosed('invalid', errors);

  const entries = new Map();
  for (const e of doc.entries) {
    const paramSemantics = e.paramSemantics ?? null;
    const maxAssetMs = (e.assets ?? []).reduce((m, a) => Math.max(m, a.durationMs ?? 0), 0);
    // controlledParams 归一化：min/max 可选（缺省取 end，实测 pose 类仅 {id,end}）；数值字符串转数值
    const controlledParams = (e.controlledParams ?? []).map((p) => ({
      id: p.id,
      min: toNumber(p.min ?? p.end ?? 0),
      max: toNumber(p.max ?? p.end ?? 0),
      end: toNumber(p.end ?? 0),
    }));
    entries.set(e.id, { ...e, controlledParams, paramSemantics, maxAssetMs, status: e.status ?? 'registered' });
  }

  function get(id) { return entries.get(id) ?? null; }
  function has(id) { return entries.has(id); }
  function list() { return [...entries.values()].map((e) => ({ id: e.id, kind: e.kind, label: e.label, status: e.status })); }

  /** 未注册模型 → 明确拒绝。 */
  function checkModel(modelId) {
    if (modelId === doc.model.id) return { ok: true };
    return { ok: false, code: 'MODEL_UNREGISTERED', message: `模型 '${modelId}' 未在 registry 注册（已注册：${doc.model.id}）` };
  }

  /**
   * G3 能力断言：step { capabilityId, params?, durationMs? }。
   * 未注册能力 / excluded 能力 / 声明参数越界 / 类型错误 → 拒绝（fail-closed）。
   */
  function checkStep(step) {
    const capability = entries.get(step.capabilityId);
    if (!capability) {
      return { ok: false, code: 'CAPABILITY_UNREGISTERED', message: `能力 '${step.capabilityId}' 未注册（fail-closed）` };
    }
    if (capability.status === 'excluded') {
      return { ok: false, code: 'CAPABILITY_EXCLUDED', message: `能力 '${step.capabilityId}' 已被排除` };
    }
    if (step.durationMs !== undefined) {
      if (!Number.isFinite(step.durationMs) || step.durationMs <= 0) {
        return { ok: false, code: 'STEP_DURATION_INVALID', message: `durationMs 须为正有限数，实际 ${step.durationMs}` };
      }
      if (capability.maxAssetMs > 0 && step.durationMs > capability.maxAssetMs * 10) {
        return { ok: false, code: 'DURATION_OUT_OF_RANGE', message: `durationMs=${step.durationMs} 超出能力素材时长上限 ${capability.maxAssetMs}×10` };
      }
    }
    const params = step.params ?? {};
    for (const [key, value] of Object.entries(params)) {
      const declared = capability.paramSemantics?.[key];
      if (declared) {
        if (declared.type === 'number' || typeof value === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, code: 'PARAM_TYPE_INVALID', message: `参数 ${key} 需为有限数值` };
          }
          const min = declared.min ?? -Infinity;
          const max = declared.max ?? Infinity;
          if (value < min || value > max) {
            return { ok: false, code: 'PARAM_OUT_OF_RANGE', message: `参数 ${key}=${value} 超出 [${min}, ${max}]` };
          }
        } else if (declared.type === 'string' && typeof value !== 'string') {
          return { ok: false, code: 'PARAM_TYPE_INVALID', message: `参数 ${key} 需为字符串` };
        }
      } else if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return { ok: false, code: 'PARAM_TYPE_INVALID', message: `参数 ${key} 类型不支持（${typeof value}）` };
      }
      // 未声明 paramSemantics 的语义参数：类型检查放行，范围校验由 Phase 4 Model Adapter 负责（已记录的限制）
    }
    return { ok: true };
  }

  return { status: 'available', revision: doc.sourceCommit, model: doc.model, errors: null, get, has, list, checkModel, checkStep };
}
