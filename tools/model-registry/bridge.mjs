#!/usr/bin/env node
/**
 * dsh-l2d · 图像 ↔ 模型桥接器（P1-3：可复现桥接案例）
 *
 * 链路：Image Asset → Motion Analysis → Semantic Tags → Motion Definition
 *       → Model Adapter → Model Nodes
 *
 * 纪律：
 *  - 标签 → Part 映射表为**人工核对**（依据 cdi3 中文名），不做模糊自动匹配；
 *  - 动作链不含任何模型参数 ID（19 字段规范 + 校验器保证）；
 *  - 语义 → 参数映射由本脚本经 bindMotionToModel 写入 motion_model_bindings（Adapter 层），
 *    一对多（tail_sway → Rotation84~87 四段级联）；
 *  - 绑定前逐参数校验存在性，未注册参数 fail-closed（拒绝伪造映射）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import {
  upsertMotionDefinition, upsertActionChain,
} from '../../packages/dsh-l2d-db/src/repo.mjs';
import {
  bindMotionToModel, resolveMotionParams,
} from '../../packages/dsh-l2d-db/src/model-adapter.mjs';
import { loadCapabilityRegistry } from '../../packages/dsh-l2d-db/src/capability-registry.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const MODEL_ID = '大肥鱼.dsl2d';
const SHEET_FILE = 'dafeiyu-mature-character-sheet.png';
const MOTION_ID = 'dafeiyu.tail-sway-happy';
const CHAIN_ID = 'chain.dafeiyu.tail-sway-happy.v1';
const EXAMPLE = path.join(REPO_ROOT, 'tools', 'actions-schema', 'examples', 'dafeiyu-tail-sway-happy.motion.json');

/**
 * 人工核对的标签 → 模型 Part 映射（依据 大肥鱼.cdi3.json Parts[].Name）：
 *   Part136='尾巴'  Part156='耳朵'  Part161='女仆发饰'  Part162='后发'
 * 桥接的对象是【部位语义标签】（field='part'）；服装/风格/表情等标签不桥接
 * （模型中服装是参数开关不是独立 Part，风格类是图像属性，强桥=伪造）。
 */
const LABEL_PART_BRIDGE = [
  { field: 'part', value: 'whale_tail', nodeKey: 'Part136', cdi3Name: '尾巴' },
  { field: 'part', value: 'whale_fin_ears', nodeKey: 'Part156', cdi3Name: '耳朵' },
  { field: 'part', value: 'maid_headdress', nodeKey: 'Part161', cdi3Name: '女仆发饰' },
  { field: 'part', value: 'long_wavy_hair', nodeKey: 'Part162', cdi3Name: '后发' },
];

/** 语义通道 → 模型参数映射（依据 cdi3 Parameters[].Name，四段尾巴级联链）。 */
const TAIL_ADAPTER = {
  channels: {
    tail_sway: [
      { paramId: 'Param_Angle_Rotation84', weight: 1.0 },  // [0]尾巴（根部）
      { paramId: 'Param_Angle_Rotation85', weight: 0.8 },  // [1]尾巴
      { paramId: 'Param_Angle_Rotation86', weight: 0.6 },  // [2]尾巴
      { paramId: 'Param_Angle_Rotation87', weight: 0.4 },  // [3]尾巴（梢部）
    ],
    tail_flip: [
      { paramId: 'Param52', weight: 1.0 },                 // 尾巴翻面
    ],
    tail_visible: [
      { paramId: 'Clothes5', weight: 1.0 },                // 5. 尾巴（开关）
    ],
  },
  notes: '映射依据：cdi3 Parameters[].Name（尾巴四段级联 + 翻面 + 开关）；范围证据缺失故不填 min/max',
};

function main() {
  const db = openDb({ startDir: REPO_ROOT });
  const report = { bridge: [], motion: {}, resolve: null };

  // ---- 1. 语义标签 → 模型 Part 桥接（image side → model side） ----
  const item = db.prepare('SELECT id FROM gallery_items WHERE file_name = ?').get(SHEET_FILE);
  if (!item) throw new Error(`图库条目 '${SHEET_FILE}' 不存在，先跑 scan.mjs`);
  for (const b of LABEL_PART_BRIDGE) {
    const label = db.prepare(
      'SELECT id, linked_node_id FROM gallery_labels WHERE item_id = ? AND field = ? AND value = ?',
    ).get(item.id, b.field, b.value);
    if (!label) {
      report.bridge.push({ ...b, bridged: false, reason: 'label not found' });
      continue;
    }
    const node = db.prepare(
      "SELECT id, node_key, display_name FROM nodes WHERE model_id = ? AND node_key = ? AND node_type = 'Part'",
    ).get(MODEL_ID, b.nodeKey);
    if (!node) {
      report.bridge.push({ ...b, bridged: false, reason: `node ${b.nodeKey} 未注册（拒绝伪造桥接）` });
      continue;
    }
    if (node.display_name !== b.cdi3Name) {
      report.bridge.push({ ...b, bridged: false, reason: `displayName 不符：期望 '${b.cdi3Name}' 实际 '${node.display_name}'` });
      continue;
    }
    db.prepare('UPDATE gallery_labels SET linked_node_id = ? WHERE id = ?').run(node.id, label.id);
    report.bridge.push({ ...b, bridged: true, nodeId: node.id });
  }

  // ---- 2. 示例动作入库（语义链不含模型参数 ID） ----
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const def = upsertMotionDefinition(db, {
    id: MOTION_ID,
    semanticKey: example.semantic_key,
    description: example.description,
    emotion: example.emotion ?? null,
    expression: example.facial_expression ?? null,
    gaze: example.gaze ?? null,
    bodyLanguage: example.body_language ?? null,
    status: 'draft',
  });
  const stepCount = upsertActionChain(db, {
    chainId: CHAIN_ID,
    motionId: MOTION_ID,
    chain: example.actions_chain,
    schemaVersion: example.schema_version ?? '1.0.0',
    steps: (example.actions_chain.steps ?? []).map((s, i) => ({
      id: s.step_id ?? `step-${i}`,
      kind: s.kind,
      params: s.params ?? {},
      durationMs: s.duration_ms ?? null,
    })),
  });

  // ---- 3. Model Adapter：一对多语义映射（fail-closed 校验后写入） ----
  const registry = loadCapabilityRegistry();
  const modelCheck = registry.checkModel(MODEL_ID);
  if (!modelCheck.ok) throw new Error(`能力注册表拒绝模型：${modelCheck.code}`);
  bindMotionToModel(db, {
    motionId: MOTION_ID,
    modelId: MODEL_ID,
    adapter: TAIL_ADAPTER,
    capabilityRegistry: registry,
  });

  // ---- 4. 解析验证（执行期视角） ----
  const resolved = resolveMotionParams(db, { motionId: MOTION_ID, modelId: MODEL_ID });

  const binding = db.prepare('SELECT adapter_json, compatible FROM motion_model_bindings WHERE motion_id = ? AND model_id = ?').get(MOTION_ID, MODEL_ID);
  report.motion = {
    motionId: MOTION_ID,
    semanticKey: example.semantic_key,
    definitionStatus: def.status,
    chainSteps: stepCount,
    modelCheck: modelCheck.ok,
    adapterParamCount: Object.values(JSON.parse(binding.adapter_json).channels).flat().length,
    compatible: binding.compatible,
    resolve: resolved,
  };

  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main();
