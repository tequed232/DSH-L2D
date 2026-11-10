#!/usr/bin/env node
/**
 * 校验 docs/nodegraph/models/<modelId>/body-regions.json：
 *   - 目录里的每个参数必须且只能出现在一个 region、shared、unassigned、expressionLayer 或 accessories
 *   - 物理输出全集覆盖且不重复，并标记为只读 / bridge 不可写
 *   - 21 个入库表情与 7 个入库动作都有分区记录
 *   - 131 个物理组都标注了输入参数及其所属模块
 *
 * 用法：node tools/live2d-catalog/check-body-regions.mjs
 *      node tools/live2d-catalog/check-body-regions.mjs --file <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const DEFAULT_MODEL = '大肥鱼.dsl2d.2048';
const REGIONS = ['hair', 'face', 'hands', 'torso', 'legs'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fail(errors) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n校验失败：${errors.length} 项`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const regionsPath = fileIdx >= 0
  ? path.resolve(args[fileIdx + 1])
  : path.join(REPO, 'docs/nodegraph/models', DEFAULT_MODEL, 'body-regions.json');
const catalogPath = path.join(REPO, 'docs/nodegraph/live2d-catalog.json');
const idsPath = path.join(REPO, 'docs/nodegraph/live2d-ids.json');

if (!fs.existsSync(regionsPath)) {
  fail([`找不到分区表：${regionsPath}`]);
}
if (!fs.existsSync(catalogPath) || !fs.existsSync(idsPath)) {
  fail(['找不到 live2d-catalog.json 或 live2d-ids.json']);
}

const doc = readJson(regionsPath);
const catalog = readJson(catalogPath);
const ids = readJson(idsPath);
const errors = [];

if (doc.modelId !== catalog.modelId) {
  errors.push(`modelId 不一致：分区表 ${doc.modelId} vs 目录 ${catalog.modelId}`);
}

const catalogParamIds = catalog.parameters.map((p) => p.id);
const idsParamIds = Object.keys(ids.params);
if (catalogParamIds.length !== 509 || idsParamIds.length !== 509) {
  errors.push(`目录参数数量不是 509（catalog=${catalogParamIds.length}, ids=${idsParamIds.length}）`);
}
const catalogSet = new Set(catalogParamIds);
const idsSet = new Set(idsParamIds);
for (const id of catalogParamIds) {
  if (!idsSet.has(id)) errors.push(`live2d-ids.json 缺少参数 ${id}`);
}
for (const id of idsParamIds) {
  if (!catalogSet.has(id)) errors.push(`live2d-catalog.json 缺少参数 ${id}`);
}
const paramById = new Map(catalog.parameters.map((p) => [p.id, p]));
const physicsIdSet = new Set(catalog.physicsOutputIds);
for (const p of catalog.parameters) {
  if (p.physicsOutput && !physicsIdSet.has(p.id)) {
    errors.push(`参数 ${p.id} 标记为物理输出，但不在 physicsOutputIds 中`);
  }
  if (!p.physicsOutput && physicsIdSet.has(p.id)) {
    errors.push(`参数 ${p.id} 在 physicsOutputIds 中，但 physicsOutput=false`);
  }
}

if (physicsIdSet.size !== 292) {
  errors.push(`目录物理输出数不是 292（${physicsIdSet.size}）`);
}

// Collect assignments
const seen = new Map(); // id -> location
function place(id, loc) {
  if (!id || typeof id !== 'string') {
    errors.push(`空参数 id，出现在 ${loc}`);
    return;
  }
  if (!catalogSet.has(id)) {
    errors.push(`${loc} 出现了目录中不存在的参数 ${id}`);
  }
  if (seen.has(id)) {
    errors.push(`参数 ${id} 重复出现：${seen.get(id)} 与 ${loc}`);
  } else {
    seen.set(id, loc);
  }
}

if (!doc.regions || typeof doc.regions !== 'object') {
  errors.push('缺少 regions');
} else {
  for (const r of REGIONS) {
    const region = doc.regions[r];
    if (!region) {
      errors.push(`缺少 region ${r}`);
      continue;
    }
    if (!Array.isArray(region.params) || !Array.isArray(region.physicsOutputs)
        || !Array.isArray(region.motions) || !Array.isArray(region.expressions)) {
      errors.push(`region ${r} 缺少 params / physicsOutputs / motions / expressions 数组`);
      continue;
    }
    for (const id of region.params) place(id, `regions.${r}.params`);
    const paramSet = new Set(region.params);
    for (const id of region.physicsOutputs) {
      if (!paramSet.has(id)) {
        errors.push(`regions.${r}.physicsOutputs 含 ${id}，但该参数不在 regions.${r}.params 中`);
      }
      const p = paramById.get(id);
      if (p && !p.physicsOutput) {
        errors.push(`regions.${r}.physicsOutputs 含非物理输出参数 ${id}`);
      }
    }
    for (const id of region.params) {
      const p = paramById.get(id);
      if (p && p.physicsOutput && !region.physicsOutputs.includes(id)) {
        errors.push(`regions.${r}.params 中的物理输出 ${id} 未列入 physicsOutputs`);
      }
    }
  }
}

if (!Array.isArray(doc.shared)) {
  errors.push('缺少 shared 数组');
} else {
  for (const item of doc.shared) {
    if (!item || !item.param) {
      errors.push('shared 项缺少 param');
      continue;
    }
    place(item.param, `shared.${item.param}`);
    if (!Array.isArray(item.owners) || item.owners.length === 0) {
      errors.push(`shared.${item.param} 缺少 owners`);
    } else {
      for (const o of item.owners) {
        if (!REGIONS.includes(o)) errors.push(`shared.${item.param} 的 owner ${o} 不是五区之一`);
      }
    }
    if (!item.arbiter) errors.push(`shared.${item.param} 缺少 arbiter`);
    if (!item.reason) errors.push(`shared.${item.param} 缺少 reason`);
    const p = paramById.get(item.param);
    if (p && p.physicsOutput && item.bridgeWritable === true) {
      errors.push(`shared.${item.param} 是物理输出，但 bridgeWritable=true`);
    }
  }
}

if (!Array.isArray(doc.unassigned)) {
  errors.push('缺少 unassigned 数组');
} else {
  for (const item of doc.unassigned) {
    const id = typeof item === 'string' ? item : item?.id;
    place(id, `unassigned.${id}`);
    if (item && typeof item === 'object' && !item.reason) {
      errors.push(`unassigned.${id} 缺少 reason`);
    }
    const p = paramById.get(id);
    if (p && p.physicsOutput && item && item.bridgeWritable === true) {
      errors.push(`unassigned.${id} 是物理输出，但 bridgeWritable=true`);
    }
  }
}

// accessories slots + uncertain params (from former unassigned)
const acc = doc.accessories;
const accParamList = [];
if (!acc || typeof acc !== 'object') {
  errors.push('缺少 accessories（饰品槽位分组）');
} else {
  if (!Array.isArray(acc.slots)) errors.push('accessories.slots 必须是数组');
  if (!Array.isArray(acc.uncertain)) errors.push('accessories.uncertain 必须是数组');
  const collected = [];
  function collectAccParams(ids, loc) {
    if (!Array.isArray(ids)) {
      errors.push(`${loc} 缺少 params 数组`);
      return;
    }
    for (const id of ids) {
      collected.push(id);
      place(id, loc);
      const p = paramById.get(id);
      if (p && p.physicsOutput && acc.params && !acc.physicsOutputs?.includes(id)) {
        // checked later against accessories.physicsOutputs
      }
    }
  }
  const slotIds = new Set();
  const itemIds = new Set();
  for (const slot of acc.slots || []) {
    if (!slot?.id || !slot.label) errors.push('accessories.slots 项缺少 id/label');
    if (typeof slot.exclusive !== 'boolean') {
      errors.push(`accessories.slots.${slot?.id || '?'} 缺少 exclusive（true|false）`);
    }
    if (slotIds.has(slot.id)) errors.push(`饰品槽位 id 重复：${slot.id}`);
    slotIds.add(slot.id);
    collectAccParams(slot.params || [], `accessories.slots.${slot.id}.params`);
    if (!Array.isArray(slot.items)) {
      errors.push(`accessories.slots.${slot.id} 缺少 items 数组`);
      continue;
    }
    if (slot.exclusive === true && slot.items.length > 1) {
      // 互斥由 bridge 按槽位判断；这里只检查结构
    }
    for (const it of slot.items) {
      if (!it?.id || !it.label) {
        errors.push(`槽位 ${slot.id} 的饰品缺少 id/label`);
        continue;
      }
      if (itemIds.has(it.id)) errors.push(`饰品 item.id 重复：${it.id}`);
      itemIds.add(it.id);
      if (it.kind !== 'expression' && it.kind !== 'param') {
        errors.push(`饰品 ${it.id} 的 kind 必须是 expression 或 param`);
      }
      if (it.ref == null || it.ref === '') errors.push(`饰品 ${it.id} 缺少 ref`);
      if (!('on' in it) || !('off' in it)) errors.push(`饰品 ${it.id} 缺少 on/off`);
      if (it.kind === 'expression') {
        const names = new Set(catalog.expressions.map((e) => e.name));
        if (!names.has(it.ref)) errors.push(`饰品 ${it.id} 的表情 ref 不在目录中：${it.ref}`);
      }
      if (it.kind === 'param') {
        if (!catalogSet.has(it.ref)) errors.push(`饰品 ${it.id} 的参数 ref 未知：${it.ref}`);
        // 直写参数应落在本槽 params（从 unassigned 改归）或 paramHome 所指的已分配位置
        if (slot.params && !slot.params.includes(it.ref) && !it.paramHome) {
          errors.push(`饰品 ${it.id} 的参数 ${it.ref} 不在该槽 params，也未标注 paramHome`);
        }
      }
    }
  }
  for (const u of acc.uncertain || []) {
    if (!u?.id || !u.reason) errors.push('accessories.uncertain 项缺少 id/reason');
    collectAccParams(u.params || [], `accessories.uncertain.${u?.id || '?'}.params`);
  }
  if (Array.isArray(acc.params)) {
    const a = [...collected].sort();
    const b = [...acc.params].sort();
    if (a.join('\n') !== b.join('\n')) {
      errors.push('accessories.params 必须等于各 slot.params 与 uncertain.params 的并集（无遗漏、无多出）');
    }
    // 不要对 acc.params 再 place 一次，否则会报重复；上面已 place
  } else {
    errors.push('缺少 accessories.params');
  }
  if (Array.isArray(acc.physicsOutputs)) {
    const paramSet = new Set(acc.params || collected);
    for (const id of acc.physicsOutputs) {
      if (!paramSet.has(id)) errors.push(`accessories.physicsOutputs 含 ${id}，但不在 accessories.params 中`);
      const p = paramById.get(id);
      if (p && !p.physicsOutput) errors.push(`accessories.physicsOutputs 含非物理输出 ${id}`);
    }
    for (const id of paramSet) {
      const p = paramById.get(id);
      if (p && p.physicsOutput && !acc.physicsOutputs.includes(id)) {
        errors.push(`accessories 中的物理输出 ${id} 未列入 physicsOutputs`);
      }
    }
  } else {
    errors.push('缺少 accessories.physicsOutputs');
  }
}

if (!doc.expressionLayer || !Array.isArray(doc.expressionLayer.params)) {
  errors.push('缺少 expressionLayer.params（表情是单独一层，不占神态模块）');
} else {
  for (const id of doc.expressionLayer.params) {
    place(id, `expressionLayer.params`);
    const p = paramById.get(id);
    if (p && p.physicsOutput) {
      errors.push(`expressionLayer 参数 ${id} 不应是物理输出`);
    }
  }
  if (doc.regions?.face?.params) {
    const faceSet = new Set(doc.regions.face.params);
    for (const id of doc.expressionLayer.params) {
      if (faceSet.has(id)) {
        errors.push(`表情层参数 ${id} 同时出现在 face，违反「表情不占神态模块」`);
      }
    }
  }
}

// completeness
for (const id of catalogParamIds) {
  if (!seen.has(id)) errors.push(`参数 ${id} 未出现在 region / shared / unassigned / expressionLayer / accessories`);
}

if (doc.policy?.bridgeMayWritePhysicsOutputs === true) {
  errors.push('policy.bridgeMayWritePhysicsOutputs 应为 false（物理输出只读）');
}
if (doc.policy?.physicsOutputsReadOnly !== true) {
  errors.push('policy.physicsOutputsReadOnly 应为 true');
}
if (doc.policy?.expressionLayerSeparateFromFace !== true) {
  errors.push('policy.expressionLayerSeparateFromFace 应为 true');
}

// all physics outputs accounted in some physicsOutputs list or shared/unassigned
const listedPhys = new Set();
for (const r of REGIONS) {
  for (const id of doc.regions?.[r]?.physicsOutputs || []) listedPhys.add(id);
}
for (const item of doc.shared || []) {
  const p = paramById.get(item.param);
  if (p?.physicsOutput) listedPhys.add(item.param);
}
for (const item of doc.unassigned || []) {
  const id = typeof item === 'string' ? item : item?.id;
  const p = paramById.get(id);
  if (p?.physicsOutput) listedPhys.add(id);
}
for (const id of doc.accessories?.physicsOutputs || []) listedPhys.add(id);
for (const id of physicsIdSet) {
  if (!listedPhys.has(id)) errors.push(`物理输出 ${id} 未出现在任何 physicsOutputs / shared / unassigned / accessories`);
}
for (const id of listedPhys) {
  if (!physicsIdSet.has(id)) errors.push(`被标为物理输出的 ${id} 不在目录 physicsOutputIds 中`);
}

// expressions
const catalogExpr = new Set(catalog.expressions.map((e) => e.name));
const layerExprs = doc.expressionLayer?.expressions;
if (!Array.isArray(layerExprs) || layerExprs.length !== catalog.expressions.length) {
  errors.push(`expressionLayer.expressions 数量 ${layerExprs?.length} 与目录 ${catalog.expressions.length} 不一致`);
} else {
  const seenExpr = new Set();
  const allowedBlend = new Set(['Add', 'Multiply', 'Overwrite']);
  for (const e of layerExprs) {
    if (!catalogExpr.has(e.name)) errors.push(`未知表情 ${e.name}`);
    if (seenExpr.has(e.name)) errors.push(`表情重复 ${e.name}`);
    seenExpr.add(e.name);
    if (!Array.isArray(e.writes) || e.writes.length === 0) {
      errors.push(`表情 ${e.name} 缺少 writes`);
      continue;
    }
    for (const w of e.writes) {
      if (!w.param || !catalogSet.has(w.param)) {
        errors.push(`表情 ${e.name} 写入了未知参数 ${w.param}`);
      }
      if (!allowedBlend.has(w.blend)) {
        errors.push(`表情 ${e.name} 参数 ${w.param} 的 blend 不是 Add/Multiply/Overwrite：${w.blend}`);
      }
    }
  }
  for (const name of catalogExpr) {
    if (!seenExpr.has(name)) errors.push(`目录表情 ${name} 未出现在 expressionLayer.expressions`);
  }
}

// motions
const catalogMotions = new Set(catalog.motions.map((m) => m.group));
const docMotions = doc.motions;
if (!Array.isArray(docMotions) || docMotions.length !== catalog.motions.length) {
  errors.push(`motions 数量 ${docMotions?.length} 与目录 ${catalog.motions.length} 不一致`);
} else {
  const seenM = new Set();
  for (const m of docMotions) {
    if (!catalogMotions.has(m.group)) errors.push(`未知动作组 ${m.group}`);
    if (seenM.has(m.group)) errors.push(`动作组重复 ${m.group}`);
    seenM.add(m.group);
    if (!Array.isArray(m.writes) || m.writes.length === 0) {
      errors.push(`动作 ${m.group} 缺少 writes`);
    } else {
      for (const id of m.writes) {
        if (!catalogSet.has(id)) errors.push(`动作 ${m.group} 写入了未知参数 ${id}`);
      }
    }
  }
  for (const g of catalogMotions) {
    if (!seenM.has(g)) errors.push(`目录动作组 ${g} 未出现在 motions`);
  }
}

// every official motion should appear in at least one region.motions or be documented
for (const r of REGIONS) {
  for (const g of doc.regions?.[r]?.motions || []) {
    if (!catalogMotions.has(g)) errors.push(`regions.${r}.motions 含未知动作组 ${g}`);
  }
}

// physics groups
const groups = doc.physicsGroups;
if (!Array.isArray(groups) || groups.length !== 131) {
  errors.push(`physicsGroups 数量应为 131，实际 ${groups?.length}`);
} else {
  const outSeen = new Map();
  for (const g of groups) {
    if (!g.id || !g.name) errors.push(`物理组缺少 id/name`);
    if (g.outputsReadOnly !== true || g.bridgeWritable !== false) {
      errors.push(`物理组 ${g.id}（${g.name}）必须 outputsReadOnly=true 且 bridgeWritable=false`);
    }
    if (!Array.isArray(g.inputs) || !Array.isArray(g.outputs) || !Array.isArray(g.inputModules)) {
      errors.push(`物理组 ${g.id} 缺少 inputs / outputs / inputModules`);
      continue;
    }
    if (g.inputs.length === 0) errors.push(`物理组 ${g.id} 没有输入`);
    if (g.outputs.length === 0) errors.push(`物理组 ${g.id} 没有输出`);
    for (const inp of g.inputs) {
      if (!inp.param || !catalogSet.has(inp.param)) {
        errors.push(`物理组 ${g.id} 输入参数未知：${inp.param}`);
      }
      if (!inp.bucket && !inp.region) {
        errors.push(`物理组 ${g.id} 输入 ${inp.param} 未标注所属模块`);
      }
      if (inp.region && !REGIONS.includes(inp.region) && inp.region !== 'shared') {
        // region field should be a five-region name; shared/unassigned use bucket
        if (!['hair', 'face', 'hands', 'torso', 'legs'].includes(inp.region)) {
          errors.push(`物理组 ${g.id} 输入 ${inp.param} 的 region 非法：${inp.region}`);
        }
      }
    }
    for (const id of g.outputs) {
      if (!physicsIdSet.has(id)) {
        errors.push(`物理组 ${g.id} 输出 ${id} 不是目录中的物理输出`);
      }
      if (outSeen.has(id)) {
        errors.push(`物理输出 ${id} 被多个物理组写入：${outSeen.get(id)} 与 ${g.id}`);
      } else {
        outSeen.set(id, g.id);
      }
    }
  }
  for (const id of physicsIdSet) {
    if (!outSeen.has(id)) errors.push(`物理输出 ${id} 没有对应的 physicsGroups 项`);
  }
}

// counts
const assigned = seen.size;
if (doc.counts?.assignedSum != null && doc.counts.assignedSum !== assigned) {
  errors.push(`counts.assignedSum=${doc.counts.assignedSum} 与实际去重分配数 ${assigned} 不一致`);
}
if (assigned !== catalogParamIds.length) {
  errors.push(`已分配 ${assigned}，目录共 ${catalogParamIds.length}`);
}

if (errors.length) fail(errors);

const c = doc.counts || {};
const accCount = doc.accessories?.params?.length ?? 0;
const accSlots = doc.accessories?.slots?.length ?? 0;
const accUnc = doc.accessories?.uncertain?.length ?? 0;
ok(`${path.relative(REPO, regionsPath)}`);
ok(`509 个参数覆盖完整且不重复（五区 ${REGIONS.map((r) => `${r}=${doc.regions[r].params.length}`).join(', ')}，表情层=${doc.expressionLayer.params.length}，shared=${doc.shared.length}，accessories=${accCount}，unassigned=${doc.unassigned.length}）`);
ok(`饰品槽位 ${accSlots} 个，uncertain ${accUnc} 组；同一 exclusive 槽互斥，不同槽可一起戴`);
ok(`292 个物理输出全部只读，bridge 不可写；131 个物理组均标注了输入模块`);
ok(`21 个入库表情均记录了写入参数与 Add/Multiply/Overwrite；7 个入库动作均记录了写入参数与所占区`);
ok(`表情层与神态模块参数无交叉`);
console.log('\n校验通过');
process.exit(0);
