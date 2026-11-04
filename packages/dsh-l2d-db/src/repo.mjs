/**
 * dsh-l2d · 注册表仓储层（幂等写入 + 校验）
 *
 * 原则（与 skills/dsh-l2d-model-intelligence 一致）：
 *  - 重复注册=更新，不产生重复行；
 *  - 推断数据（semantic_labels）与解析事实（nodes/edges）分表存放；
 *  - 所有写入在事务内；非法枚举由 CHECK 拒绝，不做静默兜底。
 *  - 审核闸门（gallery review.mjs 是唯一流转入口）：已裁决（approved/rejected）的
 *    gallery 行不允许被任何 Repository 写路径覆写 review_state / evidence；
 *  - 模型 runtime_verified 状态只能由运行时探针流程（带 runtimeEvidence）写入。
 */
import { withTransaction } from './db.mjs';

const nowIso = () => new Date().toISOString();

function json(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- skills

export const SKILL_STATUSES = ['discovered', 'valid', 'registered', 'loaded', 'degraded', 'invalid', 'missing'];

/** 幂等注册 Skill（按 name upsert）。 */
export function upsertSkill(db, { name, version, path, contentHash, frontmatter, status = 'discovered', workspaceRole = null }) {
  if (!name || !version) throw new Error('upsertSkill: name 与 version 必填');
  if (!SKILL_STATUSES.includes(status)) throw new Error(`upsertSkill: 非法状态 ${status}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO skills (name, version, path, content_hash, frontmatter, status, workspace_role, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        path = excluded.path,
        content_hash = excluded.content_hash,
        frontmatter = excluded.frontmatter,
        status = excluded.status,
        workspace_role = excluded.workspace_role,
        updated_at = excluded.updated_at
    `).run(name, version, path ?? null, contentHash ?? null,
      json(frontmatter, null), status, workspaceRole, nowIso());
    return db.prepare('SELECT * FROM skills WHERE name = ?').get(name);
  });
}

// ---------------------------------------------------------------- workspaces

export const WORKSPACE_ROLES = ['orchestrator', 'model-inspector', 'behavior-engineer', 'live2d-agent'];

/** 幂等登记工作区（按 role upsert；ID 变更即恢复记录）。 */
export function upsertWorkspace(db, { role, workspaceId, sessionId = null, title, directory, systemPromptVersion, skillBindings = [], toolPermissions = {}, status = 'active' }) {
  if (!WORKSPACE_ROLES.includes(role)) throw new Error(`upsertWorkspace: 未知角色 ${role}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO workspaces (role, workspace_id, session_id, title, directory, system_prompt_version, skill_bindings, tool_permissions, status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        title = excluded.title,
        directory = excluded.directory,
        system_prompt_version = excluded.system_prompt_version,
        skill_bindings = excluded.skill_bindings,
        tool_permissions = excluded.tool_permissions,
        status = excluded.status,
        last_verified_at = excluded.last_verified_at
    `).run(role, workspaceId, sessionId, title, directory, systemPromptVersion,
      json(skillBindings, '[]'), json(toolPermissions, '{}'), status, nowIso());
    return db.prepare('SELECT * FROM workspaces WHERE role = ?').get(role);
  });
}

// ---------------------------------------------------------------- toolchain

export const TOOLCHAIN_STATUSES = ['present_verified', 'present_unverified', 'missing', 'incompatible', 'license_gated'];

/** 幂等登记工具链组件（按 name upsert）。 */
export function upsertToolchainComponent(db, { name, kind = 'tool', version = null, sourceUrl = null, commitSha = null, installPath = null, checksum = null, provenance = null, status = 'missing', smokeTest = null }) {
  if (!TOOLCHAIN_STATUSES.includes(status)) throw new Error(`upsertToolchainComponent: 非法状态 ${status}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO toolchain_components (name, kind, version, source_url, commit_sha, install_path, checksum, provenance, status, smoke_test, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        kind = excluded.kind,
        version = excluded.version,
        source_url = excluded.source_url,
        commit_sha = excluded.commit_sha,
        install_path = excluded.install_path,
        checksum = excluded.checksum,
        provenance = excluded.provenance,
        status = excluded.status,
        smoke_test = excluded.smoke_test,
        last_verified_at = excluded.last_verified_at
    `).run(name, kind, version, sourceUrl, commitSha, installPath, checksum, provenance,
      status, json(smokeTest, null), nowIso());
    return db.prepare('SELECT * FROM toolchain_components WHERE name = ?').get(name);
  });
}

