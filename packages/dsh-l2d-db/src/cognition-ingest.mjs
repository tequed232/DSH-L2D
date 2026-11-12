/**
 * dsh-l2d · 模型认知入库（泛化版）：任意模型目录 → Model IR（@dsh/db）。
 *
 * 来源与纪律（与 tools/model-registry/ingest.mjs 原大肥鱼硬编码版同一套证据纪律）：
 *  - 事实源：model3.json（包身份/引用）、cdi3.json（参数与 Part 的 Id/Name，模型作者导出）、
 *    moc3（二进制结构事实，py-moc3 子进程读）、w3-registry（受控参数 min/max 范围证据）；
 *  - 参数 ID 与显示名来自 cdi3 → evidence_level='source_exact'；二进制独有 → 'parser_derived'；
 *  - min/max 仅在 w3-registry 有该模型记录时填写（range_evidence 记来源与提交锚点），
 *    否则 NULL——不伪造；default_value：cdi3/moc3/w3-registry 均不含默认值，新行写 NULL；
 *  - 已有非空证据不抹掉：enrich-ranges.mjs 等后续流程写入的 min/max/default（运行时实测）
 *    在重新入库时保留（upsertParameter 对 default 是覆盖语义，这里显式回填）；
 *  - cdi3 与 moc3 的 Part / 参数集差异如实写 validation_findings（info），parse 失败写
 *    warning finding + 仍继续（降级不阻塞）；
 *  - 语义标签（semantic_labels）不做自动推断，保留给人工/多模态标注流程。
 *
 * 幂等：全链 upsert；validation_findings 是追加表，这里按 (model_id, code, message)
 * 预查去重，重复执行不产生重复行。
 *
 * 失败语义：模型根（models 行）写不进去 → ok:false（外键依赖，无法降级）；
 * 其余每一步的失败只降级 warnings，绝不让单步炸掉整次入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { withTransaction } from './db.mjs';
import {
  addValidationFinding,
  saveCapabilityProfile,
  upsertModel,
  upsertNode,
  upsertParameter,
  upsertSourceFile,
} from './repo.mjs';

const DEFAULT_PARSER = Object.freeze({ name: 'py-moc3+cdi3', version: 'py-moc3@2fb112e' });

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** MOC3 头部版本：magic 'MOC3' 后第 5 字节为版本号（3/4/5…）。非 MOC3 抛错（调用方降级）。 */
export function readMoc3Version(moc3Path) {
  const buf = fs.readFileSync(moc3Path);
  if (buf.subarray(0, 4).toString('ascii') !== 'MOC3') throw new Error(moc3Path + ' 不是 MOC3 文件');
  return 'moc3-v' + buf[4];
}

/** 默认 moc3 事实解析器：py-moc3 子进程（与旧 ingest.mjs 同一条路径）。 */
export function makeMoc3Parser(repoRoot) {
  const pySrc = path.join(repoRoot, 'vendor', 'thirdparty', 'py-moc3', 'src');
  return (moc3Path) => {
    const script = [
      'import json, sys',
      'sys.path.insert(0, r\'' + pySrc.replace(/\\/g, '\\\\') + '\')',
      'from moc3 import Moc3',
      'm = Moc3.from_file(sys.argv[1])',
      'print(json.dumps({"parameter_ids": m.parameter_ids, "part_ids": m.part_ids}))',
    ].join('\n');
    const out = execFileSync('python', ['-c', script, moc3Path], { encoding: 'utf8' });
    const line = out.split('\n').filter((l) => l.trim().startsWith('{')).join('');
    return JSON.parse(line);
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(ext)).sort();
  } catch {
    return [];
  }
}

/** 在模型目录里挑一个文件：优先 `<modelId><ext>`，否则唯一一个 / 排序第一个。 */
function pickFile(dir, modelId, ext) {
  const files = listFiles(dir, ext);
  if (!files.length) return null;
  const preferred = files.find((f) => f === modelId + ext);
  return path.join(dir, preferred || files[0]);
}

/** 扩展名 → 源文件 format 标签。 */
function formatOf(file) {
  const lower = file.toLowerCase();
  for (const [suffix, fmt] of [
    ['.model3.json', 'model3.json'],
    ['.cdi3.json', 'cdi3.json'],
    ['.physics3.json', 'physics3.json'],
    ['.exp3.json', 'exp3.json'],
    ['.motion3.json', 'motion3.json'],
    ['.moc3', 'moc3'],
    ['.png', 'png'],
    ['.jpg', 'jpg'],
    ['.jpeg', 'jpeg'],
  ]) {
    if (lower.endsWith(suffix)) return fmt;
  }
  return path.extname(file).replace(/^\./, '') || 'unknown';
}

