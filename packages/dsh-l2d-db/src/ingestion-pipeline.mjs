/**
 * dsh-l2d · Ingestion Pipeline G0—G4（P0-D）
 *
 * 依据：docs/architecture/ACTIONS-JSON-INGESTION-RULES.md §4（R5 门禁顺序固定、按序短路）
 *      docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md P0-D
 *
 * 硬性规则：
 *  - 门禁按 G0→G4 顺序执行，任一失败即短路；失败经 Repository.recordRejectedAction 留痕。
 *  - Pipeline 自身禁止直写 action_chains 等动作链表（全部经 Repository）。
 *  - 只有全部通过才进入 validated；不得通过默认值掩盖缺失能力；不得伪造成功。
 *
 * candidate 结构：
 * {
 *   semanticKey, description, emotion?, expression?, gaze?, bodyLanguage?,
 *   modelId?, sourceId?, modelCapabilityId?,
 *   chain: { schemaVersion, steps: [ { index, kind, params?, durationMs, admission, capabilityId, pairing? } ] },
 *   provenance: { assets: [ { id, sourceType, originalPath, contentHash } ],
 *                 analyses: [ { id, assetId, modelName, analysis } ] }
 * }
 */
import { canonicalChainHash, SEMANTIC_KEY_RE } from './actions-repo.mjs';

export const STEP_KINDS = ['expression', 'motion', 'pose', 'look', 'keyframes'];
export const ADMISSIONS = ['keyframe', 'step', 'gate'];

