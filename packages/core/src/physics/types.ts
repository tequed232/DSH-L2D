/**
 * Physics3 能力分析类型契约（PR-C，用户作业书接口）。
 *
 * 铁律：physics3 的输入/输出关系 ≠ 参数写入权限。
 * ownershipAllowed 只能来自证据（physics3 拓扑 + G0 审计），未经证实一律 unverified，
 * 分配决策 fail-closed。头发/裙摆/配饰永不进入 Agent 控制白名单。
 */

export type LimbRole = 'left_arm' | 'right_arm' | 'body' | 'head' | 'left_leg' | 'right_leg';

/** physics3.json 解析出的单条输出（Destination）。 */
export interface PhysicsOutput {
  parameterId: string;
  /** 所属 PhysicsSetting id（如 PhysicsSetting73） */
  settingId: string;
  weight: number;
  /** 输出种类（官方：Add/Multiply/Overwrite） */
  type: string;
}

/** physics3.json 解析出的单条输入（Source）。 */
export interface PhysicsInput {
  parameterId: string;
  settingId: string;
  weight: number;
  /** 该输入是否同时是某条设置的输出（双重身份 = 共享域证据） */
  isAlsoOutput: boolean;
}

/** 拓扑图：输出 id → 下游输出 id 全集（传递闭包）。 */
export interface PhysicsGraph {
  outputs: Map<string, PhysicsOutput[]>;
  inputs: Map<string, PhysicsInput[]>;
  /** downstream(id)：从某输出出发传递可达的其他输出 id（含自身域） */
  downstream(id: string): Set<string>;
}

/** 用户作业书：模型物理能力（Analyzer 产出）。 */
export interface PhysicsCapability {
  modelId: string;
  inputs: Array<{ parameterId: string; weight: number }>;
  outputs: Array<{ parameterId: string; scale: number; role: string }>;
  ownershipAllowed: boolean;
  evidenceVerified: boolean;
}

/** 用户作业书：肢体控制能力。 */
export interface LimbCapability {
  limb: LimbRole;
  parameters: string[];
  supportedActions: string[];
  physicsConflict: boolean;
  verified: boolean;
  /** 拒绝/受限原因（physicsConflict 或证据缺失时给出） */
  reason?: string;
}

/** 分配请求。 */
export interface LimbAllocationRequest {
  limb: LimbRole;
  parameters: string[];
  /** 请求意图的候选动作（记录用，不影响判定） */
  supportedActions?: string[];
}

/** 分配决策（纯函数输出，无副作用）。 */
export interface OwnershipDecision {
  /** 'allow' 仅在全部参数通过白名单 + 拓扑 + 证据校验时出现 */
  decision: 'allow' | 'reject';
  reason: string;
  /** 被拒绝的具体参数与根因（逐参数留痕） */
  rejected: Array<{ parameterId: string; cause: string }>;
  /** 允许时的相位约束（手臂叶子域契约 = post） */
  phase?: 'pre' | 'post';
}

/** 模型能力 Manifest（含 modelHash，供缓存失效判定）。 */
export interface CapabilityManifest {
  modelId: string;
  /** moc3 文件 SHA-256；变化即失效 */
  modelHash: string;
  /** manifest 结构版本（判定规则/证据表升级时递增） */
  manifestVersion: number;
  physics: {
    settingCount: number;
    inputCount: number;
    outputCount: number;
    /** 输出 id → { downstreamCount, isSharedHub } */
    outputs: Record<string, { downstreamCount: number; sharedHub: boolean }>;
  };
  limbs: LimbCapability[];
  /** 共享枢纽域（G0 §3.3：S1-S5），任一命中即拒绝独占 */
  sharedHubs: string[];
  /** 装饰域输出 id 集（头发/裙摆/配饰——永不进白名单） */
  decorationOutputs: string[];
  builtAt: string;
}
