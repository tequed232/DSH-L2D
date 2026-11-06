/**
 * PhysicsCapabilityAnalyzer（G1）：physics3.json → PhysicsCapability / CapabilityManifest。
 * 只做分析与证据收集，不做任何 Runtime 写入（G3 接管另行审核）。
 */
import { createHash } from 'node:crypto';
import { buildPhysicsGraph } from './graph.ts';
import type { CapabilityManifest, LimbCapability, PhysicsCapability, PhysicsGraph } from './types.ts';

/** 装饰域判定：id 前缀/集合（G0 §3.2 域表 + 用户硬约束：头发/裙摆/配饰永不接管）。 */
const DECORATION_PREFIXES = [
  'FrontHair', 'SideHair', 'LateSideHair', 'LateHair', 'ShortPonytail', // 头发
  'Skirt', // 裙摆
  'RBow', 'LBow', 'LowX', 'ribbon', 'Hat', // 头配饰/帽子
  'LJewelry', 'RJewelry', 'Gem', 'Kira', 'Shine', // 宝石/闪光
  'Lace', // 花边
  'LEar', 'REar', 'LFlip', 'RFlip', // 兽耳
  'Chest', // 胸部物理（不在肢体分配范围）
];
export function isDecorationParameter(id: string): boolean {
  return DECORATION_PREFIXES.some((p) => id.startsWith(p));
}

/** G0 §3.3 共享枢纽（S1-S5）：双重身份 + 多消费者，独占必拒。 */
const SHARED_HUBS = [
  'ParamBodyAngleX', 'ParamBodyAngleZ', 'ParamBodyAngleY',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'HipAngleX', 'HipAngleY', 'HipAngleZ',
  'Param42', // R手腕Z → 尾巴物理输入（S4）
  'Movement1', 'Movement2', 'Movement3', 'Param35', // 共享开关通道（S5）
];
export function isSharedHub(id: string): boolean {
  return SHARED_HUBS.includes(id);
}

/** 手臂叶子核心集（G0 §4.2 PASS 域；袖/飘带按用户装饰约束排除）。 */
export const ARM_LEAF_CORE: Record<'left_arm' | 'right_arm', string[]> = {
  left_arm: ['LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2'],
  right_arm: ['RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2'],
};

/** 左右肢体约束：左域 id 不得出现在右请求、反之亦然。 */
export function leftRightMismatch(limb: string, parameterIds: string[]): string | null {
  const isLeft = (id: string) => id.startsWith('L') && /Arm|Forearm|Wrist|Hand|Sleeve|Ribbon/.test(id);
  const isRight = (id: string) => id.startsWith('R') && /Arm|Forearm|Wrist|Hand|Sleeve|Ribbon/.test(id);
  if (limb === 'left_arm' && parameterIds.some(isRight)) return 'left-right-mismatch: 左臂请求混入右侧参数';
  if (limb === 'right_arm' && parameterIds.some(isLeft)) return 'left-right-mismatch: 右臂请求混入左侧参数';
  return null;
}

/** PhysicsCapability 产出（用户接口形态）。 */
export function analyzePhysicsCapability(modelId: string, graph: PhysicsGraph): PhysicsCapability {
  const outputs = [...graph.outputs.entries()].flatMap(([id, entries]) =>
    entries.map((e) => ({ parameterId: id, scale: e.weight, role: e.settingId })),
  );
  const inputs = [...graph.inputs.entries()].flatMap(([id, entries]) =>
    entries.map((e) => ({ parameterId: id, weight: e.weight })),
  );
  // 手臂叶子域无下游 → 允许（still需 verified 证据链）；其余域一律不允许（fail-closed）
  const leafArmIds = [...ARM_LEAF_CORE.left_arm, ...ARM_LEAF_CORE.right_arm];
  const ownershipAllowed = leafArmIds.some((id) => graph.outputs.has(id));
  return {
    modelId,
    inputs,
    outputs,
    ownershipAllowed,
    // 证据核验：graph 来自真实 physics3.json 且含手臂叶子输出
    evidenceVerified: ownershipAllowed && leafArmIds.every((id) => graph.outputs.has(id)),
  };
}

export const MANIFEST_VERSION = 1;

/** moc3 → SHA-256（模型版本变化后缓存失效的键）。 */
export function modelHashFromMoc3(moc3Bytes: Uint8Array): string {
  return createHash('sha256').update(moc3Bytes).digest('hex');
}

/**
 * 构建 Capability Manifest（G1 核心）。纯函数：输入 physics3 + modelHash，
 * 输出完整 manifest；不写文件、不触 Runtime。
 */
export function buildCapabilityManifest(
  modelId: string,
  modelHash: string,
  physics3: { PhysicsSettings?: Array<{ Id?: string; Input?: any[]; Output?: any[] }> },
): CapabilityManifest {
  const graph = buildPhysicsGraph(physics3 as any);
  const outputs: CapabilityManifest['physics']['outputs'] = {};
  for (const [id] of graph.outputs) {
    const down = graph.downstream(id);
    outputs[id] = { downstreamCount: down.size, sharedHub: isSharedHub(id) };
  }
  const limbs: LimbCapability[] = [
    limbCapability('left_arm', graph),
    limbCapability('right_arm', graph),
    limbCapability('body', graph),
    limbCapability('head', graph),
    limbCapability('left_leg', graph),
    limbCapability('right_leg', graph),
  ];
  const decorationOutputs = [...graph.outputs.keys()].filter(isDecorationParameter);
  return {
    modelId,
    modelHash,
    manifestVersion: MANIFEST_VERSION,
    physics: {
      settingCount: physics3.PhysicsSettings?.length || 0,
      inputCount: [...graph.inputs.values()].reduce((n, l) => n + l.length, 0),
      outputCount: [...graph.outputs.values()].reduce((n, l) => n + l.length, 0),
      outputs,
    },
    limbs,
    sharedHubs: SHARED_HUBS.filter((id) => graph.inputs.has(id) || graph.outputs.has(id)),
    decorationOutputs,
    builtAt: new Date().toISOString(),
  };
}

function limbCapability(limb: string, graph: PhysicsGraph): LimbCapability {
  if (limb === 'left_arm' || limb === 'right_arm') {
    const ids = ARM_LEAF_CORE[limb];
    const allPresent = ids.every((id) => graph.outputs.has(id));
    const noDownstream = ids.every((id) => graph.downstream(id).size === 0);
    const verified = allPresent && noDownstream; // 证据：真实 physics3 拓扑 + 0 下游
    return {
      limb,
      parameters: ids,
      supportedActions: verified ? ['wave', 'raise', 'swing'] : [],
      physicsConflict: !noDownstream,
      verified,
      reason: verified ? undefined : !allPresent ? 'physics3 中未找到完整叶子输出集（证据缺失）' : '叶子输出存在下游消费者（拓扑冲突）',
    };
  }
  // body/head/leg：G0 §4.2 判定 FAIL 或随动面大 → 不允许，如实标注
  const reason =
    limb === 'body'
      ? 'S1 共享枢纽（ParamBodyAngleX/Y/Z），不可按部位独占'
      : limb === 'head'
        ? '根输入控制域，随动面覆盖整个头饰层（52/42/50 下游），独占不成立'
        : '盆骨/腿域随动裙摆与双腿（14/8/5 下游），未取得独立接管证据';
  return { limb, parameters: [], supportedActions: [], physicsConflict: true, verified: false, reason };
}

export { buildPhysicsGraph };
