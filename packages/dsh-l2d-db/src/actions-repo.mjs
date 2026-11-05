/**
 * dsh-l2d · Actions Lib Repository（语义层 / 动作链唯一写入口）
 *
 * 依据：docs/architecture/ACTIONS-JSON-INGESTION-RULES.md（R0–R10）
 *      docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md P0-A
 *
 * 硬性规则：
 *  - R4  唯一写入口：动作链创建/版本化/状态流转/拒绝留痕/快照导出只能经本模块。
 *  - R7  仅 validated 可导出快照；draft/analyzing/planned/rejected 不落文件。
 *  - R8  版本不可变：chain_json 一旦写入永不 UPDATE；修订=新版本（乐观并发）。
 *  - R9  semantic_key 幂等：同键同内容=幂等返回；同键不同内容=显式版本冲突，不静默覆盖。
 *  - R10 拒绝留痕：拒绝记录与中间产物永不删除。
 *  - R6  提交协议：快照 tmp → fsync → rename → SQLite 事务更新 → 哈希回读核对；
 *        文件系统与 SQLite 不构成跨资源 ACID，失败走补偿 + 留痕，不宣称伪原子。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withTransaction, resolveDbPath } from './db.mjs';
import { ACTION_STEP_KINDS, MOTION_STATUSES, EXECUTION_STATUSES, LEARNING_JOB_STATES, recordExecution } from './repo.mjs';

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export const SEMANTIC_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+){1,2}$/;

/** 状态机（motion_definitions.status 合法转换；rejected 为终态，R10 不复活）。 */
export const MOTION_TRANSITIONS = {
  draft: ['analyzing', 'rejected', 'deprecated'],
  analyzing: ['planned', 'rejected', 'deprecated'],
  planned: ['validated', 'rejected', 'deprecated'],
  validated: ['deprecated'],
  rejected: [],
  deprecated: [],
};