/** 相对路径归一：在 repoRoot 内用仓库相对路径（旧行为），否则绝对路径（正斜杠）。 */
function relPathFor(file, repoRoot) {
  if (repoRoot) {
    const rel = path.relative(repoRoot, file);
    if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/');
  }
  return path.resolve(file).replace(/\\/g, '/');
}

/** validation_findings 是追加表：按 (model_id, code, message) 去重，保证幂等。 */
function findingIfAbsent(db, { modelId, severity, code, message, evidence = null }) {
  const exists = db
    .prepare('SELECT 1 AS hit FROM validation_findings WHERE model_id = ? AND code = ? AND message = ?')
    .get(modelId, code, message);
  if (exists) return false;
  addValidationFinding(db, { modelId, severity, code, message, evidence });
  return true;
}

/** 从 model3.json 收集被引用资源（moc3/physics3/textures/exp3/motion3/pose 等）。 */
function collectReferencedFiles(model3Path, model3, modelDir) {
  const dir = path.dirname(model3Path);
  const refs = (model3 && model3.FileReferences) || {};
  const files = [];
  const push = (rel) => {
    if (typeof rel !== 'string' || !rel) return;
    const full = path.resolve(dir, rel);
    files.push(full);
  };
  push(refs.Moc);
  push(refs.Physics);
  push(refs.Pose);
  push(refs.UserData);
  for (const tex of Array.isArray(refs.Textures) ? refs.Textures : []) push(tex);
  for (const exp of Array.isArray(refs.Expressions) ? refs.Expressions : []) push(exp && exp.File);
  if (refs.Motions && typeof refs.Motions === 'object') {
    for (const list of Object.values(refs.Motions)) {
      for (const m of Array.isArray(list) ? list : []) push(m && m.File);
    }
  }
  void modelDir;
  return files;
}

/**
 * 把单个模型目录的认知事实写进 Model IR（幂等，事务内）。
 *
 * @param {import('node:sqlite').DatabaseSync} db openDb() 产物
 * @param {{
 *   modelDir: string,
 *   modelId: string,
 *   repoRoot?: string|null,
 *   title?: string|null,
 *   status?: 'imported'|'analyzed',
 *   parserInfo?: {name?: string, version?: string},
 *   profileArtifact?: string|null,
 *   w3Registry?: object|null,
 *   parseMoc3?: ((moc3Path: string) => {parameter_ids?: string[], part_ids?: string[]})|null,
 * }} options
 * @returns {{ok:boolean, modelId:string,
 *            counts:{sources:number, params:number, nodes:number, findings:number},
 *            warnings:string[], error?:string,
 *            details?:object}}
 */
