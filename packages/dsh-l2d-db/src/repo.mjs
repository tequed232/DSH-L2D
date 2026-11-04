/**
 * dsh-l2d · 注册表仓储层（幂等写入 + 校验）
 *
 * 原则（与 skills/dsh-l2d-model-intelligence 一致）：
 *  - 重复注册=更新，不产生重复行；
 *  - 推断数据（semantic_labels）与解析事实（nodes/edges）分表存放；
 *  - 所有写入在事务内；非法枚举由 CHECK 拒绝，不做静默兜底。
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

/** 幂等登记模型（按 model_id upsert；package_hash 唯一防同一包重复建档）。 */
export function upsertModel(db, { modelId, title = null, sourcePath, packageHash, moc3Version = null, status = 'imported' }) {
  if (!modelId || !sourcePath || !packageHash) throw new Error('upsertModel: modelId/sourcePath/packageHash 必填');
  return withTransaction(db, () => {
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
export function upsertParameter(db, { modelId, paramId, name = null, minValue = null, maxValue = null, defaultValue = null, nodeId = null }) {
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO parameters (model_id, param_id, name, min_value, max_value, default_value, node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id, param_id) DO UPDATE SET
        name = excluded.name, min_value = excluded.min_value, max_value = excluded.max_value,
        default_value = excluded.default_value, node_id = excluded.node_id
    `).run(modelId, paramId, name, minValue, maxValue, defaultValue, nodeId);
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