/** G2：具体模型参数 ID 否决表（R1：动作链禁止硬编码模型参数 ID）。 */
const CONCRETE_PARAM_ID_RE = /^(Param[A-Za-z0-9_]*|Part[A-Za-z0-9_]*|Movement\d+)$/;
const KNOWN_CUBISM_PARAM_IDS = new Set([
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY', 'ParamHandL', 'ParamHandR',
]);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/** fix-p4/H3：params 递归深度上限（同时兜住循环引用），超限走受控拒绝而非 RangeError。 */
const MAX_PARAM_DEPTH = 64;
const PARAM_DEPTH_EXCEEDED = 'PARAM_DEPTH_EXCEEDED';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深度遍历 params，收集可能的具体参数 ID（键与字符串值）。 */
function findConcreteParamIds(value, hits, pathKey = '', depth = 0) {
  if (depth > MAX_PARAM_DEPTH) throw new Error(PARAM_DEPTH_EXCEEDED);
  if (typeof value === 'string') {
    if (CONCRETE_PARAM_ID_RE.test(value) || KNOWN_CUBISM_PARAM_IDS.has(value)) {
      hits.push(`${pathKey || '<value>'}=${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findConcreteParamIds(v, hits, `${pathKey}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (CONCRETE_PARAM_ID_RE.test(k) || KNOWN_CUBISM_PARAM_IDS.has(k)) hits.push(`${pathKey}.${k}`);
      findConcreteParamIds(v, hits, `${pathKey}.${k}`, depth + 1);
    }
  }
}

export function createIngestionPipeline({ repository, registry }) {
  if (!repository) throw new Error('createIngestionPipeline: repository 必填');
  if (!registry) throw new Error('createIngestionPipeline: registry 必填');

  /** 统一拒绝出口：经 Repository 留痕，绝不静默丢弃。 */
  function reject(candidate, gate, code, reason, evidence = null) {
    const recorded = repository.recordRejectedAction(
      {
        semanticKey: candidate.semanticKey ?? '<unknown>',
        description: candidate.description ?? '',
        emotion: candidate.emotion ?? null,
        chain: candidate.chain ?? null,
        code,
        sourceId: candidate.sourceId ?? null,
        modelCapabilityId: candidate.modelCapabilityId ?? null,
        evidence: { gate, code, reason, evidence },
      },
      gate,
      reason,
      candidate.provenance ?? null,
    );
    return { status: 'rejected', gate, code, reason, evidence, recorded };
  }

  /**
   * fix-p4/H1 ②：快照缺失自愈。
   * G0 的 duplicate 短路会永久封死重试路径——若目标链尚未登记快照（此前导出失败过），
   * 在此补导一次并返回明确状态，避免「已 validated 却永久缺快照」的不可逆卡死。
   * 只经 Repository（R4），Pipeline 不直写动作链表。
   */
  function healMissingSnapshot(motionId, chainId) {
    if (typeof repository.getActionChain !== 'function' || typeof repository.exportActionSnapshot !== 'function') return null;
    let chain;
    try { chain = repository.getActionChain(chainId); } catch { return null; }
    if (!chain || chain.jsonAddress) return null; // 已登记快照 → 维持 duplicate 语义
    try {
      const snap = repository.exportActionSnapshot(motionId, chain.version);
      return {
        status: 'snapshot_healed', motionId, chainId,
        chainHash: chain.chainHash, version: chain.version,
        snapshot: { path: snap.path, contentSha256: snap.contentSha256 },
      };
    } catch {
      return null; // 仍失败 → 维持 duplicate，下次继续重试，绝不伪造成功
    }
  }

  // ------------------------------------------------------------ G0 完整性与幂等

  function g0(candidate) {
    if (!isPlainObject(candidate)) return { ok: false, code: 'CANDIDATE_INVALID', reason: 'candidate 必须为结构化对象' };
    if (!candidate.semanticKey || !SEMANTIC_KEY_RE.test(candidate.semanticKey)) {
      return { ok: false, code: 'SEMANTIC_KEY_INVALID', reason: `semanticKey 缺失或格式非法：${candidate.semanticKey}` };
    }
    const assets = candidate.provenance?.assets ?? [];
    const analyses = candidate.provenance?.analyses ?? [];
    if (assets.length === 0) {
      return { ok: false, code: 'PROVENANCE_MISSING', reason: '溯源缺失：至少需要一个素材来源（R7）' };
    }
    if (analyses.length === 0) {
      return { ok: false, code: 'PROVENANCE_MISSING', reason: '溯源缺失：至少需要一条分析记录（R7）' };
    }
    const assetIds = new Set();
    for (const a of assets) {
      if (!a.sourceType || !a.originalPath) return { ok: false, code: 'PROVENANCE_INCOMPLETE', reason: '素材缺 sourceType/originalPath' };
      if (!SHA256_RE.test(a.contentHash ?? '')) return { ok: false, code: 'ASSET_HASH_INVALID', reason: `素材 contentHash 非法：${a.contentHash}` };
      if (assetIds.has(a.id)) return { ok: false, code: 'PROVENANCE_DUPLICATE', reason: `素材 id 重复：${a.id}` };
      assetIds.add(a.id);
    }
    for (const an of analyses) {
      if (!assetIds.has(an.assetId)) return { ok: false, code: 'PROVENANCE_INCOMPLETE', reason: `分析记录引用未知素材：${an.assetId}` };
      // #32：分析记录自身的 Schema（Schema analysis_report/analysis 结构）不得被门禁放过
      if (!isPlainObject(an.analysis)) return { ok: false, code: 'ANALYSIS_INVALID', reason: `analysis 必须为结构化对象：${JSON.stringify(an.analysis)}` };
      if (typeof an.modelName !== 'string' || an.modelName.length === 0) return { ok: false, code: 'ANALYSIS_INVALID', reason: `modelName 必须为非空字符串：${JSON.stringify(an.modelName)}` };
      if (an.confidence !== undefined && an.confidence !== null
        && (typeof an.confidence !== 'number' || !Number.isFinite(an.confidence) || an.confidence < 0 || an.confidence > 1)) {
        return { ok: false, code: 'CONFIDENCE_INVALID', reason: `confidence 越界（Schema 规定 0–1）：${JSON.stringify(an.confidence)}` };
      }
    }
    // 幂等判定（R9）：同键同内容 → duplicate；同键异内容 → version_conflict（不静默覆盖）
    const chainHash = canonicalChainHash(candidate.chain);
    const decision = repository.resolveSemanticKey(candidate.semanticKey, chainHash);
    if (decision.action === 'duplicate') return { ok: false, shortCircuit: 'duplicate', motionId: decision.motion.id, chainId: decision.chain.id };
    if (decision.action === 'version_conflict') {
      return { ok: false, shortCircuit: 'version_conflict', expectedVersion: decision.expectedVersion };
    }
    return { ok: true, chainHash };
  }

  // ------------------------------------------------------------ G1 Schema

  function g1(candidate) {
    // #32：候选层字段对齐 Schema 类型约束（§2：description 1–500 字符串；语义字段 string|null）
    const desc = candidate.description;
    if (typeof desc !== 'string' || desc.length === 0 || desc.length > 500) {
      return { ok: false, code: 'SCHEMA_INVALID', reason: `description 必须为 1–500 字符的字符串：${JSON.stringify(desc)}` };
    }
    for (const field of ['emotion', 'expression', 'gaze', 'bodyLanguage']) {
      const v = candidate[field];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        return { ok: false, code: 'SCHEMA_INVALID', reason: `${field} 必须为字符串或 null：${JSON.stringify(v)}` };
      }
    }
    const chain = candidate.chain;
    if (!isPlainObject(chain)) return { ok: false, code: 'SCHEMA_INVALID', reason: 'chain 必须为对象' };
    if (!/^1\.\d+$/.test(String(chain.schemaVersion ?? ''))) {
      return { ok: false, code: 'SCHEMA_VERSION_UNSUPPORTED', reason: `schemaVersion 必须为 1.x，实际 ${chain.schemaVersion}` };
    }
    if (!Array.isArray(chain.steps) || chain.steps.length === 0) return { ok: false, code: 'SCHEMA_INVALID', reason: 'steps 必须为非空数组' };
    if (chain.steps.length > 64) return { ok: false, code: 'SCHEMA_INVALID', reason: 'steps 超过 64 步上限' };
    for (const s of chain.steps) {
      if (!isPlainObject(s)) return { ok: false, code: 'SCHEMA_INVALID', reason: 'step 必须为对象' };
      if (!Number.isInteger(s.index)) return { ok: false, code: 'SCHEMA_INVALID', reason: `step.index 必须为整数：${JSON.stringify(s.index)}` };
      if (!STEP_KINDS.includes(s.kind)) return { ok: false, code: 'SCHEMA_INVALID', reason: `step.kind 非法：${s.kind}` };
      if (s.params !== undefined && !isPlainObject(s.params)) return { ok: false, code: 'SCHEMA_INVALID', reason: 'step.params 必须为对象' };
      if (!Number.isInteger(s.durationMs) || s.durationMs <= 0) return { ok: false, code: 'SCHEMA_INVALID', reason: `step.durationMs 必须为正整数：${s.durationMs}` };
      if (!ADMISSIONS.includes(s.admission)) return { ok: false, code: 'SCHEMA_INVALID', reason: `step.admission 非法：${s.admission}` };
      if (typeof s.capabilityId !== 'string' || s.capabilityId.length === 0) return { ok: false, code: 'SCHEMA_INVALID', reason: 'step.capabilityId 必填（G3 能力断言依据）' };
      if (s.pairing !== undefined) {
        const p = s.pairing;
        if (!isPlainObject(p) || typeof p.pairId !== 'string' || !['open', 'close'].includes(p.role)) {
          return { ok: false, code: 'SCHEMA_INVALID', reason: 'step.pairing 须为 { pairId, role: open|close }' };
        }
      }
    }
    const indexes = chain.steps.map((s) => s.index);
    for (let i = 0; i < indexes.length; i++) {
      if (indexes[i] !== i) return { ok: false, code: 'SCHEMA_INVALID', reason: `step.index 必须从 0 连续递增（R 规范），实际 ${indexes.join(',')}` };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ G2 语义（含 PAIRED_CLOSES）

  function g2(candidate) {
    for (const s of candidate.chain.steps) {
      const hits = [];
      try {
        findConcreteParamIds(s.params ?? {}, hits);
      } catch (err) {
        // fix-p4/H3：超深/循环 params 不得让门禁链 RangeError 崩溃，转受控拒绝
        if (err && err.message === PARAM_DEPTH_EXCEEDED) {
          return { ok: false, code: 'SCHEMA_INVALID', reason: `step.params 嵌套深度超过 ${MAX_PARAM_DEPTH} 层（防止递归栈溢出）` };
        }
        throw err;
      }
      if (hits.length > 0) {
        return { ok: false, code: 'MODEL_PARAM_ID_IN_CHAIN', reason: `R1：动作链出现模型参数 ID 字面量 → ${hits.join('; ')}` };
      }
    }
    // 配对约束（PAIRED_CLOSES 风险 R4）：pairId 必须恰好一开一关、索引连续、先开后关
    const pairs = new Map();
    for (const s of candidate.chain.steps) {
      if (!s.pairing) continue;
      if (!pairs.has(s.pairing.pairId)) pairs.set(s.pairing.pairId, []);
      pairs.get(s.pairing.pairId).push(s);
    }
    for (const [pairId, steps] of pairs) {
      if (steps.length !== 2) {
        return { ok: false, code: 'PAIRING_BROKEN', reason: `配对 ${pairId} 步数=${steps.length}，必须恰好 2 步（PAIRED_CLOSES）` };
      }
      const [a, b] = steps;
      if (a.pairing.role === b.pairing.role) {
        return { ok: false, code: 'PAIRING_BROKEN', reason: `配对 ${pairId} 角色重复（${a.pairing.role}），须一开一关` };
      }
      if (b.index - a.index !== 1) {
        return { ok: false, code: 'PAIRING_BROKEN', reason: `配对 ${pairId} 步骤不连续（${a.index}→${b.index}）` };
      }
      if (!(a.pairing.role === 'open' && b.pairing.role === 'close')) {
        return { ok: false, code: 'PAIRING_BROKEN', reason: `配对 ${pairId} 顺序错误：须先 open 后 close` };
      }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ G3 能力（fail-closed）

  function g3(candidate) {
    if (registry.status !== 'available') {
      return { ok: false, code: 'REGISTRY_UNAVAILABLE', reason: `registry 不可用（${registry.status}）：${(registry.errors ?? []).join('; ')}——fail-closed，不放行` };
    }
    // GLM 验收 WARN-3 修复：modelId 必填——缺省即拒绝，不给宽松入口
    if (!candidate.modelId) {
      return { ok: false, code: 'MODEL_UNREGISTERED', reason: 'candidate.modelId 缺省：G3 能力校验必须显式声明目标模型（fail-closed）' };
    }
    const m = registry.checkModel(candidate.modelId);
    if (!m.ok) return { ok: false, code: m.code, reason: m.message };
    for (const s of candidate.chain.steps) {
      const result = registry.checkStep(s);
      if (!result.ok) return { ok: false, code: result.code, reason: result.message };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ G4 所有权与资源冲突

  function g4(candidate) {
    // 排他资源占用：同一 capabilityId 的独立占用次数 >1 即冲突。
    // 配对步骤（open→close 同 pairId）视为同一资源的一次占用，不重复计费。
    const soloCount = new Map();   // 未配对步骤按 capabilityId 计数
    const pairCap = new Map();     // pairId → capabilityId（一个配对=一次占用）
    for (const s of candidate.chain.steps) {
      if (s.pairing) {
        if (!pairCap.has(s.pairing.pairId)) pairCap.set(s.pairing.pairId, s.capabilityId);
      } else {
        soloCount.set(s.capabilityId, (soloCount.get(s.capabilityId) ?? 0) + 1);
      }
    }
    // 资源占用合计：未配对步骤数 + 独立配对数
    const usage = new Map();
    for (const [cap, n] of soloCount) usage.set(cap, (usage.get(cap) ?? 0) + n);
    for (const cap of pairCap.values()) usage.set(cap, (usage.get(cap) ?? 0) + 1);
    for (const [cap, count] of usage) {
      if (count > 1) {
        return {
          ok: false,
          code: 'PARAM_OWNERSHIP_CONFLICT',
          reason: `排他资源重复占用：${cap} 独立占用 ${count} 次（未配对步骤/不同配对间不得重复写入同一能力资源）`,
        };
      }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ 主流程

  /**
   * 按序执行 G0→G4，全过才经 Repository 入库 + 导出快照。
   * @returns {{status:'validated'|'rejected'|'duplicate'|'version_conflict', ...}}
   */
  function ingest(candidate) {
    const g0r = g0(candidate);
    if (!g0r.ok) {
      if (g0r.shortCircuit === 'duplicate') {
        return healMissingSnapshot(g0r.motionId, g0r.chainId)
          || { status: 'duplicate', motionId: g0r.motionId, chainId: g0r.chainId };
      }
      if (g0r.shortCircuit === 'version_conflict') return { status: 'version_conflict', expectedVersion: g0r.expectedVersion };
      return reject(candidate, 'G0', g0r.code, g0r.reason);
    }
    for (const [gate, fn] of [['G1', g1], ['G2', g2], ['G3', g3], ['G4', g4]]) {
      const r = fn(candidate);
      if (!r.ok) return reject(candidate, gate, r.code, r.reason);
    }
    // 全部通过 → Repository 提交（R4：Pipeline 不直写动作链表）
    let persisted;
    try {
      persisted = repository.createActionChain({
        semanticKey: candidate.semanticKey,
        description: candidate.description ?? '',
        emotion: candidate.emotion,
        expression: candidate.expression,
        gaze: candidate.gaze,
        bodyLanguage: candidate.bodyLanguage,
        chain: candidate.chain,
        provenance: candidate.provenance,
        validationReport: { gates: { G0: 'pass', G1: 'pass', G2: 'pass', G3: 'pass', G4: 'pass' }, registryRevision: registry.revision, validatedAt: new Date().toISOString() },
        sourceId: candidate.sourceId ?? null,
        modelCapabilityId: candidate.modelCapabilityId ?? null,
      });
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') return { status: 'version_conflict', reason: err.message };
      return reject(candidate, 'COMMIT', 'PERSIST_FAILED', err.message);
    }
    if (persisted.status === 'duplicate') {
      return healMissingSnapshot(persisted.motionId, persisted.chainId)
        || { status: 'duplicate', motionId: persisted.motionId, chainId: persisted.chainId };
    }
    // R7：validated 后导出不可变快照
    let snapshot = null;
    try {
      snapshot = repository.exportActionSnapshot(persisted.motionId);
    } catch (err) {
      // fix-p4/H1 ① 补偿：createActionChain 已提交（motion=validated + 链入库），
      // 不回滚也不降级——deprecated 是终态、会让有效动作永久不可用，比缺快照更糟。
      // 仅留痕（经 Repository，对 validated 只追加 failed 学习任务、不改状态），
      // 并返回明确的「待补导」状态，由 healMissingSnapshot 在下次 ingest 自愈。
      try {
        repository.recordRejectedAction(
          {
            semanticKey: candidate.semanticKey,
            description: candidate.description ?? '',
            code: 'SNAPSHOT_PENDING',
            sourceId: candidate.sourceId ?? null,
            modelCapabilityId: candidate.modelCapabilityId ?? null,
            evidence: { motionId: persisted.motionId, chainId: persisted.chainId },
          },
          'COMMIT',
          `快照导出失败，链已 validated 待补导：${err.message}`,
          candidate.provenance ?? null,
        );
      } catch { /* 留痕失败不掩盖主失败 */ }
      return {
        status: 'validated_snapshot_pending',
        motionId: persisted.motionId,
        chainId: persisted.chainId,
        reason: `快照导出失败，链已 validated 待补导：${err.message}`,
      };
    }
    return {
      status: 'validated',
      motionId: persisted.motionId,
      chainId: persisted.chainId,
      chainHash: persisted.chainHash,
      version: persisted.version,
      snapshot: { path: snapshot.path, contentSha256: snapshot.contentSha256 },
    };
  }

  return { ingest, gates: { G0: g0, G1: g1, G2: g2, G3: g3, G4: g4 } };
}