/** 工具链健康快照（MCP l2d_toolchain_status 的数据源）。 */
export function toolchainSnapshot(db) {
  return db.prepare(`
    SELECT name, kind, version, status, commit_sha AS commitSha, install_path AS installPath,
           last_verified_at AS lastVerifiedAt, smoke_test AS smokeTest
    FROM toolchain_components ORDER BY name
  `).all().map((row) => ({ ...row, smokeTest: row.smokeTest ? JSON.parse(row.smokeTest) : null }));
}

// ---------------------------------------------------------------- startup checks

/** 追加一条启动检查记录（只追加，不更新）。 */
export function recordStartupCheck(db, { runId, component, phase = 'p1', status, gate = null, detail = null }) {
  if (!runId || !component) throw new Error('recordStartupCheck: runId 与 component 必填');
  return withTransaction(db, () => {
    const result = db.prepare(`
      INSERT INTO startup_checks (run_id, component, phase, status, gate, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, component, phase, status, gate, json(detail, null));
    return result.lastInsertRowid;
  });
}

/** 汇总某次启动的 Bootstrap Report（每组件取最新一条）。 */
export function startupReport(db, runId) {
  const rows = db.prepare(`
    SELECT component, phase, status, gate, detail, created_at AS createdAt
    FROM startup_checks WHERE run_id = ? ORDER BY id
  `).all(runId);
  const latest = new Map();
  for (const row of rows) latest.set(row.component, row); // 后写覆盖，即最新
  return {
    runId,
    components: [...latest.values()],
    gate: latest.get('gate')?.gate ?? null,
  };
}

// ---------------------------------------------------------------- tasks

export const TASK_STATUSES = ['pending', 'assigned', 'running', 'done', 'failed', 'cancelled'];

export function createTask(db, { taskId, parentTaskId = null, assignedWorkspace = null, assignedSkill = null, modelId = null, analysisJobId = null, title = '', inputArtifacts = [], expectedOutputs = [], priority = 'NORMAL', deadline = null }) {
  if (!taskId) throw new Error('createTask: taskId 必填');
  if (!TASK_STATUSES.includes('pending')) throw new Error('unreachable');
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO tasks (task_id, parent_task_id, assigned_workspace, assigned_skill, model_id, analysis_job_id, title, input_artifacts, expected_outputs, priority, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, parentTaskId, assignedWorkspace, assignedSkill, modelId, analysisJobId,
      title, json(inputArtifacts, '[]'), json(expectedOutputs, '[]'), priority, deadline);
    return getTask(db, taskId);
  });
}

export function updateTaskStatus(db, taskId, status, { evidence = null, error = null } = {}) {
  if (!TASK_STATUSES.includes(status)) throw new Error(`updateTaskStatus: 非法状态 ${status}`);
  return withTransaction(db, () => {
    const info = db.prepare(`
      UPDATE tasks SET status = ?, evidence = COALESCE(?, evidence), error = COALESCE(?, error),
        updated_at = ? WHERE task_id = ?
    `).run(status, evidence === null ? null : JSON.stringify(evidence), error, nowIso(), taskId);
    if (info.changes === 0) throw new Error(`updateTaskStatus: 任务不存在 ${taskId}`);
    return getTask(db, taskId);
  });
}

export function getTask(db, taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  if (!row) return null;
  return {
    ...row,
    inputArtifacts: JSON.parse(row.input_artifacts || '[]'),
    expectedOutputs: JSON.parse(row.expected_outputs || '[]'),
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}

// ---------------------------------------------------------------- model intelligence

/** 幂等登记模型（按 model_id upsert；package_hash 唯一防同一包重复建档）。
 *  状态闸门：status='runtime_verified' 只能由运行时探针流程写入——必须同时提供
 *  runtimeEvidence（{ probeRun, verifiedAt, probedBy, ... }），否则拒绝，防止
 *  'validated'（静态管道）与 'runtime_verified'（真实渲染探针）两种状态被混用。 */
export function upsertModel(db, { modelId, title = null, sourcePath, packageHash, moc3Version = null, status = 'imported', runtimeEvidence = null }) {
  if (!modelId || !sourcePath || !packageHash) throw new Error('upsertModel: modelId/sourcePath/packageHash 必填');
  return withTransaction(db, () => {
    if (status === 'runtime_verified') {
      if (!runtimeEvidence || typeof runtimeEvidence !== 'object') {
        const err = new Error(`upsertModel: '${modelId}' 置 runtime_verified 需提供 runtimeEvidence（真实渲染探针证据）；静态管道验证不得自封该状态`);
        err.code = 'RUNTIME_EVIDENCE_REQUIRED';
        throw err;
      }
    }
    db.prepare(`
      INSERT INTO models (model_id, title, source_path, package_hash, moc3_version, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        title = excluded.title,
        source_path = excluded.source_path,
        package_hash = excluded.package_hash,
        moc3_version = excluded.moc3_version,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(modelId, title, sourcePath, packageHash, moc3Version, status);
    if (status === 'runtime_verified') {
      // 证据留痕（审核可回溯；结构与 execution/probe 证据同风格）
      db.prepare('INSERT INTO motion_status_log (motion_id, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)')
        .run(`model:${modelId}`, null, 'runtime_verified', String(runtimeEvidence.probedBy ?? 'runtime-probe'),
          JSON.stringify({ probeRun: runtimeEvidence.probeRun ?? null, verifiedAt: runtimeEvidence.verifiedAt ?? nowIso() }));
    }
    return db.prepare('SELECT * FROM models WHERE model_id = ?').get(modelId);
  });
}

/** 幂等写源文件清单（按 model_id + relative_path upsert）。 */
export function upsertSourceFile(db, { modelId, relativePath, sha256 = null, sizeBytes = null, format = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO source_files (model_id, relative_path, sha256, size_bytes, format)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(model_id, relative_path) DO UPDATE SET
        sha256 = excluded.sha256, size_bytes = excluded.size_bytes, format = excluded.format
    `).run(modelId, relativePath, sha256, sizeBytes, format);
    return db.prepare('SELECT id FROM source_files WHERE model_id = ? AND relative_path = ?').get(modelId, relativePath);
  });
}

/** 幂等写结构节点（按 model_id + node_key upsert）。返回节点 id。 */
export function upsertNode(db, { modelId, nodeKey, nodeType, displayName = null, evidenceLevel = 'parser_derived', confidence = null, sourceFileId = null, sourcePointer = null, parserName = null, parserVersion = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO nodes (model_id, node_key, node_type, display_name, evidence_level, confidence, source_file_id, source_pointer, parser_name, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id, node_key) DO UPDATE SET
        node_type = excluded.node_type,
        display_name = excluded.display_name,
        evidence_level = excluded.evidence_level,
        confidence = excluded.confidence,
        source_file_id = excluded.source_file_id,
        source_pointer = excluded.source_pointer,
        parser_name = excluded.parser_name,
        parser_version = excluded.parser_version
    `).run(modelId, nodeKey, nodeType, displayName, evidenceLevel, confidence, sourceFileId, sourcePointer, parserName, parserVersion);
    return db.prepare('SELECT id FROM nodes WHERE model_id = ? AND node_key = ?').get(modelId, nodeKey).id;
  });
}