/** 规范化语义链并计算内容哈希（幂等判定的唯一依据，R9）。 */
export function canonicalChainHash(chain) {
  const normalized = {
    schemaVersion: String(chain.schemaVersion),
    steps: (chain.steps || []).map((s) => ({
      index: s.index,
      kind: s.kind,
      params: s.params ?? {},
      durationMs: s.durationMs ?? null,
      admission: s.admission ?? null,
      pairing: s.pairing ?? null,
    })),
  };
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function sha256Hex(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------- queries

function getMotionRow(db, motionId) {
  return db.prepare('SELECT * FROM motion_definitions WHERE id = ?').get(motionId) ?? null;
}

function getMotionBySemanticKey(db, semanticKey) {
  return db.prepare('SELECT * FROM motion_definitions WHERE semantic_key = ? ORDER BY rowid DESC LIMIT 1').get(semanticKey) ?? null;
}

/** 动作链第 N 版：按 created_at + rowid 稳定排序（只追加，故次序即版本）。 */
function listChainsForMotion(db, motionId) {
  return db.prepare(
    'SELECT * FROM action_chains WHERE motion_id = ? ORDER BY created_at, rowid',
  ).all(motionId);
}

function chainWithSteps(db, chainRow) {
  if (!chainRow) return null;
  const steps = db.prepare(
    'SELECT * FROM action_steps WHERE chain_id = ? ORDER BY step_index',
  ).all(chainRow.id).map((s) => ({
    index: s.step_index,
    kind: s.kind,
    params: JSON.parse(s.params_json || '{}'),
    durationMs: s.duration_ms,
    admission: s.admission,
    pairing: s.pairing_json ? JSON.parse(s.pairing_json) : null,
  }));
  return {
    id: chainRow.id,
    motionId: chainRow.motion_id,
    schemaVersion: chainRow.schema_version,
    chain: JSON.parse(chainRow.chain_json || '{}'),
    chainHash: chainRow.chain_hash,
    validationReport: chainRow.validation_report ? JSON.parse(chainRow.validation_report) : null,
    jsonAddress: chainRow.json_address,
    contentSha256: chainRow.content_sha256,
    createdAt: chainRow.created_at,
    version: chainRow.__version,
    steps,
  };
}

// ---------------------------------------------------------------- R9 幂等策略

/**
 * semantic_key 幂等判定（不得静默覆盖）。
 * @returns {{action:'create'} | {action:'duplicate', motion, chain} | {action:'version_conflict', motion, expectedVersion, chain}}
 */
export function resolveSemanticKey(db, semanticKey, chainHash) {
  const motion = getMotionBySemanticKey(db, semanticKey);
  if (!motion) return { action: 'create' };
  const chains = listChainsForMotion(db, motion.id);
  const latest = chains[chains.length - 1];
  if (latest && latest.chain_hash === chainHash) {
    return { action: 'duplicate', motion, chain: chainWithSteps(db, { ...latest, __version: chains.length }) };
  }
  return { action: 'version_conflict', motion, expectedVersion: motion.version, chain: chainWithSteps(db, { ...latest, __version: chains.length }) };
}

// ---------------------------------------------------------------- repository

export function createActionsRepository(db, { snapshotDir } = {}) {
  const snapRoot = snapshotDir ?? path.join(path.dirname(resolveDbPath()), 'motions');

  function persistProvenance(motionId, provenance) {
    // 素材（幂等，按 content_hash）+ 分析 + 溯源关联（R7 溯源完整性由 G0 保证）
    const assetIds = [];
    for (const a of provenance?.assets ?? []) {
      const row = db.prepare(
        'SELECT id FROM motion_assets WHERE source_type = ? AND content_hash = ?',
      ).get(a.sourceType, a.contentHash);
      if (row) { assetIds.push(row.id); continue; }
      db.prepare(`
        INSERT INTO motion_assets (id, source_type, original_path, archive_path, content_hash, imported_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(a.id ?? uuid(), a.sourceType, a.originalPath, a.archivePath ?? null, a.contentHash, nowIso(),
        a.metadata ? JSON.stringify(a.metadata) : null);
      assetIds.push(db.prepare('SELECT id FROM motion_assets WHERE source_type = ? AND content_hash = ?').get(a.sourceType, a.contentHash).id);
    }
    const analysisIds = [];
    for (const an of provenance?.analyses ?? []) {
      const analysisId = uuid(); // 行 id 全局唯一；来源逻辑 id 记入分析体内
      db.prepare(`
        INSERT INTO motion_analysis (id, asset_id, model_name, analysis_json, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(analysisId, an.assetId, an.modelName,
        typeof an.analysis === 'string' ? an.analysis : JSON.stringify({ ...(an.analysis ?? {}), sourceAnalysisId: an.id ?? null }),
        an.confidence ?? null, nowIso());
      analysisIds.push(analysisId);
    }
    // motion_sources：motion × asset 关联；分析挂到首个 asset（简化记录，保留全部分析行）
    assetIds.forEach((assetId, i) => {
      db.prepare(`
        INSERT OR IGNORE INTO motion_sources (motion_id, asset_id, analysis_id)
        VALUES (?, ?, ?)
      `).run(motionId, assetId, analysisIds[i] ?? analysisIds[0] ?? null);
    });
    return { assetIds, analysisIds };
  }

  function insertChainRow(motionId, { chain, schemaVersion, validationReport, chainHash, steps }) {
    const chainId = uuid();
    db.prepare(`
      INSERT INTO action_chains (id, motion_id, chain_json, schema_version, validation_report, chain_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(chainId, motionId, JSON.stringify(chain), schemaVersion, validationReport ? JSON.stringify(validationReport) : null, chainHash, nowIso());
    steps.forEach((s, i) => {
      db.prepare(`
        INSERT INTO action_steps (id, chain_id, step_index, kind, params_json, duration_ms, admission, pairing_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`${chainId}#${i}`, chainId, s.index ?? i, s.kind, JSON.stringify(s.params ?? {}),
        s.durationMs ?? null, s.admission ?? null, s.pairing ? JSON.stringify(s.pairing) : null);
    });
    return chainId;
  }

  function logTransition(motionId, fromStatus, toStatus, actor, reason) {
    db.prepare('INSERT INTO motion_status_log (motion_id, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)')
      .run(motionId, fromStatus, toStatus, actor ?? null, reason ?? null);
  }

  function upsertLearningJob(sourceId, modelCapabilityId, state, error = null) {
    if (!sourceId) return;
    // 每次调用 = 一条新任务记录（学习任务是事件流，同 source 多次失败是合法多行）；
    // 原 ON CONFLICT(id) 分支因 id 恒为新 uuid 而成为死代码，已移除（R10 事件只增不改）。
    db.prepare(`
      INSERT INTO learning_jobs (id, source_id, model_capability_id, state, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), sourceId, modelCapabilityId ?? 'unknown', state, error ? JSON.stringify(error) : null, nowIso(), nowIso());
  }

  // ------------------------------------------------------------ create

  /** 创建（经 G0–G4 验证的）validated 动作链。同键同内容幂等；同键异内容抛 VERSION_CONFLICT。 */
  function createActionChain(input) {
    const { semanticKey, description, chain, provenance, sourceId = null, modelCapabilityId = null, actor = 'pipeline' } = input;
    if (!SEMANTIC_KEY_RE.test(semanticKey ?? '')) throw new Error(`createActionChain: semantic_key 非法：${semanticKey}`);
    if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) throw new Error('createActionChain: chain.steps 必须非空');
    for (const [index, s] of chain.steps.entries()) {
      if (!ACTION_STEP_KINDS.includes(s.kind)) throw new Error(`createActionChain: 非法 step kind ${s.kind}`);
      if (!Number.isInteger(s.durationMs) || s.durationMs < 0 || s.durationMs > 30000) {
        throw new Error(`createActionChain: steps[${index}].durationMs 必须是 0~30000 的整数毫秒`);
      }
    }
    const chainHash = canonicalChainHash(chain);
    return withTransaction(db, () => {
      const decision = resolveSemanticKey(db, semanticKey, chainHash);
      if (decision.action === 'duplicate') return { status: 'duplicate', motionId: decision.motion.id, chainId: decision.chain.id, chainHash };
      if (decision.action === 'version_conflict') {
        const err = new Error(`semantic_key '${semanticKey}' 已存在且内容不同（R9 不静默覆盖）；请走 createActionChainVersion（expectedVersion=${decision.expectedVersion}）`);
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      const motionId = input.motionId ?? uuid();
      db.prepare(`
        INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'validated', ?, ?)
      `).run(motionId, semanticKey, description, input.emotion ?? null, input.expression ?? null,
        input.gaze ?? null, input.bodyLanguage ?? null, nowIso(), nowIso());
      persistProvenance(motionId, provenance);
      const chainId = insertChainRow(motionId, { chain, schemaVersion: chain.schemaVersion, validationReport: input.validationReport ?? null, chainHash, steps: chain.steps });
      logTransition(motionId, null, 'validated', actor, 'ingested via G0-G4 pipeline');
      upsertLearningJob(sourceId, modelCapabilityId, 'persisted');
      return { status: 'created', motionId, chainId, chainHash, version: 1 };
    });
  }

  // ------------------------------------------------------------ read

  function getActionChain(motionIdOrChainId, version) {
    // 先按 chain id 直查
    const byId = db.prepare('SELECT * FROM action_chains WHERE id = ?').get(motionIdOrChainId);
    if (byId) return chainWithSteps(db, { ...byId, __version: listChainsForMotion(db, byId.motion_id).findIndex((c) => c.id === byId.id) + 1 });
    const chains = listChainsForMotion(db, motionIdOrChainId);
    if (chains.length === 0) return null;
    const v = version ?? chains.length; // 省略版本 → 最新（按稳定追加序）
    if (!Number.isInteger(v) || v < 1 || v > chains.length) throw new Error(`getActionChain: 版本越界 ${v}（共 ${chains.length} 版）`);
    return chainWithSteps(db, { ...chains[v - 1], __version: v });
  }

  function listActionChains({ status, semanticKey, limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('m.status = ?'); args.push(status); }
    if (semanticKey) { where.push('m.semantic_key = ?'); args.push(semanticKey); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM action_chains c JOIN motion_definitions m ON m.id = c.motion_id ${whereSql}`).get(...args).n;
    const rows = db.prepare(`
      SELECT c.*, m.semantic_key AS semanticKey, m.status AS motionStatus, m.version AS motionVersion
      FROM action_chains c JOIN motion_definitions m ON m.id = c.motion_id
      ${whereSql} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    return { total, rows };
  }

  // ------------------------------------------------------------ 状态机

  function transitionActionChainStatus(motionId, expectedVersion, nextStatus, actor, reason) {
    if (!MOTION_STATUSES.includes(nextStatus)) throw new Error(`transitionActionChainStatus: 非法状态 ${nextStatus}`);
    return withTransaction(db, () => {
      const motion = getMotionRow(db, motionId);
      if (!motion) throw new Error(`transitionActionChainStatus: motion 不存在 ${motionId}`);
      if (motion.version !== expectedVersion) {
        const err = new Error(`transitionActionChainStatus: 乐观并发冲突（期望 v${expectedVersion}，实际 v${motion.version}）`);
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      const allowed = MOTION_TRANSITIONS[motion.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        const err = new Error(`transitionActionChainStatus: 非法转换 ${motion.status} → ${nextStatus}`);
        err.code = 'ILLEGAL_TRANSITION';
        throw err;
      }
      db.prepare('UPDATE motion_definitions SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, nowIso(), motionId);
      logTransition(motionId, motion.status, nextStatus, actor, reason);
      return getMotionRow(db, motionId);
    });
  }

  // ------------------------------------------------------------ 版本修订（乐观并发）

  function createActionChainVersion(motionId, input, expectedVersion) {
    const { chain, validationReport = null, sourceId = null, modelCapabilityId = null, actor = 'pipeline' } = input;
    if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) throw new Error('createActionChainVersion: chain.steps 必须非空');
    for (const s of chain.steps) if (!ACTION_STEP_KINDS.includes(s.kind)) throw new Error(`createActionChainVersion: 非法 step kind ${s.kind}`);
    const chainHash = canonicalChainHash(chain);
    return withTransaction(db, () => {
      const motion = getMotionRow(db, motionId);
      if (!motion) throw new Error(`createActionChainVersion: motion 不存在 ${motionId}`);
      if (motion.version !== expectedVersion) {
        const err = new Error(`createActionChainVersion: 乐观并发冲突（期望 v${expectedVersion}，实际 v${motion.version}）`);
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      const fromStatus = motion.status;
      if (!['validated', 'deprecated'].includes(fromStatus)) {
        const err = new Error(`createActionChainVersion: 仅 validated/deprecated 动作可修订，当前 ${fromStatus}`);
        err.code = 'ILLEGAL_TRANSITION';
        throw err;
      }
      db.prepare('UPDATE motion_definitions SET version = version + 1, status = ?, updated_at = ? WHERE id = ? AND version = ?')
        .run('validated', nowIso(), motionId, expectedVersion);
      persistProvenance(motionId, input.provenance);
      const chainId = insertChainRow(motionId, { chain, schemaVersion: chain.schemaVersion, validationReport, chainHash, steps: chain.steps });
      logTransition(motionId, fromStatus, 'validated', actor, `revision to v${expectedVersion + 1}`);
      upsertLearningJob(sourceId, modelCapabilityId, 'persisted');
      return { status: 'created', motionId, chainId, chainHash, version: expectedVersion + 1 };
    });
  }

  // ------------------------------------------------------------ R7 快照导出（R6 提交协议）

  function buildSnapshot(motion, chainRow, version) {
    const sources = db.prepare(`
      SELECT ms.asset_id AS assetId, ms.analysis_id AS analysisId,
             a.source_type AS sourceType, a.original_path AS originalPath, a.content_hash AS contentHash,
             an.model_name AS modelName, an.confidence AS confidence
      FROM motion_sources ms
      LEFT JOIN motion_assets a ON a.id = ms.asset_id
      LEFT JOIN motion_analysis an ON an.id = ms.analysis_id
      WHERE ms.motion_id = ?
    `).all(motion.id);
    const steps = db.prepare('SELECT * FROM action_steps WHERE chain_id = ? ORDER BY step_index').all(chainRow.id)
      .map((s) => ({ index: s.step_index, kind: s.kind, params: JSON.parse(s.params_json || '{}'), durationMs: s.duration_ms, admission: s.admission, pairing: s.pairing_json ? JSON.parse(s.pairing_json) : null }));
    const snapshot = {
      schemaVersion: chainRow.schema_version,
      motionId: motion.id,
      semanticKey: motion.semantic_key,
      description: motion.description,
      emotion: motion.emotion, expression: motion.expression, gaze: motion.gaze, bodyLanguage: motion.body_language,
      status: motion.status,
      version,
      actionChain: steps,
      provenance: { sources },
      validation: chainRow.validation_report ? JSON.parse(chainRow.validation_report) : null,
      createdAt: motion.created_at, updatedAt: motion.updated_at,
    };
    const contentSha256 = sha256Hex(Buffer.from(JSON.stringify(snapshot)));
    return { snapshot: { ...snapshot, contentSha256 }, contentSha256 };
  }

  /**
   * 导出快照（仅 validated；一版一件不可变）。
   * R6 协议：tmp → fsync → rename → tx 更新 json_address/content_sha256 → 回读核对 → 失败补偿。
   */
  function exportActionSnapshot(motionId, version) {
    const motion = getMotionRow(db, motionId);
    if (!motion) throw new Error(`exportActionSnapshot: motion 不存在 ${motionId}`);
    if (motion.status !== 'validated') {
      const err = new Error(`exportActionSnapshot: 仅 validated 可导出（R7），当前 ${motion.status}`);
      err.code = 'SNAPSHOT_NOT_ALLOWED';
      throw err;
    }
    const chains = listChainsForMotion(db, motionId);
    const v = version ?? chains.length;
    const chainRow = chains[v - 1];
    if (!chainRow) throw new Error(`exportActionSnapshot: 版本不存在 v${v}`);
    if (chainRow.json_address) {
      const err = new Error(`exportActionSnapshot: 快照已存在且不可变（R3）：${chainRow.json_address}`);
      err.code = 'SNAPSHOT_EXISTS';
      throw err;
    }
    const { snapshot, contentSha256 } = buildSnapshot(motion, chainRow, v);
    const now = new Date();
    const dir = path.join(snapRoot, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
    const target = path.join(dir, `${motion.id}.v${v}.json`);
    const tmp = target + '.tmp';
    // GLM 验收 WARN-4 修复：崩溃残留孤儿（文件在而 DB 无登记）显式清理后重建；
    // 已登记快照（DB 有 json_address）在上方 SNAPSHOT_EXISTS 分支拒绝，永不覆盖。
    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target); } catch (unlinkErr) {
        const err = new Error(`exportActionSnapshot: 发现孤儿快照且清理失败：${unlinkErr.message}`);
        err.code = 'SNAPSHOT_ORPHAN_CONFLICT';
        throw err;
      }
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const body = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* tmp 不存在 */ }
      // 统一门面错误码（原始错误挂 cause），保证上层可按稳定码分支
      const wrapped = new Error(`快照写入失败：${err.message}`);
      wrapped.code = 'SNAPSHOT_WRITE_FAILED';
      wrapped.cause = err;
      throw wrapped; // 文件失败 → 不写库，无伪成功状态
    }
    // 文件已落盘 → 事务内记录地址与哈希
    withTransaction(db, () => {
      db.prepare('UPDATE action_chains SET json_address = ?, content_sha256 = ? WHERE id = ?').run(target, contentSha256, chainRow.id);
    });
    // 回读核对（R6 第 6 步）：剔除文件内 contentSha256 字段后按同一口径重算
    const written = fs.readFileSync(target);
    const parsedSnapshot = JSON.parse(written.toString('utf8'));
    delete parsedSnapshot.contentSha256;
    const recomputed = sha256Hex(Buffer.from(JSON.stringify(parsedSnapshot)));
    if (recomputed !== contentSha256) {
      try { fs.unlinkSync(target); } catch { /* 补偿失败则留痕 */ }
      withTransaction(db, () => {
        db.prepare('UPDATE action_chains SET json_address = NULL, content_sha256 = NULL WHERE id = ?').run(chainRow.id);
      });
      const err = new Error('exportActionSnapshot: 回读哈希核对失败，已补偿回滚（文件删除 + 列清空）');
      err.code = 'PERSIST_VERIFY_FAILED';
      throw err;
    }
    return { path: target, contentSha256, version: v, snapshotPathKey: 'json_address' };
  }

  // ------------------------------------------------------------ R10 拒绝留痕

  /**
   * 持久化拒绝记录（不静默丢弃，不删除中间产物）。
   * 已存在 validated 动作时绝不覆盖，仅追加学习任务失败记录。
   */
  function recordRejectedAction(input, gate, reason, provenance) {
    const { semanticKey, description = '', chain = null, code = 'REJECTED', sourceId = null, modelCapabilityId = null, actor = 'pipeline', evidence = null } = input;
    return withTransaction(db, () => {
      const existing = getMotionBySemanticKey(db, semanticKey);
      if (existing && existing.status === 'validated') {
        upsertLearningJob(sourceId, modelCapabilityId, 'failed', { code, gate, reason, keptMotionId: existing.id });
        return { status: 'rejected_logged', keptMotionId: existing.id, createdMotionId: null };
      }
      let motionId = existing?.id ?? null;
      const fromStatus = existing?.status ?? null;
      if (!motionId) {
        motionId = uuid();
        db.prepare(`
          INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 'rejected', ?, ?)
        `).run(motionId, semanticKey, description, input.emotion ?? null, nowIso(), nowIso());
        logTransition(motionId, null, 'rejected', actor, `${gate}: ${reason}`);
      } else if (fromStatus !== 'rejected') {
        const allowed = MOTION_TRANSITIONS[fromStatus] ?? [];
        if (!allowed.includes('rejected')) {
          // 转换非法（如 deprecated）也必须留痕，但不能破坏状态机 → 仅记日志
          logTransition(motionId, fromStatus, fromStatus, actor, `rejected@${gate} 不可应用（状态 ${fromStatus}）；原因留痕于此`);
          upsertLearningJob(sourceId, modelCapabilityId, 'failed', { code, gate, reason });
          return { status: 'rejected_logged', keptMotionId: motionId, createdMotionId: null };
        }
        db.prepare('UPDATE motion_definitions SET status = ?, updated_at = ? WHERE id = ?').run('rejected', nowIso(), motionId);
        logTransition(motionId, fromStatus, 'rejected', actor, `${gate}: ${reason}`);
      }
      let report = { gate, code, reason, evidence, rejectedAt: nowIso() };
      if (chain) {
        // 拒绝留痕的溯源可能含悬空引用（如分析引用未知素材）——尽力持久化，
        // 失败则将原始溯源并入 validation_report 证据，绝不让留痕本身失败（R10）
        try {
          persistProvenance(motionId, provenance);
        } catch (provErr) {
          report = { ...report, provenanceFallback: provenance, provenanceError: provErr.message };
        }
        insertChainRow(motionId, {
          chain, schemaVersion: chain.schemaVersion ?? '1.0',
          validationReport: report,
          chainHash: canonicalChainHash(chain), steps: chain.steps ?? [],
        });
      } else if (provenance && report.provenanceFallback === undefined) {
        // 无链但有溯源：并入学习任务错误上下文（已在 upsertLearningJob 记录 gate/reason）
      }
      upsertLearningJob(sourceId, modelCapabilityId, 'failed', { code, gate, reason });
      return { status: 'rejected', motionId, gate, code };
    });
  }

  function listRejections({ semanticKey, limit = 50 } = {}) {
    const rows = semanticKey
      ? db.prepare(`SELECT l.* FROM motion_status_log l JOIN motion_definitions m ON m.id = l.motion_id WHERE m.semantic_key = ? AND l.to_status = 'rejected' ORDER BY l.id DESC LIMIT ?`).all(semanticKey, limit)
      : db.prepare(`SELECT * FROM motion_status_log WHERE to_status = 'rejected' ORDER BY id DESC LIMIT ?`).all(limit);
    return rows;
  }

  // ------------------------------------------------------------ 执行历史（受控入口）

  function recordExecutionHistory({ motionId, chainId, modelId, status, request = null, result = null, startedAt = null, finishedAt = null }) {
    if (!getMotionRow(db, motionId)) throw new Error(`recordExecutionHistory: motion 不存在 ${motionId}`);
    if (!EXECUTION_STATUSES.includes(status)) throw new Error(`recordExecutionHistory: 非法 status ${status}`);
    if (chainId) {
      const chain = db.prepare('SELECT motion_id FROM action_chains WHERE id = ?').get(chainId);
      if (!chain || chain.motion_id !== motionId) throw new Error(`recordExecutionHistory: chainId ${chainId} 不属于 motion ${motionId}`);
    }
    return recordExecution(db, { execId: uuid(), motionId, modelId, status, request, result, startedAt, finishedAt });
  }

  // ------------------------------------------------------------ 便捷查询

  function getMotion(motionId) { return getMotionRow(db, motionId); }
  function getMotionBySemanticKeyPub(semanticKey) { return getMotionBySemanticKey(db, semanticKey); }

  return {
    createActionChain, createActionChainVersion,
    resolveSemanticKey: (semanticKey, chainHash) => resolveSemanticKey(db, semanticKey, chainHash),
    getActionChain, listActionChains, getMotion, getMotionBySemanticKey: getMotionBySemanticKeyPub,
    transitionActionChainStatus, exportActionSnapshot,
    recordRejectedAction, listRejections, recordExecutionHistory,
    snapshotRoot: snapRoot,
  };
}

export { LEARNING_JOB_STATES };
