#!/usr/bin/env node
/**
 * dsh-l2d · Model Nodes 注册导入器（P1-2：真实模型 → 统一注册表）
 *
 * 数据源（全部真实，禁伪造）：
 *  - DeepSeek免费公皮/DeepSeek/大肥鱼.cdi3.json —— 509 参数 Id/Name/GroupId + 148 Parts（source_exact 语义名）
 *  - DeepSeek免费公皮/DeepSeek/大肥鱼.moc3     —— 二进制结构事实（py-moc3 读路径 verified：509 param / 147 part）
 *  - tools/w3-registry/registry.json          —— 60 个受控参数的 min/max 范围证据（sourceCommit 锚定）
 *
 * 证据纪律：
 *  - 参数 ID 与显示名来自 cdi3（模型作者导出）→ evidence_level='source_exact'；
 *  - min/max 仅在 w3-registry 有记录时填写（evidence 记来源与提交锚点），其余 NULL——不伪造；
 *  - default_value：cdi3/moc3/w3-registry 均不含默认值，一律 NULL（缺失即缺失）；
 *  - cdi3 与 moc3 的 Part 集差异如实写 validation_findings（info）；
 *  - 语义标签（semantic_labels）不做自动推断，留给人工/多模态标注流程。
 *
 * 幂等：全链 upsert，重复执行=更新不重复。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { openDb, withTransaction } from '../../packages/dsh-l2d-db/src/db.mjs';
import {
  upsertModel, upsertSourceFile, upsertNode, upsertParameter, addValidationFinding,
} from '../../packages/dsh-l2d-db/src/repo.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const MODEL_DIR = path.join(REPO_ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const MOC3 = path.join(MODEL_DIR, '大肥鱼.moc3');
const CDI3 = path.join(MODEL_DIR, '大肥鱼.cdi3.json');
const MODEL3 = path.join(MODEL_DIR, '大肥鱼.dsl2d.model3.json');
const PHYSICS3 = path.join(MODEL_DIR, '大肥鱼.physics3.json');
const W3REGISTRY = path.join(REPO_ROOT, 'tools', 'w3-registry', 'registry.json');
const PY_MOC3_SRC = path.join(REPO_ROOT, 'vendor', 'thirdparty', 'py-moc3', 'src');

const MODEL_ID = '大肥鱼.dsl2d'; // 与 tools/w3-registry/registry.json model.id 保持一致
const PARSER = 'py-moc3+cdi3';

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** MOC3 头部版本：magic 'MOC3' 后第 5 字节为版本号（3/4/5…）。 */
function readMoc3Version(p) {
  const buf = fs.readFileSync(p);
  if (buf.subarray(0, 4).toString('ascii') !== 'MOC3') throw new Error(`${p} 不是 MOC3 文件`);
  return `moc3-v${buf[4]}`;
}

/** 调 py-moc3 读二进制结构事实（param_ids / part_ids），JSON 输出。 */
function readMoc3Facts(moc3Path) {
  const { execFileSync } = require('node:child_process');
  const script = [
    'import json, sys',
    'sys.path.insert(0, r\'' + PY_MOC3_SRC.replace(/\\/g, '\\\\') + '\')',
    'from moc3 import Moc3',
    'm = Moc3.from_file(sys.argv[1])',
    'print(json.dumps({"parameter_ids": m.parameter_ids, "part_ids": m.part_ids}))',
  ].join('\n');
  const out = execFileSync('python', ['-c', script, moc3Path], { encoding: 'utf8' });
  const line = out.split('\n').filter((l) => l.trim().startsWith('{')).join('');
  return JSON.parse(line);
}

