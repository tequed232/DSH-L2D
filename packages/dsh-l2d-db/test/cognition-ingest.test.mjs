/**
 * cognition-ingest 测试：泛化模型认知入库（C-1）。
 *
 * 只打认知入库库本身（moc3 解析注入假实现：真实 py-moc3 子进程在 fixture 上不可用）：
 *   - 行数正确（sources/params/nodes/findings）；
 *   - 二次执行幂等（不重复增行，findings 去重）；
 *   - 证据纪律：default_value 一律 NULL，min/max 仅 w3-registry 有该模型记录时填；
 *   - cdi3/moc3 Part 与参数双向差集 findings；
 *   - 无 cdi3 → 降级 warnings 不抛；moc3 parse 失败 → 降级 warnings 不抛；
 *   - profileArtifact 入库（按 profileRevision 幂等）；
 *   - CLI 薄壳：--model-dir/--model-id/--db、--all-models、--verify。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { ingestModelCognition, readMoc3Version } from '../src/cognition-ingest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cognition-'));
}
function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const MODEL3 = {
  Version: 3,
  FileReferences: { Moc: 'fx.moc3', Physics: 'fx.physics3.json', Textures: ['tex/tex00.png'] },
};
const CDI3 = {
  Version: 3,
  Parameters: [
    { Id: 'ParamAngleX', Name: '角度X', GroupId: 'ParamGroup8' },
    { Id: 'ParamMouthOpenY', Name: '嘴张开', GroupId: 'ParamGroup1' },
  ],
  Parts: [
    { Id: 'PartHead', Name: '头' },
    { Id: 'PartCdiOnly', Name: '仅cdi的Part' },
  ],
};
const MOC3_FACTS = {
  parameter_ids: ['ParamAngleX', 'ParamMouthOpenY', 'ParamMocOnly'],
  part_ids: ['PartHead', 'PartArmOnlyMoc'],
};

/** fixture 模型目录：model3 + cdi3 + fake moc3（MOC3 魔数 + 版本字节）+ physics3 + 贴图。 */
function makeModelDir({ withCdi = true } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fx.model3.json'), JSON.stringify(MODEL3));
  if (withCdi) fs.writeFileSync(path.join(dir, 'fx.cdi3.json'), JSON.stringify(CDI3));
  // 假 moc3：只满足版本读取（二进制事实来自注入的 parseMoc3）
  fs.writeFileSync(path.join(dir, 'fx.moc3'), Buffer.concat([Buffer.from('MOC3'), Buffer.from([5]), Buffer.from('FakeBodyBytes')]));
  fs.writeFileSync(path.join(dir, 'fx.physics3.json'), JSON.stringify({ PhysicsSettings: [] }));
  fs.mkdirSync(path.join(dir, 'tex'));
  fs.writeFileSync(path.join(dir, 'tex', 'tex00.png'), Buffer.from('PNGBYTES'));
  return dir;
}