/** 幂等写有向边（按 model_id + edge_type + src + dst upsert）。 */
export function upsertEdge(db, { modelId, srcId, dstId, edgeType, evidenceLevel = 'parser_derived', confidence = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO edges (model_id, src_id, dst_id, edge_type, evidence_level, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id, edge_type, src_id, dst_id) DO UPDATE SET
        evidence_level = excluded.evidence_level, confidence = excluded.confidence
    `).run(modelId, srcId, dstId, edgeType, evidenceLevel, confidence);
  });
}

/** 幂等写参数目录（按 model_id + param_id upsert）。 */
/** 幂等写参数（按 model_id + param_id upsert）。
 *  双层边界语义（v6，用户裁决 2026-11-05）：
 *  - minValue/maxValue = Hard Boundary（moc3 理论边界，硬性限幅）；
 *  - softMin/softMax = Soft Motion Envelope（实测摆幅，动作推荐范围，可 NULL）；
 *  - 证据纪律：range_evidence 记录数据来源；COALESCE 保留已有证据不回退。 */
export function upsertParameter(db, { modelId, paramId, name = null, minValue = null, maxValue = null, defaultValue = null, nodeId = null, rangeEvidence = null, softMin = null, softMax = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO parameters (model_id, param_id, name, min_value, max_value, default_value, node_id, range_evidence, soft_min, soft_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id, param_id) DO UPDATE SET
        name = excluded.name, min_value = excluded.min_value, max_value = excluded.max_value,
        default_value = excluded.default_value, node_id = excluded.node_id,
        soft_min = COALESCE(excluded.soft_min, parameters.soft_min),
        soft_max = COALESCE(excluded.soft_max, parameters.soft_max),
        range_evidence = COALESCE(excluded.range_evidence, parameters.range_evidence)
    `).run(modelId, paramId, name, minValue, maxValue, defaultValue, nodeId, rangeEvidence ? JSON.stringify(rangeEvidence) : null, softMin, softMax);
    return db.prepare('SELECT id FROM parameters WHERE model_id = ? AND param_id = ?').get(modelId, paramId).id;
  });
}

