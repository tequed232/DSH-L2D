/**
 * dsh-l2d · Model Adapter（P1：语义动作 ↔ 模型参数桥接，fail-closed）
 *
 * 依据：Phase 2 任务书 P1-3「建立图像 ↔ 模型桥接」：
 *  - 图片语义标签不直接等同于模型参数；
 *  - 动作定义不允许硬编码具体模型参数 ID；
 *  - 必须由 Model Adapter 完成语义到实际参数的映射；
 *  - 一个语义动作允许映射到多个模型参数；
 *  - 不支持的语义必须明确返回 unsupported，不得伪造映射。
 *
 * adapter_json 形态（存于 motion_model_bindings，一行 = 一个 (motion, model) 对）：
 *   {
 *     channels: {
 *       tail_sway: [ { paramId: 'LateHair1', weight: 1.0, min: -30, max: 30 }, ... ],
 *       ...
 *     },
 *     notes: '映射依据：w3-registry controlledParams + cdi3 语义名（版本 sourceCommit）'
 *   }
 *
 * 纪律：
 *  - 绑定写入前校验每个 paramId 在该 model 的 parameters 表存在，否则拒绝（不伪造）；
 *  - 解析时复查参数仍然存在，失效即整体 fail-closed 并把绑定置 compatible=0（版本漂移防护）；
 *  - 可选注入 capability registry（tools/w3-registry），提供时强制 checkModel。
 */
import { withTransaction } from './db.mjs';
import { upsertMotionBinding } from './repo.mjs';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验 adapter 形态：channels 非空对象，每通道至少一条映射，paramId 非空字符串。 */
export function validateAdapterShape(adapter) {
  const errors = [];
  if (!isPlainObject(adapter)) return ['adapter 必须为对象'];
  if (!isPlainObject(adapter.channels)) return ['adapter.channels 必须为对象'];
  const channelNames = Object.keys(adapter.channels);
  if (channelNames.length === 0) errors.push('adapter.channels 不得为空');
  for (const ch of channelNames) {
    const entries = adapter.channels[ch];
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`channels.${ch} 必须为非空数组`);
      continue;
    }
    entries.forEach((e, i) => {
      if (!isPlainObject(e) || typeof e.paramId !== 'string' || e.paramId.trim() === '') {
        errors.push(`channels.${ch}[${i}].paramId 必须为非空字符串`);
      }
      if (e.weight !== undefined && (typeof e.weight !== 'number' || !Number.isFinite(e.weight))) {
        errors.push(`channels.${ch}[${i}].weight 必须为有限数值`);
      }
      if (e.min !== undefined && !Number.isFinite(Number(e.min))) errors.push(`channels.${ch}[${i}].min 非法`);
      if (e.max !== undefined && !Number.isFinite(Number(e.max))) errors.push(`channels.${ch}[${i}].max 非法`);
    });
  }
  return errors;
}

/** 返回该模型已注册的 param_id 集合（Set<string>）。 */
export function registeredParamIds(db, modelId) {
  return new Set(
    db.prepare('SELECT param_id FROM parameters WHERE model_id = ?').all(modelId).map((r) => r.param_id),
  );
}

/**
 * 将语义动作绑定到模型（写入前全面校验，任何失败即抛错，不产生半行）。
 * @returns 绑定行
 */