export function ingestModelCognition(db, options = {}) {
  const modelDir = options.modelDir;
  const modelId = options.modelId;
  const warnings = [];
  const counts = { sources: 0, params: 0, nodes: 0, findings: 0 };
  if (!db) throw new Error('ingestModelCognition: db 必填');
  if (!modelDir || typeof modelDir !== 'string') throw new Error('ingestModelCognition: modelDir 必填');
  if (!modelId || typeof modelId !== 'string') throw new Error('ingestModelCognition: modelId 必填');

  // ---- 0. 事实收集（全部只读；失败降级在 warnings） ----
  const model3Path = pickFile(modelDir, modelId, '.model3.json');
  if (!model3Path) {
    return { ok: false, modelId, counts, warnings, error: 'model3.json 不存在：' + modelDir };
  }
  const model3 = readJsonSafe(model3Path);
  if (!model3) {
    return { ok: false, modelId, counts, warnings, error: 'model3.json 不可解析：' + model3Path };
  }

  const cdi3Path = pickFile(modelDir, modelId, '.cdi3.json');
  const moc3Path =
    pickFile(modelDir, modelId, '.moc3') ||
    (typeof model3.FileReferences?.Moc === 'string' ? path.resolve(modelDir, model3.FileReferences.Moc) : null);
  const physics3Path =
    pickFile(modelDir, modelId, '.physics3.json') ||
    (typeof model3.FileReferences?.Physics === 'string' ? path.resolve(modelDir, model3.FileReferences.Physics) : null);

  const cdi = cdi3Path ? readJsonSafe(cdi3Path) : null;
  if (!cdi3Path) warnings.push('cdi3-missing: 该模型没有 cdi3.json，参数/Part 语义名缺失，回退 moc3 二进制事实');
  else if (!cdi) warnings.push('cdi3-unreadable: cdi3.json 不可解析 ' + cdi3Path);

  // w3-registry：只有 model.id 与当前 modelId 一致才提供范围证据（证据必须属于本模型）。
  let w3 = options.w3Registry || null;
  let registryModel = null;
  if (!w3 && options.repoRoot) {
    w3 = readJsonSafe(path.join(options.repoRoot, 'tools', 'w3-registry', 'registry.json'));
  }
  if (w3 && w3.model && w3.model.id === modelId) registryModel = w3.model;
  const rangeEvidence = new Map();
  if (registryModel) {
    for (const entry of w3.entries || []) {
      for (const p of entry.controlledParams || []) {
        const min = Number(p.min ?? p.end ?? NaN);
        const max = Number(p.max ?? p.end ?? NaN);
        if (Number.isFinite(min) && Number.isFinite(max) && min !== max && !rangeEvidence.has(p.id)) {
          rangeEvidence.set(p.id, { min, max, sourceCommit: w3.sourceCommit, via: entry.id });
        }
      }
    }
  }

  // moc3 二进制事实（失败降级：仍可用 cdi3 完成大部分入库）。
  let moc3Facts = null;
  let moc3Version = null;
  if (moc3Path && fs.existsSync(moc3Path)) {
    try {
      moc3Version = readMoc3Version(moc3Path);
    } catch (err) {
      warnings.push('moc3-version-unreadable: ' + String((err && err.message) || err));
    }
    const parser = options.parseMoc3 || (options.repoRoot ? makeMoc3Parser(options.repoRoot) : null);
    if (parser) {
      try {
        const facts = parser(moc3Path);
        moc3Facts = {
          parameter_ids: Array.isArray(facts && facts.parameter_ids) ? facts.parameter_ids.filter((s) => typeof s === 'string') : [],
          part_ids: Array.isArray(facts && facts.part_ids) ? facts.part_ids.filter((s) => typeof s === 'string') : [],
        };
      } catch (err) {
        warnings.push('moc3-parse-failed: ' + String((err && err.message) || err).slice(0, 300));
      }
    } else {
      warnings.push('moc3-parser-unavailable: 未提供 moc3 解析器（repoRoot/parseMoc3 缺失），仅用 cdi3 事实');
    }
  } else {
    warnings.push('moc3-missing: 未找到 .moc3 文件，二进制结构事实缺失');
  }

  const cdiParams = Array.isArray(cdi && cdi.Parameters) ? cdi.Parameters : [];
  const cdiParts = Array.isArray(cdi && cdi.Parts) ? cdi.Parts : [];
  const cdiParamById = new Map(cdiParams.map((p) => [p.Id, p]));
  const cdiPartById = new Map(cdiParts.map((p) => [p.Id, p]));
  const parserName = (options.parserInfo && options.parserInfo.name) || DEFAULT_PARSER.name;
  const parserVersion = (options.parserInfo && options.parserInfo.version) || DEFAULT_PARSER.version;
  const status = options.status === 'analyzed' ? 'analyzed' : 'imported';

  // 参数全集：cdi3 为主（source_exact），moc3 独有并入（parser_derived）。
  const paramIds = [];
  const seenParam = new Set();
  for (const p of cdiParams) {
    if (p && typeof p.Id === 'string' && !seenParam.has(p.Id)) {
      seenParam.add(p.Id);
      paramIds.push(p.Id);
    }
  }
  for (const id of moc3Facts ? moc3Facts.parameter_ids : []) {
    if (!seenParam.has(id)) {
      seenParam.add(id);
      paramIds.push(id);
    }
  }
  // Part 全集：cdi3 为主，moc3 独有并入。
  const partIds = [];
  const seenPart = new Set();
  for (const p of cdiParts) {
    if (p && typeof p.Id === 'string' && !seenPart.has(p.Id)) {
      seenPart.add(p.Id);
      partIds.push(p.Id);
    }
  }
  for (const id of moc3Facts ? moc3Facts.part_ids : []) {
    if (!seenPart.has(id)) {
      seenPart.add(id);
      partIds.push(id);
    }
  }

  const details = {
    packageHash: sha256(model3Path),
    model3: relPathFor(model3Path, options.repoRoot),
    moc3Version,
    cdi3: cdi3Path ? relPathFor(cdi3Path, options.repoRoot) : null,
    parser: parserName,
    paramsWithRange: 0,
    cdi3ParamCount: cdiParams.length,
    cdi3PartCount: cdiParts.length,
    moc3ParamCount: moc3Facts ? moc3Facts.parameter_ids.length : null,
    moc3PartCount: moc3Facts ? moc3Facts.part_ids.length : null,
    cdi3OnlyParts: [],
    moc3OnlyParts: [],
  };

  // ---- 1~6. 写入（单事务，要么整体成立要么回滚） ----
  try {
    withTransaction(db, () => {
      upsertModel(db, {
        modelId,
        title: options.title || (registryModel && registryModel.model3) || path.basename(model3Path),
        sourcePath: relPathFor(moc3Path && fs.existsSync(moc3Path) ? moc3Path : model3Path, options.repoRoot),
        packageHash: details.packageHash,
        moc3Version,
        status,
      });

      // 2) 源文件清单：model3 自身 + 被引用资源 + cdi3（cdi3 不被 model3 引用，但属源事实）。
      const sourceFiles = new Map(); // full path -> row id
      const addSource = (full) => {
        if (!full || sourceFiles.has(full)) return sourceFiles.get(full);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          warnings.push('source-missing: ' + relPathFor(full, options.repoRoot));
          return null;
        }
        const row = upsertSourceFile(db, {
          modelId,
          relativePath: relPathFor(full, options.repoRoot),
          sha256: sha256(full),
          sizeBytes: fs.statSync(full).size,
          format: formatOf(full),
        });
        sourceFiles.set(full, row.id);
        counts.sources += 1;
        return row.id;
      };
      const model3SourceId = addSource(model3Path);
      const cdi3SourceId = addSource(cdi3Path);
      const moc3SourceId = addSource(moc3Path);
      addSource(physics3Path);
      for (const full of collectReferencedFiles(model3Path, model3, modelDir)) addSource(full);

      // 3) Part 节点（cdi3 为主，moc3 独有降级 parser_derived）。
      const moc3PartSet = new Set(moc3Facts ? moc3Facts.part_ids : []);
      for (const partId of partIds) {
        const cdiPart = cdiPartById.get(partId);
        const inMoc3 = moc3PartSet.has(partId);
        upsertNode(db, {
          modelId,
          nodeKey: partId,
          nodeType: 'Part',
          displayName: cdiPart ? cdiPart.Name ?? null : null,
          evidenceLevel: cdiPart ? 'source_exact' : 'parser_derived',
          confidence: cdiPart ? 1 : 0.9,
          sourceFileId: cdiPart ? cdi3SourceId : inMoc3 ? moc3SourceId : cdi3SourceId,
          sourcePointer: cdiPart ? 'cdi3:Parts:Id=' + partId : 'moc3:part:' + partId,
          parserName,
          parserVersion,
        });
        counts.nodes += 1;
        if (!cdiPart && moc3Facts) details.moc3OnlyParts.push(partId);
      }

      // 4) Parameter 节点 + 参数行（cdi3 → source_exact；范围仅 w3-registry 有证据时填）。
      //    证据纪律两半：① 没有来源的字段不伪造（NULL）；② 已有非空证据不抹掉
      //    ——enrich-ranges.mjs 等后续流程写入的 min/max/default（运行时实测）在重新
      //    入库时必须保留，upsertParameter 对 default 是「覆盖」语义，所以这里显式回填。
      const moc3ParamSet = new Set(moc3Facts ? moc3Facts.parameter_ids : []);
      for (const paramId of paramIds) {
        const cdiParam = cdiParamById.get(paramId);
        const inMoc3 = moc3ParamSet.has(paramId);
        const nodeId = upsertNode(db, {
          modelId,
          nodeKey: paramId,
          nodeType: 'Parameter',
          displayName: cdiParam ? cdiParam.Name ?? null : null,
          evidenceLevel: cdiParam ? 'source_exact' : 'parser_derived',
          confidence: cdiParam ? 1 : 0.9,
          sourceFileId: cdiParam ? cdi3SourceId : inMoc3 ? moc3SourceId : cdi3SourceId,
          sourcePointer: cdiParam ? 'cdi3:Parameters:Id=' + paramId : 'moc3:parameter:' + paramId,
          parserName,
          parserVersion,
        });
        counts.nodes += 1;
        const rng = rangeEvidence.get(paramId);
        if (rng) details.paramsWithRange += 1;
        const prev = db
          .prepare('SELECT min_value, max_value, default_value FROM parameters WHERE model_id = ? AND param_id = ?')
          .get(modelId, paramId);
        upsertParameter(db, {
          modelId,
          paramId,
          name: cdiParam ? cdiParam.Name ?? null : null,
          // w3-registry 有该模型证据 → 用证据；否则保留已有值（无则 NULL，不伪造）。
          minValue: rng ? rng.min : prev ? prev.min_value : null,
          maxValue: rng ? rng.max : prev ? prev.max_value : null,
          // cdi3/moc3/w3-registry 都不含默认值 → 新参数写 NULL；已有运行时实测默认值保留。
          defaultValue: prev ? prev.default_value : null,
          nodeId,
          rangeEvidence: rng || null,
        });
        counts.params += 1;
      }

      // 5) 能力画像（可选产物；同一 profileRevision 幂等覆盖）。
      if (options.profileArtifact) {
        const profile = readJsonSafe(options.profileArtifact);
        if (!profile || typeof profile !== 'object') {
          warnings.push('profile-artifact-unreadable: ' + options.profileArtifact);
        } else {
          saveCapabilityProfile(db, {
            modelId,
            version: String(profile.profileRevision || 'v1'),
            profile: { ...profile, modelId },
          });
        }
      }

      // 6) 差异事实（info）：cdi3 与 moc3 的 Part / 参数集双向差集，去重追加。
      const evidenceBase = {
        model3Sha: details.packageHash,
        cdi3Sha: cdi3SourceId ? sha256(cdi3Path) : null,
        parser: parserName,
      };
      for (const [id, part] of cdiPartById) {
        if (moc3Facts && !moc3PartSet.has(id)) {
          details.cdi3OnlyParts.push(id + '(' + (part.Name ?? '') + ')');
          if (findingIfAbsent(db, {
            modelId, severity: 'info', code: 'CDI3_PART_MISSING_IN_MOC3',
            message: "cdi3 Part '" + id + "'（" + (part.Name ?? '') + '）未在 moc3 解析结果中出现',
            evidence: evidenceBase,
          })) counts.findings += 1;
        }
      }
      for (const id of moc3PartSet) {
        if (!cdiPartById.has(id)) {
          if (findingIfAbsent(db, {
            modelId, severity: 'info', code: 'MOC3_PART_MISSING_IN_CDI3',
            message: "moc3 Part '" + id + "' 未在 cdi3 中出现（二进制事实，缺语义名）",
            evidence: evidenceBase,
          })) counts.findings += 1;
        }
      }
      for (const [id, param] of cdiParamById) {
        if (moc3Facts && !moc3ParamSet.has(id)) {
          if (findingIfAbsent(db, {
            modelId, severity: 'info', code: 'CDI3_PARAM_MISSING_IN_MOC3',
            message: "cdi3 参数 '" + id + "'（" + (param.Name ?? '') + '）未在 moc3 解析结果中出现',
            evidence: evidenceBase,
          })) counts.findings += 1;
        }
      }
      for (const id of moc3ParamSet) {
        if (!cdiParamById.has(id)) {
          if (findingIfAbsent(db, {
            modelId, severity: 'info', code: 'MOC3_PARAM_MISSING_IN_CDI3',
            message: "moc3 参数 '" + id + "' 未在 cdi3 中出现（二进制事实，缺语义名）",
            evidence: evidenceBase,
          })) counts.findings += 1;
        }
      }
      if (!moc3Facts) {
        // parse 失败本身入册（warning），不阻塞入库。
        if (findingIfAbsent(db, {
          modelId, severity: 'warn', code: 'MOC3_PARSE_UNAVAILABLE',
          message: 'moc3 二进制结构未解析（解析器不可用或失败），本次入库仅基于 cdi3 事实',
          evidence: { warnings: warnings.slice(-6) },
        })) counts.findings += 1;
      }
      void model3SourceId;
    });
  } catch (err) {
    return {
      ok: false,
      modelId,
      counts,
      warnings,
      details,
      error: String((err && err.message) || err),
    };
  }

  return { ok: true, modelId, counts, warnings, details };
}