/** 新建分析任务（id 调用方生成；同 id 重复创建抛错）。 */
export function createAnalysisJob(db, { analysisJobId, modelId, toolVersions = {} }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO analysis_jobs (id, model_id, tool_versions) VALUES (?, ?, ?)
    `).run(analysisJobId, modelId, json(toolVersions, '{}'));
    return analysisJobId;
  });
}

export function finishAnalysisJob(db, analysisJobId, status, notes = null) {
  if (!['done', 'failed'].includes(status)) throw new Error(`finishAnalysisJob: 非法结束状态 ${status}`);
  return withTransaction(db, () => {
    db.prepare(`UPDATE analysis_jobs SET status = ?, finished_at = ?, notes = ? WHERE id = ?`)
      .run(status, nowIso(), notes, analysisJobId);
  });
}

/** 幂等保存能力画像（按 model_id + version upsert）。 */
export function saveCapabilityProfile(db, { modelId, version, profile }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO capability_profiles (model_id, version, profile) VALUES (?, ?, ?)
      ON CONFLICT(model_id, version) DO UPDATE SET profile = excluded.profile
    `).run(modelId, version, json(profile, '{}'));
  });
}

/** 记录验证发现（可重复，追加式）。 */
export function addValidationFinding(db, { modelId, severity, code, message, evidence = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO validation_findings (model_id, severity, code, message, evidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(modelId, severity, code, message, json(evidence, null));
  });
}

// ---------------------------------------------------------------- gallery（v2 图库语义域）

export const GALLERY_SOURCE_CLASSES = ['character_sheet', 'fan_art', 'screenshot', 'gif_reference', 'photo', 'poster', 'other'];
export const GALLERY_LABEL_FIELDS = ['part', 'expression', 'pose', 'outfit', 'style', 'scene', 'motion_cue', 'color', 'other'];
export const GALLERY_REVIEW_STATES = ['pending', 'labeled', 'approved', 'rejected'];
export const PROMPT_TEMPLATE_STATUSES = ['draft', 'active', 'deprecated'];

/** 幂等登记图库条目（按 file_name upsert；sha256 仅索引不唯一——同名覆盖、重名图允许各自登记）。 */
export function upsertGalleryItem(db, { fileName, realFormat, ext, width = null, height = null, sizeBytes = null, sha256 = null, sourceClass = 'other', reviewState = 'pending', notes = null }) {
  if (!fileName || !realFormat || !ext) throw new Error('upsertGalleryItem: fileName/realFormat/ext 必填');
  if (!GALLERY_SOURCE_CLASSES.includes(sourceClass)) throw new Error(`upsertGalleryItem: 非法 source_class ${sourceClass}`);
  if (!GALLERY_REVIEW_STATES.includes(reviewState)) throw new Error(`upsertGalleryItem: 非法 review_state ${reviewState}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO gallery_items (file_name, real_format, ext, width, height, size_bytes, sha256, source_class, review_state, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_name) DO UPDATE SET
        real_format = excluded.real_format,
        ext = excluded.ext,
        width = excluded.width,
        height = excluded.height,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        source_class = excluded.source_class,
        -- 审核闸门：已裁决（approved/rejected）条目的 review_state/notes 不被覆写
        review_state = CASE WHEN gallery_items.review_state IN ('approved','rejected')
                            THEN gallery_items.review_state ELSE excluded.review_state END,
        notes = CASE WHEN gallery_items.review_state IN ('approved','rejected')
                     THEN gallery_items.notes ELSE excluded.notes END,
        updated_at = excluded.updated_at
    `).run(fileName, realFormat, ext, width, height, sizeBytes, sha256, sourceClass, reviewState, notes);
    return db.prepare('SELECT * FROM gallery_items WHERE file_name = ?').get(fileName);
  });
}

