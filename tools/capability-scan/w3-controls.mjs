/**
 * W3 能力清单 → 语义控制项。
 *
 * 数据来源是 `tools/w3-registry/registry.json`（W3 文档的机器可读版，由 build.mjs
 * 从模型文件生成、validate.mjs 独立复核）。这里不抄第二份清单：登记条目、排除表、
 * 未引用资产全部以 registry 为准，扫描器只做「对照真实模型逐条核实」：
 *   - controlledParams 必须真实存在于模型参数表，否则 unsupported（fail-closed，不猜）；
 *   - 动作/表情条目还要求 model3 里确实引用了对应资产且文件存在；
 *   - 命中物理输出的参数 → requires-own。
 *
 * 通道 id 加 `ext.` 前缀（motion-contract 的 ExtensionControlId 约定）：
 * W3 清单是本模型的能力扩充，不属于标准语义控制。
 *
 * 语义约束（W3「语义约束」节 + 各条目 conflicts/composable）在这里具体化成
 * 通道间的 `conflicts` 列表，供 semantic-binding 的 canExpress 在运行期裁决：
 *   - 精确 id（gesture.grass）→ 直接指向；
 *   - 前缀通配（gaze.*）→ 展开为该前缀下的全部登记条目；
 *   - 表情族（expression.key3-6-eye）→ 展开为该 family 的全部表情条目
 *     （眼睛族 key3-6 同一时刻只允许一个表情）；
 *   - 外部目标（motion.head 等未登记实体）→ 不进 conflicts（canExpress 裁决不到它）。
 * 展开时排除自身；共用光效/待机参数（Param56/57、Movement*）不参与冲突，
 * 因为 registry 的 conflictWith 已按「只看姿态骨」的原则声明，这里照单具体化。
 */

/** @typedef {{ id: string, kind: string, status: string, min: number, max: number, neutral: number, confidence: number, reason?: string, sourceId?: string, resourceGroup?: string, ownership?: string, conflicts?: string[] }} W3Control */

function declaredConflictTargets(entry) {
  const declared = new Set([
    ...(((entry.composable || {}).conflictWith) || []),
    ...((entry.conflicts || []).map((c) => c.with).filter(Boolean)),
  ]);
  return [...declared];
}

/** 把 registry 的冲突声明具体化成本画像内的通道 id 列表（ext. 前缀）。 */
function resolveConflicts(entry, entriesById) {
  const out = new Set();
  for (const target of declaredConflictTargets(entry)) {
    if (entriesById.has(target)) {
      if (target !== entry.id) out.add('ext.' + target);
      continue;
    }
    if (target.endsWith('.*')) {
      const prefix = target.slice(0, -1);
      for (const id of entriesById.keys()) {
        if (id !== entry.id && id.startsWith(prefix)) out.add('ext.' + id);
      }
      continue;
    }
    const family = target.match(/^expression\.(.+)$/);
    if (family) {
      for (const [id, e] of entriesById) {
        if (e.kind === 'expression' && e.family === family[1] && id !== entry.id) out.add('ext.' + id);
      }
      continue;
    }
    // 其余（motion.head 等）是登记表之外的运行时实体，不属于本画像的通道，跳过
  }
  return [...out];
}

/**
 * @param {object} registry  tools/w3-registry/registry.json 的内容
 * @param {object} inventory 扫描 inventory（buildInventory 的产物）
 * @returns {{ controls: W3Control[], exclusions: {id:string,label:string,reason:string}[], unregisteredAssets: object }}
 */
export function resolveW3Controls(registry, inventory) {
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const paramIds = new Set((inventory.params || []).map((p) => p.id));
  const physics = new Set(inventory.physicsOutputs || []);
  const motionByGroup = new Map();
  for (const m of inventory.motions || []) if (!motionByGroup.has(m.group)) motionByGroup.set(m.group, m);
  const expressionNames = new Set((inventory.expressions || []).filter((e) => e.exists).map((e) => e.name));

  const controls = entries.map((entry) => {
    const id = 'ext.' + entry.id;
    const wanted = (entry.controlledParams || []).map((p) => p.id);
    const missing = wanted.filter((pid) => !paramIds.has(pid));

    let reason;
    if (missing.length) {
      reason = `W3 登记的参数在模型里不存在：${missing.join(', ')}`;
    } else if (entry.kind === 'motion-pair' || entry.kind === 'motion-loop') {
      const absent = (entry.assets || []).filter((a) => {
        const m = motionByGroup.get(a.group);
        return !m || !m.exists;
      });
      if (absent.length) reason = `model3 未引用或缺少动作资产：${absent.map((a) => a.group).join(', ')}`;
    } else if (entry.kind === 'expression' && !expressionNames.has(entry.expressionName)) {
      reason = `model3 没有表情 ${entry.expressionName}（或 exp3 文件缺失）`;
    }

    if (reason) {
      return {
        id, kind: entry.kind, status: 'unsupported',
        min: -1, max: 1, neutral: 0, confidence: 0,
        reason,
        conflicts: resolveConflicts(entry, entriesById),
      };
    }

    const owned = wanted.some((pid) => physics.has(pid));
    return {
      id,
      kind: entry.kind,
      status: 'supported',
      min: -1,
      max: 1,
      neutral: 0,
      confidence: owned ? 0.8 : 0.9,
      sourceId: wanted.join('+'),
      ownership: owned ? 'requires-own' : 'direct',
      conflicts: resolveConflicts(entry, entriesById),
      ...(owned ? { reason: '含物理输出参数，写入前必须 own' } : {}),
    };
  });

  return {
    controls,
    exclusions: (registry.excluded || []).map((x) => ({ id: x.id, label: x.label, reason: x.reason })),
    unregisteredAssets: registry.unregisteredAssets || { motion3: [], exp3: [] },
  };
}

/** 排除表条目 id（不含 ext. 前缀）——扫描器不再把这些当通道/资产产出。 */
export function excludedChannelIds(registry) {
  return new Set((registry.excluded || []).map((x) => x.id));
}
