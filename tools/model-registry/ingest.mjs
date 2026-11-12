#!/usr/bin/env node
/**
 * dsh-l2d · Model Nodes 注册导入器（薄 CLI：逻辑在 packages/dsh-l2d-db/src/cognition-ingest.mjs）
 *
 * 用法：
 *   node tools/model-registry/ingest.mjs
 *       # 默认行为（零参数回归旧版）：本仓库大肥鱼（大肥鱼.dsl2d）+ 默认库
 *   node tools/model-registry/ingest.mjs --model-dir <path> --model-id <id> [--db <path>]
 *       # 单模型入库（模型导入管线的 cognition 步走这条）
 *   node tools/model-registry/ingest.mjs --all-models [--model-dir <path>] [--db <path>]
 *       # 扫描模型根下全部 *.model3.json 逐个入库（幂等）
 *   node tools/model-registry/ingest.mjs --verify [--model-id <id>] [--db <path>]
 *       # 只读验收：打印该 modelId 在库里的行数（models/source_files/nodes/parameters/
 *       # capability_profiles/validation_findings），不写入
 *
 * 数据源与证据纪律见 cognition-ingest.mjs 头部注释（参数/Part 名称来自 cdi3 为
 * source_exact；min/max 仅 w3-registry 有该模型记录时填；default_value 新行写 NULL、
 * 已有的运行时实测值保留（不抹证据）；
 * cdi3/moc3 差集如实写 validation_findings；parse 失败降级不阻塞）。
 *
 * 语义标签（semantic_labels）不做自动推断——保留给人工/多模态标注流程。
 */
import fs from 'node:fs';
import path from 'node:path';

import { openDb, withTransaction } from '../../packages/dsh-l2d-db/src/db.mjs';
import { ingestModelCognition } from '../../packages/dsh-l2d-db/src/cognition-ingest.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULT_MODEL_DIR = path.join(REPO_ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const DEFAULT_MODEL_ID = '大肥鱼.dsl2d'; // 与 tools/w3-registry/registry.json model.id 保持一致

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes('--' + n);

const MODEL_DIR = path.resolve(argOf('model-dir', process.env.DSH_L2D_MODEL_DIR || DEFAULT_MODEL_DIR));
const DB_PATH = argOf('db', process.env.DSH_L2D_DB_PATH || undefined);
const MODEL_ID = argOf('model-id', DEFAULT_MODEL_ID);

function open() {
  return DB_PATH ? openDb({ path: DB_PATH }) : openDb({ startDir: REPO_ROOT });
}

/** 单模型入库 → 打印报告（结构兼容旧版：modelId + steps）。 */
function ingestOne(db, modelId, modelDir) {
  const out = ingestModelCognition(db, {
    modelDir,
    modelId,
    repoRoot: REPO_ROOT,
    status: 'imported',
    profileArtifact: resolveProfileArtifact(modelId),
  });
  const report = {
    modelId,
    ok: out.ok,
    counts: out.counts,
    warnings: out.warnings,
    steps: [],
  };
  if (out.details) {
    report.steps.push({
      step: 'facts',
      cdi3Params: out.details.cdi3ParamCount,
      cdi3Parts: out.details.cdi3PartCount,
      moc3Params: out.details.moc3ParamCount,
      moc3Parts: out.details.moc3PartCount,
      rangeEvidenceParams: out.details.paramsWithRange,
      cdi3OnlyParts: out.details.cdi3OnlyParts,
    });
    report.steps.push({
      step: 'registered',
      model: modelId,
      packageHash: String(out.details.packageHash || '').slice(0, 12),
      moc3Version: out.details.moc3Version,
      params: out.counts.params,
      paramsWithRange: out.details.paramsWithRange,
      parts: out.details.cdi3PartCount,
      sources: out.counts.sources,
      nodes: out.counts.nodes,
      findings: out.counts.findings,
    });
  }
  if (!out.ok) report.error = out.error;
  return report;
}

/** 能力画像产物（若已生成）：tools/capability-scan/profile.<modelId>.json。 */
function resolveProfileArtifact(modelId) {
  const file = path.join(REPO_ROOT, 'tools', 'capability-scan', 'profile.' + modelId + '.json');
  return fs.existsSync(file) ? file : null;
}

/** --all-models：扫模型根下全部 *.model3.json，逐个入库（单模型失败不影响其余）。 */
function allModels(db) {
  let files = [];
  try {
    files = fs.readdirSync(MODEL_DIR).filter((n) => n.toLowerCase().endsWith('.model3.json')).sort();
  } catch (err) {
    return { ok: false, error: '模型目录不可读：' + MODEL_DIR + '（' + String((err && err.message) || err) + '）' };
  }
  const reports = [];
  for (const file of files) {
    const modelId = file.replace(/\.model3\.json$/, '');
    try {
      reports.push(ingestOne(db, modelId, MODEL_DIR));
    } catch (err) {
      reports.push({ modelId, ok: false, counts: null, warnings: [], error: String((err && err.message) || err) });
    }
  }
  return { ok: reports.every((r) => r.ok), modelDir: MODEL_DIR, total: reports.length, reports };
}

/** --verify：只读打印该 modelId 在库里的行数（验收用）。 */
function verify(db, modelId) {
  return withTransaction(db, () => {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
    const model = db.prepare('SELECT model_id, title, status, moc3_version, package_hash FROM models WHERE model_id = ?').get(modelId);
    if (!model) return { ok: false, modelId, error: '该模型未入库：' + modelId };
    return {
      ok: true,
      modelId,
      model,
      counts: {
        sources: count('SELECT COUNT(*) AS n FROM source_files WHERE model_id = ?', modelId),
        nodes: count('SELECT COUNT(*) AS n FROM nodes WHERE model_id = ?', modelId),
        params: count('SELECT COUNT(*) AS n FROM parameters WHERE model_id = ?', modelId),
        paramsWithRange: count('SELECT COUNT(*) AS n FROM parameters WHERE model_id = ? AND min_value IS NOT NULL', modelId),
        paramsWithDefault: count('SELECT COUNT(*) AS n FROM parameters WHERE model_id = ? AND default_value IS NOT NULL', modelId),
        findings: count('SELECT COUNT(*) AS n FROM validation_findings WHERE model_id = ?', modelId),
        capabilityProfiles: count('SELECT COUNT(*) AS n FROM capability_profiles WHERE model_id = ?', modelId),
      },
    };
  });
}

function main() {
  const db = open();
  try {
    if (has('verify')) {
      const out = verify(db, MODEL_ID);
      console.log(JSON.stringify(out, null, 2));
      process.exitCode = out.ok ? 0 : 1;
      return;
    }
    if (has('all-models')) {
      const out = allModels(db);
      console.log(JSON.stringify(out, null, 2));
      process.exitCode = out.ok ? 0 : 1;
      return;
    }
    const report = ingestOne(db, MODEL_ID, MODEL_DIR);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

main();