/** 幂等写图库语义标签（按 item + field + value upsert）。返回标签 id。
 *  审核闸门：已裁决（approved/rejected）标签整体不可覆写（审核基于当时的证据作出，
 *  数据字段被事后修改会破坏裁决的审计一致性）。新证据请另立标签或走人工流程。 */
export function upsertGalleryLabel(db, { itemId, field, value, confidence = null, evidenceLevel = 'inferred', evidence = null, reviewState = 'needs_review', linkedNodeId = null }) {
  if (!GALLERY_LABEL_FIELDS.includes(field)) throw new Error(`upsertGalleryLabel: 非法 field ${field}`);
  if (!['source_exact', 'parser_derived', 'inferred'].includes(evidenceLevel)) throw new Error(`upsertGalleryLabel: 非法 evidence_level ${evidenceLevel}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO gallery_labels (item_id, field, value, confidence, evidence_level, evidence, review_state, linked_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, field, value) DO UPDATE SET
        confidence = CASE WHEN gallery_labels.review_state IN ('approved','rejected')
                          THEN gallery_labels.confidence ELSE excluded.confidence END,
        evidence_level = CASE WHEN gallery_labels.review_state IN ('approved','rejected')
                              THEN gallery_labels.evidence_level ELSE excluded.evidence_level END,
        evidence = CASE WHEN gallery_labels.review_state IN ('approved','rejected')
                        THEN gallery_labels.evidence ELSE excluded.evidence END,
        review_state = CASE WHEN gallery_labels.review_state IN ('approved','rejected')
                            THEN gallery_labels.review_state ELSE excluded.review_state END,
        linked_node_id = CASE WHEN gallery_labels.review_state IN ('approved','rejected')
                              THEN gallery_labels.linked_node_id ELSE excluded.linked_node_id END
    `).run(itemId, field, value, confidence, evidenceLevel, json(evidence, null), reviewState, linkedNodeId);
    return db.prepare('SELECT id FROM gallery_labels WHERE item_id = ? AND field = ? AND value = ?').get(itemId, field, value).id;
  });
}