export function bindMotionToModel(db, { motionId, modelId, adapter, capabilityRegistry = null, notes = null }) {
  if (!motionId || !modelId) throw new Error('bindMotionToModel: motionId/modelId 必填');

  const model = db.prepare('SELECT model_id FROM models WHERE model_id = ?').get(modelId);
  if (!model) {
    const err = new Error(`模型 '${modelId}' 未注册（fail-closed）`);
    err.code = 'MODEL_UNREGISTERED';
    throw err;
  }
  const motion = db.prepare('SELECT id FROM motion_definitions WHERE id = ?').get(motionId);
  if (!motion) {
    const err = new Error(`动作定义 '${motionId}' 不存在`);
    err.code = 'MOTION_NOT_FOUND';
    throw err;
  }

  const shapeErrors = validateAdapterShape(adapter);
  if (shapeErrors.length > 0) {
    const err = new Error(`adapter 形态非法：${shapeErrors.join('; ')}`);
    err.code = 'ADAPTER_SHAPE_INVALID';
    throw err;
  }

  // 可选能力注册表检查（fail-closed：提供即强制）
  if (capabilityRegistry) {
    const check = capabilityRegistry.checkModel(modelId);
    if (!check.ok) {
      const err = new Error(`能力注册表拒绝：${check.code} ${check.message ?? ''}`.trim());
      err.code = check.code;
      throw err;
    }
  }

  // 逐参数存在性校验：不支持/不存在的参数明确拒绝，绝不静默丢弃
  const known = registeredParamIds(db, modelId);
  const unknown = [];
  for (const [ch, entries] of Object.entries(adapter.channels)) {
    for (const e of entries) {
      if (!known.has(e.paramId)) unknown.push(`${ch}:${e.paramId}`);
    }
  }
  if (unknown.length > 0) {
    const err = new Error(`参数未映射/未注册（fail-closed）：${unknown.join(', ')}`);
    err.code = 'PARAM_UNMAPPED';
    err.unknown = unknown;
    throw err;
  }

  const payload = { ...adapter, ...(notes ? { notes } : {}) };
  return upsertMotionBinding(db, {
    motionId,
    modelId,
    adapter: payload,
    compatible: 1,
  });
}

/**
 * 解析动作在某模型上的实际参数映射（执行期入口）。
 * 复查每个 paramId 仍存在；发现失效 → 绑定置 compatible=0 并整体拒绝（版本漂移防护）。
 * @returns { ok:true, channels, verifiedAt } 或 { ok:false, code, ... }
 */
export function resolveMotionParams(db, { motionId, modelId }) {
  const row = db
    .prepare('SELECT * FROM motion_model_bindings WHERE motion_id = ? AND model_id = ?')
    .get(motionId, modelId);
  if (!row) return { ok: false, code: 'MOTION_UNBOUND', message: `动作 '${motionId}' 未绑定到模型 '${modelId}'` };
  if (row.compatible === 0) {
    return { ok: false, code: 'BINDING_INCOMPATIBLE', message: '绑定已标记不兼容（模型版本变化）' };
  }

  let adapter;
  try {
    adapter = JSON.parse(row.adapter_json ?? '{}');
  } catch {
    return { ok: false, code: 'ADAPTER_CORRUPT', message: 'adapter_json 解析失败' };
  }

  const known = registeredParamIds(db, modelId);
  const stale = [];
  for (const [ch, entries] of Object.entries(adapter.channels ?? {})) {
    for (const e of entries) {
      if (!known.has(e.paramId)) stale.push(`${ch}:${e.paramId}`);
    }
  }
  if (stale.length > 0) {
    withTransaction(db, () => {
      db.prepare('UPDATE motion_model_bindings SET compatible = 0 WHERE motion_id = ? AND model_id = ?')
        .run(motionId, modelId);
    });
    return {
      ok: false,
      code: 'STALE_BINDING',
      stale,
      message: `模型 '${modelId}' 参数集已变化，映射失效（绑定已置 incompatible）`,
    };
  }
  return { ok: true, channels: adapter.channels, notes: adapter.notes ?? null, verifiedAt: row.verified_at };
}

/**
 * 模型版本差异检测：对比两个模型登记的参数集。
 * @returns { added:[paramId], removed:[paramId], renamed:[{paramId,from,to}], rangeChanged:[{paramId,from,to}] }
 */
export function diffModelParameterSets(db, modelIdA, modelIdB) {
  const rows = db
    .prepare('SELECT model_id, param_id, name, min_value, max_value FROM parameters WHERE model_id IN (?, ?)')
    .all(modelIdA, modelIdB);
  const setOf = (id) => new Map(rows.filter((r) => r.model_id === id).map((r) => [r.param_id, r]));
  const a = setOf(modelIdA);
  const b = setOf(modelIdB);

  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const renamed = [];
  const rangeChanged = [];
  for (const [k, ra] of a) {
    const rb = b.get(k);
    if (!rb) continue;
    if ((ra.name ?? null) !== (rb.name ?? null)) renamed.push({ paramId: k, from: ra.name, to: rb.name });
    if ((ra.min_value ?? null) !== (rb.min_value ?? null) || (ra.max_value ?? null) !== (rb.max_value ?? null)) {
      rangeChanged.push({ paramId: k, from: { min: ra.min_value, max: ra.max_value }, to: { min: rb.min_value, max: rb.max_value } });
    }
  }
  return { added, removed, renamed, rangeChanged };
}