function main() {
  const report = { modelId: MODEL_ID, steps: [] };

  // ---- 0. 事实收集（任何一步失败即中止，不写入半份注册） ----
  const cdi = JSON.parse(fs.readFileSync(CDI3, 'utf8'));
  const w3 = JSON.parse(fs.readFileSync(W3REGISTRY, 'utf8'));
  if (w3.model?.id !== MODEL_ID) {
    throw new Error(`w3-registry model.id (${w3.model?.id}) 与 ${MODEL_ID} 不一致，拒绝继续`);
  }
  const facts = readMoc3Facts(MOC3);
  const cdiParams = cdi.Parameters ?? [];
  const cdiParts = cdi.Parts ?? [];
  const cdiParamById = new Map(cdiParams.map((p) => [p.Id, p]));
  const cdiPartById = new Map(cdiParts.map((p) => [p.Id, p]));

  // moc3 与 cdi3 参数集交叉核对：以 moc3 为二进制事实，cdi3 为语义来源
  const moc3ParamSet = new Set(facts.parameter_ids);
  const cdiOnlyParams = [...cdiParamById.keys()].filter((id) => !moc3ParamSet.has(id));
  const moc3OnlyParams = [...moc3ParamSet].filter((id) => !cdiParamById.has(id));
  // w3-registry 范围证据
  const rangeEvidence = new Map(); // paramId -> {min, max, sourceCommit}
  for (const e of w3.entries ?? []) {
    for (const p of e.controlledParams ?? []) {
      const min = Number(p.min ?? p.end ?? NaN);
      const max = Number(p.max ?? p.end ?? NaN);
      if (Number.isFinite(min) && Number.isFinite(max) && min !== max) {
        const prev = rangeEvidence.get(p.id);
        if (!prev) rangeEvidence.set(p.id, { min, max, sourceCommit: w3.sourceCommit, via: e.id });
      }
    }
  }
  report.steps.push({
    step: 'facts',
    moc3Params: facts.parameter_ids.length,
    moc3Parts: facts.part_ids.length,
    cdi3Params: cdiParams.length,
    cdi3Parts: cdiParts.length,
    cdiOnlyParams,
    moc3OnlyParams,
    rangeEvidenceParams: rangeEvidence.size,
  });

  // ---- 1. 注册模型 ----
  const db = openDb({ startDir: REPO_ROOT });
  withTransaction(db, () => {
    upsertModel(db, {
      modelId: MODEL_ID,
      title: w3.model?.model3 ?? '大肥鱼',
      sourcePath: path.relative(REPO_ROOT, MOC3),
      packageHash: sha256(MOC3),
      moc3Version: readMoc3Version(MOC3),
      status: 'imported',
    });

    // ---- 2. 源文件清单（sha256 锚定） ----
    const sf = {};
    for (const [key, p, fmt] of [
      ['moc3', MOC3, 'moc3'],
      ['cdi3', CDI3, 'cdi3.json'],
      ['model3', MODEL3, 'model3.json'],
      ['physics3', PHYSICS3, 'physics3.json'],
    ]) {
      const rel = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
      sf[key] = upsertSourceFile(db, {
        modelId: MODEL_ID, relativePath: rel,
        sha256: sha256(p), sizeBytes: fs.statSync(p).size, format: fmt,
      }).id;
    }

    // ---- 3. Part 节点：以 moc3 二进制事实为准，displayName 取 cdi3 ----
    for (const partId of facts.part_ids) {
      const cdiPart = cdiPartById.get(partId);
      upsertNode(db, {
        modelId: MODEL_ID,
        nodeKey: partId,
        nodeType: 'Part',
        displayName: cdiPart?.Name ?? null,
        evidenceLevel: cdiPart ? 'source_exact' : 'parser_derived',
        confidence: cdiPart ? 1 : 0.9,
        sourceFileId: sf.moc3,
        sourcePointer: `moc3:part:${partId}`,
        parserName: PARSER,
        parserVersion: 'py-moc3@2fb112e',
      });
    }
    // cdi3 独有 Part（二进制中未解析到）→ 差异事实入册
    const moc3PartSet = new Set(facts.part_ids);
    for (const [id, p] of cdiPartById) {
      if (!moc3PartSet.has(id)) {
        addValidationFinding(db, {
          modelId: MODEL_ID, severity: 'info', code: 'CDI3_PART_MISSING_IN_MOC3',
          message: `cdi3 Part '${id}'（${p.Name}）未在 moc3 解析结果中出现`,
          evidence: { cdi3Sha: sha256(CDI3), parser: PARSER },
        });
      }
    }

    // ---- 4. Parameter 节点 + 参数目录 ----
    let withRange = 0;
    for (const paramId of facts.parameter_ids) {
      const cdiParam = cdiParamById.get(paramId);
      const nodeId = upsertNode(db, {
        modelId: MODEL_ID,
        nodeKey: paramId,
        nodeType: 'Parameter',
        displayName: cdiParam?.Name ?? null,
        evidenceLevel: cdiParam ? 'source_exact' : 'parser_derived',
        confidence: cdiParam ? 1 : 0.9,
        sourceFileId: sf.cdi3,
        sourcePointer: `cdi3:Parameters:Id=${paramId}`,
        parserName: PARSER,
        parserVersion: 'py-moc3@2fb112e',
      });
      // 范围仅在有证据时填写；default 一律 NULL（无来源，不伪造）
      const rng = rangeEvidence.get(paramId);
      if (rng) withRange += 1;
      upsertParameter(db, {
        modelId: MODEL_ID,
        paramId,
        name: cdiParam?.Name ?? null,
        minValue: rng ? rng.min : null,
        maxValue: rng ? rng.max : null,
        defaultValue: null,
        nodeId,
      });
    }

    // cdi3 有而 moc3 无的参数差异 → finding
    for (const id of cdiOnlyParams) {
      addValidationFinding(db, {
        modelId: MODEL_ID, severity: 'info', code: 'CDI3_PARAM_MISSING_IN_MOC3',
        message: `cdi3 参数 '${id}'（${cdiParamById.get(id)?.Name}）未在 moc3 解析结果中出现`,
        evidence: { cdi3Sha: sha256(CDI3), parser: PARSER },
      });
    }

    report.steps.push({
      step: 'registered',
      model: MODEL_ID,
      packageHash: sha256(MOC3).slice(0, 12),
      params: facts.parameter_ids.length,
      paramsWithRange: withRange,
      parts: facts.part_ids.length,
      cdi3OnlyParts: cdiParts.filter((p) => !moc3PartSet.has(p.Id)).map((p) => `${p.Id}(${p.Name})`),
    });
  });
  db.close();
  console.log(JSON.stringify(report, null, 2));
}

main();