function openTempDb() {
  const dir = tmp();
  const db = openDb({ path: path.join(dir, 'test.sqlite') });
  return { db, dir };
}
const countRows = (db, table, modelId) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE model_id = ?`).get(modelId).n);
const parseMoc3 = () => MOC3_FACTS;

// ---------------------------------------------------------------------------
// 1) 基本入库：行数正确 + 证据纪律（default_value NULL / min,max NULL）
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    const out = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.details.moc3Version, 'moc3-v5', 'moc3 版本从头部读出');
    // sources: model3 + cdi3 + moc3 + physics3 + tex = 5
    assert.equal(out.counts.sources, 5, '源文件清单 5 条');
    // params: cdi3 2 + moc3 独有 1
    assert.equal(out.counts.params, 3);
    // nodes: 3 params + 3 parts（cdi3 2 + moc3 独有 1）
    assert.equal(out.counts.nodes, 6);
    assert.equal(out.counts.findings, 3, '双向差集 3 条：cdi3 独有 Part / moc3 独有 Part / moc3 独有参数');
    assert.equal(countRows(db, 'source_files', 'fx'), 5);
    assert.equal(countRows(db, 'parameters', 'fx'), 3);
    assert.equal(countRows(db, 'nodes', 'fx'), 6);
    assert.equal(countRows(db, 'validation_findings', 'fx'), 3);
    // 证据纪律：没有任何来源提供 default_value / 范围（未 injection w3-registry）
    const params = db.prepare('SELECT * FROM parameters WHERE model_id = ? ORDER BY param_id').all('fx');
    for (const p of params) {
      assert.equal(p.default_value, null, 'default_value 一律 NULL（不伪造）');
      assert.equal(p.min_value, null, '无 w3 证据 → min NULL');
      assert.equal(p.max_value, null, '无 w3 证据 → max NULL');
    }
    // cdi3 参数的 display_name 来自 cdi3（source_exact）
    const head = db.prepare('SELECT * FROM nodes WHERE model_id = ? AND node_key = ?').get('fx', 'ParamAngleX');
    assert.equal(head.display_name, '角度X');
    assert.equal(head.evidence_level, 'source_exact');
    // moc3 独有 Part → parser_derived
    const mocOnly = db.prepare('SELECT * FROM nodes WHERE model_id = ? AND node_key = ?').get('fx', 'PartArmOnlyMoc');
    assert.equal(mocOnly.evidence_level, 'parser_derived');
    // findings 码集合
    const codes = db.prepare('SELECT code FROM validation_findings WHERE model_id = ? ORDER BY code').all('fx').map((r) => r.code);
    assert.deepEqual(codes, ['CDI3_PART_MISSING_IN_MOC3', 'MOC3_PARAM_MISSING_IN_CDI3', 'MOC3_PART_MISSING_IN_CDI3']);
    // models 行
    const model = db.prepare('SELECT * FROM models WHERE model_id = ?').get('fx');
    assert.equal(model.status, 'imported');
    assert.equal(model.moc3_version, 'moc3-v5');
    assert.equal(model.package_hash.length, 64, 'packageHash = model3.json 的 sha256');
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 2) 幂等：二次执行不增行（findings 追加表按 (code,message) 去重）
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    const first = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    const snapshot = {
      sources: countRows(db, 'source_files', 'fx'),
      params: countRows(db, 'parameters', 'fx'),
      nodes: countRows(db, 'nodes', 'fx'),
      findings: countRows(db, 'validation_findings', 'fx'),
    };
    const second = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    assert.equal(second.ok, true);
    assert.deepEqual(
      {
        sources: countRows(db, 'source_files', 'fx'),
        params: countRows(db, 'parameters', 'fx'),
        nodes: countRows(db, 'nodes', 'fx'),
        findings: countRows(db, 'validation_findings', 'fx'),
      },
      snapshot,
      '二次执行行数完全一致（幂等）',
    );
    assert.equal(first.counts.findings, 3);
    assert.equal(second.counts.findings, 0, '第二次不新增 findings');
    assert.equal(countRows(db, 'models', 'fx'), 1);
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 3) w3-registry 范围证据：仅该模型记录时填 min/max 并记 range_evidence
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    const w3Registry = {
      model: { id: 'fx', model3: 'fx.model3.json' },
      sourceCommit: 'deadbeefcafe',
      entries: [{ id: 'ctrl.mouth', controlledParams: [{ id: 'ParamAngleX', min: -30, max: 30 }] }],
    };
    const out = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3, w3Registry });
    assert.equal(out.details.paramsWithRange, 1, '只有有证据的参数填范围');
    const withRange = db.prepare('SELECT * FROM parameters WHERE model_id = ? AND param_id = ?').get('fx', 'ParamAngleX');
    assert.equal(withRange.min_value, -30);
    assert.equal(withRange.max_value, 30);
    assert.equal(withRange.default_value, null, 'default 仍 NULL');
    const ev = JSON.parse(withRange.range_evidence);
    assert.equal(ev.sourceCommit, 'deadbeefcafe', 'range_evidence 记提交锚点');
    const noRange = db.prepare('SELECT * FROM parameters WHERE model_id = ? AND param_id = ?').get('fx', 'ParamMouthOpenY');
    assert.equal(noRange.min_value, null, '无证据参数不填（不猜范围）');
    // 证据归属：w3 属于别的模型时一律不填
    const other = ingestModelCognition(db, {
      modelDir,
      modelId: 'fx',
      parseMoc3,
      w3Registry: { ...w3Registry, model: { id: 'other-model', model3: 'other.model3.json' } },
    });
    assert.equal(other.details.paramsWithRange, 0, 'w3 记录不属于该模型 → 不提供证据');
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 3b) 已有运行时证据不被重新入库抹掉（enrich-ranges 写入的 default/min/max 保留）
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    // 模拟后续 enrich-ranges 写入运行时实测证据
    db.prepare('UPDATE parameters SET default_value = 12.5, min_value = -12.5, max_value = 12.5 WHERE model_id = ? AND param_id = ?')
      .run('fx', 'ParamAngleX');
    ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    const row = db.prepare('SELECT * FROM parameters WHERE model_id = ? AND param_id = ?').get('fx', 'ParamAngleX');
    assert.equal(row.default_value, 12.5, '重新入库不得抹掉已有默认值证据');
    assert.equal(row.min_value, -12.5, '无 w3 证据时保留已有 min');
    assert.equal(row.max_value, 12.5, '无 w3 证据时保留已有 max');
    // 但 w3 有证据时以证据为准（证据优先级：w3-registry > 保留值）
    ingestModelCognition(db, {
      modelDir,
      modelId: 'fx',
      parseMoc3,
      w3Registry: { model: { id: 'fx' }, sourceCommit: 'c1', entries: [{ id: 'e', controlledParams: [{ id: 'ParamAngleX', min: -30, max: 30 }] }] },
    });
    const reRow = db.prepare('SELECT * FROM parameters WHERE model_id = ? AND param_id = ?').get('fx', 'ParamAngleX');
    assert.equal(reRow.min_value, -30, 'w3 证据覆盖保留值');
    assert.equal(reRow.max_value, 30);
    assert.equal(reRow.default_value, 12.5, 'default 仍保留（w3 不带 default）');
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 4) profileArtifact 入库（按 profileRevision 幂等）
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    const artifact = path.join(dir, 'profile.fx.json');
    fs.writeFileSync(artifact, JSON.stringify({ profileRevision: 'r-abc123', controls: [{ id: 'head.yaw', status: 'supported' }] }));
    const out = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3, profileArtifact: artifact });
    assert.equal(out.ok, true);
    const rows = db.prepare('SELECT * FROM capability_profiles WHERE model_id = ?').all('fx');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 'r-abc123', 'version 取 profileRevision');
    assert.equal(JSON.parse(rows[0].profile).modelId, 'fx');
    ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3, profileArtifact: artifact });
    assert.equal(countRows(db, 'capability_profiles', 'fx'), 1, '同 revision 二次入库仍 1 行');
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 5) 降级路径：无 cdi3 / moc3 parse 失败 → warnings 不抛
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir({ withCdi: false });
  const { db, dir } = openTempDb();
  try {
    const out = ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3 });
    assert.equal(out.ok, true, '无 cdi3 不阻塞');
    assert.ok(out.warnings.some((w) => w.startsWith('cdi3-missing')), 'warnings 说明 cdi3 缺失');
    assert.equal(out.counts.params, 3, '回退 moc3 参数事实');
    assert.equal(countRows(db, 'parameters', 'fx'), 3);
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}
{
  const modelDir = makeModelDir();
  const { db, dir } = openTempDb();
  try {
    const out = ingestModelCognition(db, {
      modelDir,
      modelId: 'fx',
      parseMoc3: () => {
        throw new Error('python 不存在');
      },
    });
    assert.equal(out.ok, true, 'moc3 parse 失败不阻塞');
    assert.ok(out.warnings.some((w) => w.startsWith('moc3-parse-failed')), 'warnings 说明 parse 失败');
    assert.equal(out.counts.params, 2, '仅 cdi3 参数');
    const codes = db.prepare('SELECT code, severity FROM validation_findings WHERE model_id = ?').all('fx');
    assert.ok(codes.some((r) => r.code === 'MOC3_PARSE_UNAVAILABLE' && r.severity === 'warn'), 'parse 失败入册 warning finding');
    // 二次执行不重复追加该 warning finding
    ingestModelCognition(db, { modelDir, modelId: 'fx', parseMoc3: () => {
      throw new Error('python 不存在');
    } });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM validation_findings WHERE model_id = ? AND code = 'MOC3_PARSE_UNAVAILABLE'").get('fx').n,
      1,
      'warning finding 幂等',
    );
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 6) 致命路径：model3 缺失 → ok:false（不写半份注册）
// ---------------------------------------------------------------------------
{
  const modelDir = tmp();
  const { db, dir } = openTempDb();
  try {
    const out = ingestModelCognition(db, { modelDir, modelId: 'nope', parseMoc3 });
    assert.equal(out.ok, false);
    assert.match(out.error, /model3\.json 不存在/);
    assert.equal(countRows(db, 'models', 'nope'), 0);
  } finally {
    db.close();
    clean(dir);
    clean(modelDir);
  }
}

// ---------------------------------------------------------------------------
// 7) readMoc3Version：非 MOC3 → 抛错（调用方降级为 warning）
// ---------------------------------------------------------------------------
{
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'bad.moc3'), Buffer.from('NOPE'));
    assert.throws(() => readMoc3Version(path.join(dir, 'bad.moc3')), /不是 MOC3 文件/);
  } finally {
    clean(dir);
  }
}

// ---------------------------------------------------------------------------
// 8) CLI 薄壳：单模型 / --all-models / --verify（真实子进程，不碰仓库默认库）
// ---------------------------------------------------------------------------
{
  const modelDir = makeModelDir();
  // 第二个模型（无引用资源 → 全降级）
  fs.writeFileSync(path.join(modelDir, 'fy.model3.json'), JSON.stringify({ FileReferences: {} }));
  const dbDir = tmp();
  const dbPath = path.join(dbDir, 'cli.sqlite');
  const script = path.join(ROOT, 'tools', 'model-registry', 'ingest.mjs');
  try {
    // 单模型：无 python 环境下 moc3 parse 会失败 → 降级不阻塞，退出码仍 0
    const single = execFileSync(process.execPath, [script, '--model-dir', modelDir, '--model-id', 'fy', '--db', dbPath], { encoding: 'utf8' });
    const report = JSON.parse(single);
    assert.equal(report.modelId, 'fy');
    assert.equal(report.ok, true, single);
    assert.ok(report.steps.some((s) => s.step === 'registered'));

    const all = execFileSync(process.execPath, [script, '--all-models', '--model-dir', modelDir, '--db', dbPath], { encoding: 'utf8' });
    const allReport = JSON.parse(all);
    assert.equal(allReport.ok, true, all);
    assert.equal(allReport.total, 2);
    assert.deepEqual(allReport.reports.map((r) => r.modelId).sort(), ['fx', 'fy']);

    const verified = execFileSync(process.execPath, [script, '--verify', '--model-id', 'fy', '--db', dbPath], { encoding: 'utf8' });
    const v = JSON.parse(verified);
    assert.equal(v.ok, true, verified);
    assert.equal(v.counts.paramsWithDefault, 0, 'verify 确认 default_value 全 NULL');
    assert.equal(v.model.status, 'imported');
  } finally {
    clean(dbDir);
    clean(modelDir);
  }
}

console.log('cognition-ingest tests passed');