/** 幂等注册提示词模板（按 template_id upsert；版本变更即覆盖当前指针，历史靠迁移/日志追溯）。 */
export function upsertPromptTemplate(db, { templateId, version, targetClass, body, schemaRef = null, status = 'draft' }) {
  if (!templateId || !version || !body) throw new Error('upsertPromptTemplate: templateId/version/body 必填');
  if (!GALLERY_SOURCE_CLASSES.includes(targetClass)) throw new Error(`upsertPromptTemplate: 非法 target_class ${targetClass}`);
  if (!PROMPT_TEMPLATE_STATUSES.includes(status)) throw new Error(`upsertPromptTemplate: 非法 status ${status}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO prompt_templates (template_id, version, target_class, body, schema_ref, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id) DO UPDATE SET
        version = excluded.version,
        target_class = excluded.target_class,
        body = excluded.body,
        schema_ref = excluded.schema_ref,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(templateId, version, targetClass, body, schemaRef, status);
    return db.prepare('SELECT * FROM prompt_templates WHERE template_id = ?').get(templateId);
  });
}

/** 图库快照：按 source_class 汇总条目数与标签覆盖（流水线报告用）。 */
export function gallerySnapshot(db) {
  const items = db.prepare(`
    SELECT source_class AS sourceClass, review_state AS reviewState, COUNT(*) AS count
    FROM gallery_items GROUP BY source_class, review_state ORDER BY source_class
  `).all();
  const labels = db.prepare(`
    SELECT field, COUNT(*) AS count, SUM(CASE WHEN linked_node_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
    FROM gallery_labels GROUP BY field ORDER BY field
  `).all();
  const templates = db.prepare(`
    SELECT template_id AS templateId, version, target_class AS targetClass, status
    FROM prompt_templates ORDER BY template_id
  `).all();
  return { items, labels, templates };
}

// ---------------------------------------------------------------- motion knowledge（v3 动作知识域）

export const MOTION_ASSET_TYPES = ['image', 'archive', 'video', 'gif'];
export const MOTION_STATUSES = ['draft', 'analyzing', 'planned', 'validated', 'rejected', 'deprecated'];
export const ACTION_STEP_KINDS = ['expression', 'motion', 'pose', 'look', 'keyframes'];
export const EXECUTION_STATUSES = ['completed', 'interrupted', 'rejected', 'failed', 'timeout'];
export const LEARNING_JOB_STATES = ['uploaded', 'extracted', 'analyzed', 'planned', 'validated', 'persisted', 'failed'];

/** 幂等登记动作素材（按 source_type + content_hash 唯一，重复导入=返回已有行）。 */
export function upsertMotionAsset(db, { id, sourceType, originalPath, contentHash, archivePath = null, metadata = null, importedAt = null }) {
  if (!MOTION_ASSET_TYPES.includes(sourceType)) throw new Error(`upsertMotionAsset: 非法 source_type ${sourceType}`);
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM motion_assets WHERE source_type = ? AND content_hash = ?').get(sourceType, contentHash);
    if (existing) return existing;
    db.prepare(`
      INSERT INTO motion_assets (id, source_type, original_path, archive_path, content_hash, imported_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceType, originalPath, archivePath, contentHash, importedAt ?? nowIso(), json(metadata, null));
    return db.prepare('SELECT * FROM motion_assets WHERE id = ?').get(id);
  });
}

/** 幂等写动作分析结果（按 id upsert；analysis 为结构化 JSON，含帧时序与审核状态）。 */
export function upsertMotionAnalysis(db, { id, assetId, modelName, analysis, confidence = null, createdAt = null }) {
  if (!assetId || !modelName) throw new Error('upsertMotionAnalysis: assetId/modelName 必填');
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO motion_analysis (id, asset_id, model_name, analysis_json, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        asset_id = excluded.asset_id,
        model_name = excluded.model_name,
        analysis_json = excluded.analysis_json,
        confidence = excluded.confidence
    `).run(id, assetId, modelName, json(analysis, '{}'), confidence, createdAt ?? nowIso());
    return db.prepare('SELECT * FROM motion_analysis WHERE id = ?').get(id);
  });
}

/** 幂等登记动作定义（按 id upsert）。
 * @deprecated 兼容层原语：status 不设限，可绕过 actions-repo 的 MOTION_TRANSITIONS 状态机（GLM 验收 WARN-1）。
 * 新代码一律使用 actions-repo 的 createActionChain / transitionActionChainStatus；本接口仅限既有测试/内部调用，待 Phase 3 收敛移除。 */
export function upsertMotionDefinition(db, { id, semanticKey, description, emotion = null, expression = null, gaze = null, bodyLanguage = null, version = 1, status = 'draft', createdAt = null }) {
  if (!MOTION_STATUSES.includes(status)) throw new Error(`upsertMotionDefinition: 非法 status ${status}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO motion_definitions (id, semantic_key, description, emotion, expression, gaze, body_language, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        semantic_key = excluded.semantic_key,
        description = excluded.description,
        emotion = excluded.emotion,
        expression = excluded.expression,
        gaze = excluded.gaze,
        body_language = excluded.body_language,
        version = excluded.version,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(id, semanticKey, description, emotion, expression, gaze, bodyLanguage, version, status,
      createdAt ?? nowIso(), nowIso());
    return db.prepare('SELECT * FROM motion_definitions WHERE id = ?').get(id);
  });
}

