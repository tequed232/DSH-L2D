#!/usr/bin/env node
/**
 * Actions JSON 规范校验器（零依赖）
 *
 * 校验动作定义文件是否符合 tools/actions-schema/motion-definition.schema.json 的
 * 核心约束（19 字段任务书对齐 + 结构规则）。不做完整 JSON Schema 语义，
 * 只做可执行的结构守门：字段覆盖 / 枚举 / 链步骤 / 语义链禁含模型参数 ID。
 *
 * 用法：node tools/actions-schema/validate.mjs <motion.json> [more.json ...]
 * 退出码：0=全部通过，1=存在违规
 */
import fs from 'node:fs';

const STATUSES = ['draft', 'analyzing', 'planned', 'validated', 'rejected', 'deprecated'];
const STEP_KINDS = ['expression', 'motion', 'pose', 'look', 'keyframes'];
const TASKBOOK_19 = [
  'motion_id', 'semantic_key', 'description', 'emotion', 'facial_expression', 'gaze',
  'body_language', 'source_asset', 'analysis_report', 'actions_chain', 'json_address',
  'model_compatibility', 'capability_revision', 'schema_version', 'confidence',
  'validation_report', 'status', 'created_at', 'updated_at',
];

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

  const chain = doc.actions_chain ?? {};
  if (!chain.chain_id) errors.push('actions_chain.chain_id 必填');
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) errors.push('actions_chain.steps 须为非空数组');
  for (const [i, s] of (chain.steps ?? []).entries()) {
    if (!STEP_KINDS.includes(s.kind)) errors.push(`step[${i}].kind 非法: ${s.kind}`);
    if (typeof s.params !== 'object' || s.params === null) errors.push(`step[${i}].params 须为对象`);
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

// ---- CLI
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
