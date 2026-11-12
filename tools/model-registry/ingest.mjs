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
 *       # 递归扫描模型根下全部 *.model3.json 逐个入库（深度上限 6，跳过 node_modules/.git/
 *       # 隐藏目录；workshop 这类嵌套布局靠这条批量回填；同目录多变体各自一档，幂等）
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

/** --all-models 的扫描上限：目录深度 / 命中数量护栏（workshop 嵌套树实测 3 层足够）。 */
const ALL_MODELS_MAX_DEPTH = 6;
const ALL_MODELS_MAX_HITS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);

/** 递归找出 root 下全部 *.model3.json（跳过隐藏目录与依赖/版本库目录）。 */
function discoverModel3Files(root) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > ALL_MODELS_MAX_DEPTH || hits.length >= ALL_MODELS_MAX_HITS) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过，不阻塞其余模型
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
        walk(full, depth + 1);
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.model3.json')) {
        hits.push(full);
      }
    }
  };
  walk(root, 0);
  return hits.sort();
}

/** --all-models：递归扫模型根下全部 *.model3.json，逐个入库（单模型失败不影响其余）。
 *  每个命中的 modelId = 文件名去 .model3.json，modelDir = 该文件所在目录（cognition-ingest
 *  在这个目录里找 model3/cdi3/moc3——workshop 嵌套布局天然支持）。同目录多变体各自一档。 */
function allModels(db) {
  if (!fs.existsSync(MODEL_DIR)) {
    return { ok: false, error: '模型目录不存在：' + MODEL_DIR, modelDir: MODEL_DIR, total: 0, reports: [] };
  }
  const files = discoverModel3Files(MODEL_DIR);
  const reports = [];
  for (const file of files) {
    const modelId = path.basename(file).replace(/\.model3\.json$/i, '');
    const modelDir = path.dirname(file);
    try {
      const report = ingestOne(db, modelId, modelDir);
      // 相对模型根的定位信息：同目录多变体时靠它区分是哪一个档
      reports.push({ ...report, modelDir: path.relative(MODEL_DIR, modelDir).replace(/\\/g, '/') || '.' });
    } catch (err) {
      reports.push({
        modelId,
        modelDir: path.relative(MODEL_DIR, modelDir).replace(/\\/g, '/') || '.',
        ok: false,
        counts: null,
        warnings: [],
        error: String((err && err.message) || err),
      });
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