/**
 * 幂等写动作链（按 chain id）+ 步骤整体替换（同链重写=删旧插新，事务内一致）。
 * R8 版本不可变（PHASE-2-GAP P0-A 必修）：已存在同 id 链时，
 *  - chain_json 内容不同 → 拒绝覆盖（抛错），修订必须走 actions-repo 的版本 API；
 *  - chain_json 内容相同 → 幂等返回，仅允许同步 validation_report。
 */
export function upsertActionChain(db, { chainId, motionId, chain, schemaVersion, validationReport = null, steps = [], createdAt = null }) {
  if (!chainId || !motionId) throw new Error('upsertActionChain: chainId 与 motionId 必填');
  for (const s of steps) {
    if (!ACTION_STEP_KINDS.includes(s.kind)) throw new Error(`upsertActionChain: 非法 step kind ${s.kind}`);
  }
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM action_chains WHERE id = ?').get(chainId);
    const nextJson = json(chain, '{}');
    if (existing && existing.chain_json !== nextJson) {
      throw new Error(`upsertActionChain: 禁止覆盖已有版本 chain_json（R8 版本不可变），chainId=${chainId}；内容修订请使用 actions-repo createActionChainVersion`);
    }
    if (!existing) {
      db.prepare(`
        INSERT INTO action_chains (id, motion_id, chain_json, schema_version, validation_report, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(chainId, motionId, nextJson, schemaVersion, validationReport, createdAt ?? nowIso());
    } else if (validationReport !== null && validationReport !== existing.validation_report) {
      db.prepare('UPDATE action_chains SET validation_report = ? WHERE id = ?').run(validationReport, chainId);
    }
    db.prepare('DELETE FROM action_steps WHERE chain_id = ?').run(chainId);
    steps.forEach((s, i) => {
      db.prepare(`
        INSERT INTO action_steps (id, chain_id, step_index, kind, params_json, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(s.id ?? `${chainId}#${i}`, chainId, s.stepIndex ?? i, s.kind, json(s.params, '{}'), s.durationMs ?? null);
    });
    return db.prepare('SELECT COUNT(*) AS n FROM action_steps WHERE chain_id = ?').get(chainId).n;
  });
}

/** 幂等写动作↔模型适配（按 motion_id + model_id upsert）。 */
export function upsertMotionBinding(db, { motionId, modelId, adapter = null, compatible = 1, verifiedAt = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO motion_model_bindings (motion_id, model_id, adapter_json, compatible, verified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(motion_id, model_id) DO UPDATE SET
        adapter_json = excluded.adapter_json,
        compatible = excluded.compatible,
        verified_at = excluded.verified_at
    `).run(motionId, modelId, json(adapter, null), compatible ? 1 : 0, verifiedAt ?? nowIso());
  });
}

/** 追加执行历史（只追加）。 */
export function recordExecution(db, { execId, motionId, modelId, status, request = null, result = null, startedAt = null, finishedAt = null }) {
  if (!EXECUTION_STATUSES.includes(status)) throw new Error(`recordExecution: 非法 status ${status}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO execution_history (id, motion_id, model_id, status, request_json, result_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(execId, motionId, modelId, status, json(request, null), json(result, null), startedAt ?? nowIso(), finishedAt);
  });
}

/** 学习任务状态机推进（按 id upsert；state 枚举受 CHECK 约束）。
 * @deprecated 兼容层原语：可绕过 actions-repo 的学习任务推进路径（GLM 验收 WARN-1），新代码经 Repository 语义层写入。 */
export function upsertLearningJob(db, { id, sourceId, modelCapabilityId, state = 'uploaded', assetPaths = null, currentStep = null, error = null }) {
  if (!LEARNING_JOB_STATES.includes(state)) throw new Error(`upsertLearningJob: 非法 state ${state}`);
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO learning_jobs (id, source_id, model_capability_id, state, asset_paths_json, current_step, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        asset_paths_json = excluded.asset_paths_json,
        current_step = excluded.current_step,
        error_json = excluded.error_json,
        updated_at = excluded.updated_at
    `).run(id, sourceId, modelCapabilityId, state, json(assetPaths, null), currentStep, json(error, null), nowIso(), nowIso());
    return db.prepare('SELECT * FROM learning_jobs WHERE id = ?').get(id);
  });
}
