#!/usr/bin/env node
/**
 * Actions JSON 规范校验器（零依赖）
 *
 * 校验动作定义文件是否符合 tools/actions-schema/motion-definition.schema.json 的
 * 核心约束（19 字段任务书对齐 + 结构规则）。不做完整 JSON Schema 语义，
 * 只做可执行的结构守门：字段覆盖 / 枚举 / 链步骤 / 语义链禁含模型参数 ID /
 * confidence 范围（0–1）/ date-time（RFC 3339）/ duration_ms 范围（0–30000 整数）。
 *
 * 用法：node tools/actions-schema/validate.mjs <motion.json> [more.json ...]
 * 退出码：0=全部通过，1=存在违规
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const STATUSES = ['draft', 'analyzing', 'planned', 'validated', 'rejected', 'deprecated'];
const STEP_KINDS = ['expression', 'motion', 'pose', 'look', 'keyframes'];
const TASKBOOK_19 = [
  'motion_id', 'semantic_key', 'description', 'emotion', 'facial_expression', 'gaze',
  'body_language', 'source_asset', 'analysis_report', 'actions_chain', 'json_address',
  'model_compatibility', 'capability_revision', 'schema_version', 'confidence',
  'validation_report', 'status', 'created_at', 'updated_at',
];

/** RFC 3339 date-time（JSON Schema format: date-time）零依赖结构校验。 */
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 已是 1–12 时取「下月第 0 天」= 本月天数
}
function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_TIME_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Date.parse 对 2026-02-30 之类会滚动进位（V8），必须显式核对日历
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  if (h > 23 || mi > 59 || s > 60) return false; // RFC 3339 允许闰秒 60
  return !Number.isNaN(Date.parse(value));
}

function confidenceError(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return `${where} 必须为 0–1 的有限数字（Schema minimum 0 / maximum 1）: ${JSON.stringify(value)}`;
  }
  return null;
}

export function validateMotion(doc) {
  const errors = [];
  const missing = TASKBOOK_19.filter((f) => !(f in doc));
  if (missing.length) errors.push(`缺任务书字段: ${missing.join(', ')}`);
  const unexpected = Object.keys(doc).filter((f) => !TASKBOOK_19.includes(f));
  if (unexpected.length) errors.push(`多余字段（Schema 未定义）: ${unexpected.join(', ')}`);
  if (!STATUSES.includes(doc.status)) errors.push(`非法 status: ${doc.status}`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(doc.motion_id ?? '')) errors.push(`motion_id 不合规范: ${doc.motion_id}`);
  if (!/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(doc.semantic_key ?? '')) errors.push(`semantic_key 须为点分小写: ${doc.semantic_key}`);
  if (doc.schema_version !== '1.0.0') errors.push(`schema_version 必须为 1.0.0: ${doc.schema_version}`);

  // #32：Schema 结构约束——置信度范围 / 日期格式 / 动作时长范围（此前手写规则漏检、误放行）
  const confError = confidenceError(doc.confidence, 'confidence');
  if (confError) errors.push(confError);
  const analysisConfError = confidenceError(doc.analysis_report?.confidence, 'analysis_report.confidence');
  if (analysisConfError) errors.push(analysisConfError);
  for (const field of ['created_at', 'updated_at']) {
    if (!isRfc3339DateTime(doc[field])) errors.push(`${field} 必须为 RFC 3339 date-time: ${JSON.stringify(doc[field])}`);
  }

  const chain = doc.actions_chain ?? {};
  if (!chain.chain_id) errors.push('actions_chain.chain_id 必填');
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) errors.push('actions_chain.steps 须为非空数组');
  for (const [i, s] of (chain.steps ?? []).entries()) {
    if (!STEP_KINDS.includes(s.kind)) errors.push(`step[${i}].kind 非法: ${s.kind}`);
    if (typeof s.params !== 'object' || s.params === null) errors.push(`step[${i}].params 须为对象`);
    if (!Number.isInteger(s.duration_ms) || s.duration_ms < 0 || s.duration_ms > 30000) {
      errors.push(`step[${i}].duration_ms 须为 0–30000 的整数: ${JSON.stringify(s.duration_ms)}`);
    }
    if (s.step_index !== undefined && s.step_index !== i) errors.push(`step[${i}].step_index 与位置不一致: ${s.step_index}`);
    // 语义链纪律：禁止出现具体模型参数 ID（大写 Param 开头或大肥鱼自定义参数族命名）
    const flat = JSON.stringify(s.params ?? {});
    if (/"Param[A-Z]|"(Skirt|LateHair|SideHair|RBow|LRibbon|RRibbon|ribbon|AngryMove|SweatBurst|LittleFlower|Clothes|Movement)[A-Za-z]*\d*"/.test(flat)) {
      errors.push(`step[${i}].params 含具体模型参数 ID——语义链必须模型无关（经 Model Adapter 映射）`);
    }
  }
  if (doc.status === 'validated' && doc.validation_report?.verdict === undefined) {
    errors.push('status=validated 必须携带 validation_report.verdict');
  }
  return errors;
}

// ---- CLI（被测试 import 时跳过）
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('用法：node tools/actions-schema/validate.mjs <motion.json> [...]');
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    const errors = validateMotion(doc);
    if (errors.length) {
      failed += 1;
      console.error(`[FAIL] ${f}`);
      for (const e of errors) console.error(`   - ${e}`);
    } else {
      console.log(`[PASS] ${f} (${doc.motion_id}, status=${doc.status})`);
    }
  }
  process.exit(failed ? 1 : 0);
}
