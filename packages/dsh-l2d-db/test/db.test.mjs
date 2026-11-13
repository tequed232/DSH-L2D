/**
 * dsh-l2d-db 测试：迁移幂等 / 幂等注册 / 外键级联 / 约束拒绝 / 事务回滚。
 * 运行：node --experimental-sqlite packages/dsh-l2d-db/test/db.test.mjs
 * （Node 22.22 实测免旗标亦可用。）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, withTransaction } from '../src/db.mjs';
import {
  upsertSkill, upsertWorkspace, upsertToolchainComponent, toolchainSnapshot,
  recordStartupCheck, startupReport, createTask, updateTaskStatus, getTask,
  upsertModel, upsertSourceFile, upsertNode, upsertEdge, upsertParameter,
  createAnalysisJob, finishAnalysisJob, saveCapabilityProfile, addValidationFinding,
  upsertGalleryItem, upsertGalleryLabel, upsertPromptTemplate, gallerySnapshot,
  upsertMotionAsset, upsertMotionDefinition, upsertActionChain, upsertMotionBinding,
  recordExecution, upsertLearningJob,
} from '../src/repo.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-db-'));
const dbFile = path.join(tmp, 'bootstrap-state.sqlite');
const db = openDb({ path: dbFile });

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  [OK] ${name}`);
}

// ---- 1. 迁移幂等：重复打开不重复执行、不报错
test('migrations are idempotent across reopen', () => {
  const again = openDb({ path: dbFile });
  const rows = again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(rows.n, 11); // … / v9 observer_dispatch_log（Supervisor P12） / v10 gallery_scores / v11 action_session_id（双会话 PR-1）
  const tables = again.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('skills','workspaces','toolchain_components','startup_checks','tasks','models','nodes','edges','parameters','parameter_bindings','semantic_labels','motions','physics_groups','analysis_jobs','probe_runs','capability_profiles','validation_findings','gallery_items','gallery_labels','prompt_templates','motion_assets','motion_analysis','motion_definitions','action_chains','action_steps','motion_sources','model_capabilities','motion_model_bindings','execution_history','learning_jobs')",
  ).get();
  assert.equal(tables.n, 30);
});

// ---- 2. Skill 幂等：同 name upsert = 更新
test('skill upsert updates instead of duplicating', () => {
  upsertSkill(db, { name: 'dsh-l2d-model-intelligence', version: '2.1.0', status: 'registered', contentHash: '14d08a35' });
  upsertSkill(db, { name: 'dsh-l2d-model-intelligence', version: '2.1.0', status: 'loaded', contentHash: '14d08a35' });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM skills').get();
  assert.equal(rows.n, 1);
  assert.equal(db.prepare('SELECT status FROM skills').get().status, 'loaded');
});

// ---- 3. 非法 Skill 状态被 CHECK 拒绝
test('invalid skill status is rejected', () => {
  assert.throws(() => upsertSkill(db, { name: 'x', version: '1', status: 'fake-loaded' }));
});

// ---- 4. 工作区幂等：ID 轮换后仍单行（恢复语义）
test('workspace upsert keeps one row per role across id rotation', () => {
  upsertWorkspace(db, { role: 'orchestrator', workspaceId: 'ws-1', title: 'DSH-L2D · Orchestrator', directory: '/d/w1', systemPromptVersion: '1.0.0', skillBindings: ['dsh-l2d-orchestrator'] });
  upsertWorkspace(db, { role: 'orchestrator', workspaceId: 'ws-2', title: 'DSH-L2D · Orchestrator', directory: '/d/w1', systemPromptVersion: '1.0.1' });
  const rows = db.prepare("SELECT * FROM workspaces WHERE role='orchestrator'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, 'ws-2');
});

// ---- 5. 工具链幂等 + 快照
test('toolchain upsert + snapshot', () => {
  upsertToolchainComponent(db, { name: 'py-moc3', kind: 'parser', version: 'main@abc123', sourceUrl: 'https://github.com/Ludentes/py-moc3', status: 'present_verified' });
  upsertToolchainComponent(db, { name: 'py-moc3', kind: 'parser', version: 'main@abc123', status: 'present_unverified', smokeTest: { ok: false } });
  const snap = toolchainSnapshot(db);
  assert.equal(snap.filter((c) => c.name === 'py-moc3').length, 1);
  assert.equal(snap[0].status, 'present_unverified');
  assert.deepEqual(snap[0].smokeTest, { ok: false });
});

// ---- 6. 启动检查：追加 + Bootstrap Report 聚合取最新 + gate 提取
test('startup report aggregates latest per component and extracts gate', () => {
  const run = 'run-1';
  recordStartupCheck(db, { runId: run, component: 'skill:dsh-l2d-model-intelligence', phase: 'p1', status: 'pass' });
  recordStartupCheck(db, { runId: run, component: 'toolchain:python', phase: 'p1', status: 'warn', detail: { version: '3.13' } });
  recordStartupCheck(db, { runId: run, component: 'gate', phase: 'gate', status: 'pass', gate: 'READY' });
  const report = startupReport(db, run);
  assert.equal(report.components.length, 3);
  assert.equal(report.gate, 'READY');
});

// ---- 7. 任务协议：创建/更新/证据/非法状态
test('task lifecycle with evidence and invalid status rejection', () => {
  createTask(db, { taskId: 't-1', title: '解析 MOC3', assignedWorkspace: 'model-inspector', assignedSkill: 'dsh-l2d-model-intelligence', modelId: 'm-1', inputArtifacts: ['a.moc3'] });
  updateTaskStatus(db, 't-1', 'running');
  updateTaskStatus(db, 't-1', 'done', { evidence: { report: 'r1' } });
  const task = getTask(db, 't-1');
  assert.equal(task.status, 'done');
  assert.deepEqual(task.evidence, { report: 'r1' });
  assert.throws(() => updateTaskStatus(db, 't-1', 'flying'));
  assert.throws(() => updateTaskStatus(db, 'nope', 'done'));
});

// ---- 8. 模型域：级联删除 + 唯一约束 + 幂等 upsert
test('model domain cascade + uniqueness + idempotency', () => {
  upsertModel(db, { modelId: 'm-1', sourcePath: 'DeepSeek免费公皮/DeepSeek/大肥鱼.moc3', packageHash: 'a'.repeat(64), status: 'imported' });
  upsertModel(db, { modelId: 'm-1', sourcePath: 'DeepSeek免费公皮/DeepSeek/大肥鱼.moc3', packageHash: 'a'.repeat(64), status: 'analyzed' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM models').get().n, 1);
  assert.throws(() => upsertModel(db, { modelId: 'm-2', sourcePath: 'x', packageHash: 'a'.repeat(64) })); // 同包同 hash 唯一

  const sf = upsertSourceFile(db, { modelId: 'm-1', relativePath: '大肥鱼.moc3', sha256: 'b'.repeat(64), sizeBytes: 1024, format: 'moc3' });
  upsertSourceFile(db, { modelId: 'm-1', relativePath: '大肥鱼.moc3', sha256: 'b'.repeat(64) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_files').get().n, 1);

  const modelNode = upsertNode(db, { modelId: 'm-1', nodeKey: 'model:root', nodeType: 'Model' });
  const p1 = upsertNode(db, { modelId: 'm-1', nodeKey: 'param:ParamAngleX', nodeType: 'Parameter', evidenceLevel: 'source_exact', parserName: 'py-moc3', parserVersion: 'test' });
  upsertNode(db, { modelId: 'm-1', nodeKey: 'param:ParamAngleX', nodeType: 'Parameter' }); // 幂等
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 2);

  upsertEdge(db, { modelId: 'm-1', srcId: modelNode, dstId: p1, edgeType: 'contains', evidenceLevel: 'source_exact' });
  upsertEdge(db, { modelId: 'm-1', srcId: modelNode, dstId: p1, edgeType: 'contains' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges').get().n, 1);

  const pid = upsertParameter(db, { modelId: 'm-1', paramId: 'ParamAngleX', name: '角度 X', minValue: -30, maxValue: 30, defaultValue: 0, nodeId: p1 });
  assert.ok(pid);

  createAnalysisJob(db, { analysisJobId: 'job-1', modelId: 'm-1', toolVersions: { 'py-moc3': 'test' } });
  assert.throws(() => createAnalysisJob(db, { analysisJobId: 'job-1', modelId: 'm-1' })); // 同 id 不重复
  finishAnalysisJob(db, 'job-1', 'done', 'smoke ok');
  assert.throws(() => finishAnalysisJob(db, 'job-1', 'running'));

  saveCapabilityProfile(db, { modelId: 'm-1', version: '1', profile: { gestures: ['wave'] } });
  saveCapabilityProfile(db, { modelId: 'm-1', version: '1', profile: { gestures: ['wave', 'nod'] } });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capability_profiles').get().n, 1);

  addValidationFinding(db, { modelId: 'm-1', severity: 'warn', code: 'missing_ref', message: 'x.png 悬空引用' });

  // 级联：删模型 → nodes/edges/parameters/jobs 全清
  db.prepare('DELETE FROM models WHERE model_id = ?').run('m-1');
  for (const table of ['source_files', 'nodes', 'edges', 'parameters', 'analysis_jobs', 'capability_profiles', 'validation_findings']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

// ---- 9. 外键强制：悬空引用必须失败（foreign_keys=ON）
test('foreign keys are enforced', () => {
  upsertModel(db, { modelId: 'm-9', sourcePath: 'x.moc3', packageHash: 'c'.repeat(64) });
  assert.throws(() => {
    db.prepare("INSERT INTO edges (model_id, src_id, dst_id, edge_type) VALUES ('m-9', 999999, 999998, 'contains')").run();
  });
  // 非法 node_type 被拒
  assert.throws(() => upsertNode(db, { modelId: 'm-9', nodeKey: 'n1', nodeType: 'Bone' })); // Live2D 没有骨骼——绝不允许
  assert.throws(() => upsertNode(db, { modelId: 'm-9', nodeKey: 'n2', nodeType: 'ArtMesh', evidenceLevel: 'made_up' }));
});

// ---- 10. 事务回滚：fn 抛错不留半行
test('withTransaction rolls back on failure', () => {
  assert.throws(() => withTransaction(db, () => {
    upsertSkill(db, { name: 'tx-skill', version: '1', status: 'valid' });
    throw new Error('boom');
  }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM skills WHERE name='tx-skill'").get().n, 0);
});

// ---- 11. 图库条目：幂等 upsert + 非法枚举拒绝
test('gallery item upsert + enum rejection', () => {
  upsertGalleryItem(db, { fileName: 'dafeiyu-mature-character-sheet.png', realFormat: 'png', ext: 'png', width: 1080, height: 810, sizeBytes: 100, sha256: 'd'.repeat(64), sourceClass: 'character_sheet' });
  upsertGalleryItem(db, { fileName: 'dafeiyu-mature-character-sheet.png', realFormat: 'png', ext: 'png', width: 1080, height: 810, sizeBytes: 200, sha256: 'd'.repeat(64), sourceClass: 'character_sheet', reviewState: 'labeled' });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM gallery_items').get();
  assert.equal(rows.n, 1);
  assert.equal(db.prepare('SELECT review_state FROM gallery_items').get().review_state, 'labeled');
  assert.throws(() => upsertGalleryItem(db, { fileName: 'x', realFormat: 'png', ext: 'png', sourceClass: 'texture_atlas' }));
  assert.throws(() => upsertGalleryItem(db, { fileName: 'y', realFormat: 'png', ext: 'png', reviewState: 'done' }));
});

// ---- 12. 图库标签：字段/证据等级约束 + 与模型节点桥接（节点删除置 NULL）
test('gallery label constraints + node bridge with SET NULL', () => {
  upsertModel(db, { modelId: 'm-g', sourcePath: 'x.moc3', packageHash: 'e'.repeat(64) });
  const nodeId = upsertNode(db, { modelId: 'm-g', nodeKey: 'part:tail', nodeType: 'Part' });
  const item = db.prepare("SELECT id FROM gallery_items WHERE file_name='dafeiyu-mature-character-sheet.png'").get();
  const labelId = upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'whale_tail', confidence: 0.98, evidenceLevel: 'source_exact', evidence: { view: '三视图侧/背面' }, linkedNodeId: nodeId });
  upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'whale_tail', confidence: 0.99, linkedNodeId: nodeId }); // 幂等（UPSERT 全量替换语义）
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gallery_labels').get().n, 1);
  assert.throws(() => upsertGalleryLabel(db, { itemId: item.id, field: 'shape', value: 'x' }));
  assert.throws(() => upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'y', evidenceLevel: 'guessed' }));
  assert.throws(() => upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'z', confidence: 1.5 }));
  // 桥接：删模型节点后标签存活、linked_node_id 置 NULL
  assert.equal(db.prepare('SELECT linked_node_id FROM gallery_labels WHERE id = ?').get(labelId).linked_node_id, nodeId);
  db.prepare("DELETE FROM nodes WHERE model_id='m-g'").run();
  assert.equal(db.prepare('SELECT linked_node_id FROM gallery_labels WHERE id = ?').get(labelId).linked_node_id, null);
});

// ---- 13. 提示词模板：幂等注册 + 快照汇总
test('prompt template upsert + gallery snapshot', () => {
  upsertPromptTemplate(db, { templateId: 'gallery-character-sheet-v1', version: '1.0.0', targetClass: 'character_sheet', body: 'You are labeling...', schemaRef: 'tools/gallery-schema/semantic-label.schema.json', status: 'active' });
  upsertPromptTemplate(db, { templateId: 'gallery-character-sheet-v1', version: '1.1.0', targetClass: 'character_sheet', body: 'improved', status: 'active' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_templates').get().n, 1);
  assert.equal(db.prepare("SELECT version FROM prompt_templates WHERE template_id='gallery-character-sheet-v1'").get().version, '1.1.0');
  assert.throws(() => upsertPromptTemplate(db, { templateId: 't2', version: '1', targetClass: 'sticker', body: 'x' }));
  const snap = gallerySnapshot(db);
  assert.equal(snap.templates.length, 1);
  assert.ok(snap.items.some((r) => r.sourceClass === 'character_sheet'));
  assert.ok(snap.labels.some((r) => r.field === 'part' && r.linked === 0));
});

// ---- 14. 动作知识域：素材去重 / 链+步骤替换 / 绑定 / 执行历史 / 学习状态机 / 级联
test('motion knowledge domain lifecycle', () => {
  // 素材：同 source_type+hash 去重
  upsertMotionAsset(db, { id: 'asset-1', sourceType: 'gif', originalPath: '/g/wave.gif', contentHash: 'f'.repeat(64) });
  const dup = upsertMotionAsset(db, { id: 'asset-2', sourceType: 'gif', originalPath: '/g/other.gif', contentHash: 'f'.repeat(64) });
  assert.equal(dup.id, 'asset-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM motion_assets').get().n, 1);
  assert.throws(() => upsertMotionAsset(db, { id: 'asset-3', sourceType: 'hologram', originalPath: 'x', contentHash: '1' }));

  // 定义 + 状态枚举
  upsertMotionDefinition(db, { id: 'mot-1', semanticKey: 'greet.wave', description: '挥手打招呼', emotion: 'friendly', status: 'draft' });
  upsertMotionDefinition(db, { id: 'mot-1', semanticKey: 'greet.wave', description: '挥手打招呼', status: 'validated', version: 2 });
  assert.equal(db.prepare('SELECT status FROM motion_definitions WHERE id=?').get('mot-1').status, 'validated');
  assert.throws(() => upsertMotionDefinition(db, { id: 'mot-x', semanticKey: 's', description: 'd', status: 'flying' }));

  // 链 + 步骤：R8 版本不可变——同 id 内容不同=拒绝覆盖；同内容=幂等
  const n1 = upsertActionChain(db, { chainId: 'chain-1', motionId: 'mot-1', chain: { steps: 2 }, schemaVersion: '1.0.0', steps: [
    { id: 's1', kind: 'expression', params: { name: 'smile' }, durationMs: 300 },
    { id: 's2', kind: 'motion', params: { semantic: 'wave_hand' }, durationMs: 900 },
  ] });
  assert.equal(n1, 2);
  assert.throws(() => upsertActionChain(db, { chainId: 'chain-1', motionId: 'mot-1', chain: { steps: 1 }, schemaVersion: '1.0.0', steps: [
    { kind: 'keyframes', params: { track: 'semantic_track' } },
  ] }), /禁止覆盖已有版本 chain_json/); // R8：修订必须走 actions-repo 版本 API
  const n2 = upsertActionChain(db, { chainId: 'chain-1', motionId: 'mot-1', chain: { steps: 2 }, schemaVersion: '1.0.0', steps: [
    { id: 's1', kind: 'expression', params: { name: 'smile' }, durationMs: 300 },
    { id: 's2', kind: 'motion', params: { semantic: 'wave_hand' }, durationMs: 900 },
  ] });
  assert.equal(n2, 2); // 同内容幂等
  assert.throws(() => upsertActionChain(db, { chainId: 'c2', motionId: 'mot-1', chain: {}, schemaVersion: '1', steps: [{ kind: 'bone', params: {} }] })); // Live2D 无骨骼

  // 绑定 + 执行历史 + 学习状态机
  upsertMotionBinding(db, { motionId: 'mot-1', modelId: 'm-9', adapter: { param: 'ParamAngleZ' }, compatible: 1 });
  upsertMotionBinding(db, { motionId: 'mot-1', modelId: 'm-9', adapter: { param: 'ParamAngleY' } });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM motion_model_bindings').get().n, 1);
  recordExecution(db, { execId: 'exec-1', motionId: 'mot-1', modelId: 'm-9', status: 'completed', result: { ok: true } });
  assert.throws(() => recordExecution(db, { execId: 'exec-2', motionId: 'mot-1', modelId: 'm-9', status: 'crashed' }));
  upsertLearningJob(db, { id: 'job-1', sourceId: 'asset-1', modelCapabilityId: 'cap-1', state: 'uploaded' });
  upsertLearningJob(db, { id: 'job-1', sourceId: 'asset-1', modelCapabilityId: 'cap-1', state: 'analyzed', currentStep: 'plan' });
  assert.equal(db.prepare('SELECT state FROM learning_jobs WHERE id=?').get('job-1').state, 'analyzed');
  assert.throws(() => upsertLearningJob(db, { id: 'job-2', sourceId: 'x', modelCapabilityId: 'y', state: 'teleported' }));

  // 级联：删动作定义 → 链/步骤/绑定/执行历史/来源全清
  db.prepare("DELETE FROM motion_definitions WHERE id='mot-1'").run();
  for (const t of ['action_chains', 'action_steps', 'motion_model_bindings', 'execution_history']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

// ---- 独立验收修复回归（2026-11-04 P1 审查）----

// ---- 11. 审核闸门：已裁决 gallery 行不可被 Repository 写路径覆写
test('review gate: approved/rejected labels and items are immutable via repo upserts', () => {
  const item = upsertGalleryItem(db, { fileName: 'gate-test.png', realFormat: 'png', ext: 'png', sourceClass: 'fan_art' });
  const labelId = upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'tail', confidence: 0.6, reviewState: 'needs_review' });

  // 人工裁决 approved（模拟 review.mjs 唯一入口）
  db.prepare("UPDATE gallery_labels SET review_state='approved', evidence='{\"review\":{\"decision\":\"approved\"}}' WHERE id=?").run(labelId);

  // 恶意/疏忽 upsert：同键再来一次 needs_review + 不同证据
  const sameId = upsertGalleryLabel(db, { itemId: item.id, field: 'part', value: 'tail', confidence: 0.99, evidenceLevel: 'source_exact', evidence: { hacked: true }, reviewState: 'needs_review' });
  assert.equal(sameId, labelId);
  const row = db.prepare('SELECT * FROM gallery_labels WHERE id=?').get(labelId);
  assert.equal(row.review_state, 'approved', 'review_state 不可被覆写');
  assert.equal(row.confidence, 0.6, '已裁决标签的数据字段同样冻结');
  assert.ok(!String(row.evidence).includes('hacked'), '已裁决标签的 evidence 不可被覆写');

  // item 级：裁决后 review_state 不可被 upsert 覆写（数据字段仍可更新）
  db.prepare("UPDATE gallery_items SET review_state='approved' WHERE id=?").run(item.id);
  upsertGalleryItem(db, { fileName: 'gate-test.png', realFormat: 'png', ext: 'png', sourceClass: 'photo', reviewState: 'pending' });
  const it = db.prepare('SELECT * FROM gallery_items WHERE id=?').get(item.id);
  assert.equal(it.review_state, 'approved', 'item review_state 不可被覆写');
  assert.equal(it.source_class, 'photo', 'item 数据字段允许正常更新');

  // rejected 同样冻结
  const l2 = upsertGalleryLabel(db, { itemId: item.id, field: 'pose', value: 'sit', reviewState: 'needs_review' });
  db.prepare("UPDATE gallery_labels SET review_state='rejected' WHERE id=?").run(l2);
  upsertGalleryLabel(db, { itemId: item.id, field: 'pose', value: 'sit', reviewState: 'needs_review' });
  assert.equal(db.prepare('SELECT review_state FROM gallery_labels WHERE id=?').get(l2).review_state, 'rejected');
});

// ---- 12. runtime_verified 闸门：无探针证据不得自封状态
test('runtime_verified gate: requires runtimeEvidence probe record', () => {
  upsertModel(db, { modelId: 'm-rt', sourcePath: 'x.moc3', packageHash: 'd'.repeat(64), status: 'analyzed' });
  // 无证据 → 拒绝
  assert.throws(() => upsertModel(db, { modelId: 'm-rt', sourcePath: 'x.moc3', packageHash: 'd'.repeat(64), status: 'runtime_verified' }),
    /runtimeEvidence/);
  // 静态管道状态正常流转不受影响
  upsertModel(db, { modelId: 'm-rt', sourcePath: 'x.moc3', packageHash: 'd'.repeat(64), status: 'analyzed' });
  // 带证据 → 允许 + 留痕
  upsertModel(db, { modelId: 'm-rt', sourcePath: 'x.moc3', packageHash: 'd'.repeat(64), status: 'runtime_verified',
    runtimeEvidence: { probeRun: 'probe-run-42', probedBy: 'runtime-probe@0.1.0', verifiedAt: '2026-11-04T00:00:00Z' } });
  assert.equal(db.prepare('SELECT status FROM models WHERE model_id=?').get('m-rt').status, 'runtime_verified');
  const log = db.prepare("SELECT reason FROM motion_status_log WHERE motion_id='model:m-rt' AND to_status='runtime_verified'").get();
  assert.ok(log && log.reason.includes('probe-run-42'), 'runtime_verified 证据留痕');
});

// ---- 13. v5：range_evidence 证据列 + COALESCE 不回退语义
test('range_evidence column: evidence preserved on evidence-less writes', () => {
  const ev = { source: 'py-moc3@2fb112e', artifact: 'moc3-binary', verifiedAt: '2026-11-04T00:00:00Z' };
  upsertParameter(db, { modelId: 'm-9', paramId: 'P1', minValue: -1, maxValue: 1, rangeEvidence: ev });
  const withEv = db.prepare("SELECT min_value, max_value, range_evidence FROM parameters WHERE model_id='m-9' AND param_id='P1'").get();
  assert.equal(withEv.min_value, -1);
  assert.ok(withEv.range_evidence.includes('py-moc3'));
  // 无证据写入不抹除已有证据（COALESCE）
  upsertParameter(db, { modelId: 'm-9', paramId: 'P1', minValue: -2, maxValue: 2 });
  const after = db.prepare("SELECT min_value, range_evidence FROM parameters WHERE model_id='m-9' AND param_id='P1'").get();
  assert.equal(after.min_value, -2, '数据按 upsert 语义更新');
  assert.ok(after.range_evidence.includes('py-moc3'), '证据不被无证据写入抹除');
});

console.log(`\ndsh-l2d-db: ${passed} tests passed`);
try { db.close(); } catch { /* 重复关闭忽略 */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows WAL 句柄延迟释放，忽略 */ }
