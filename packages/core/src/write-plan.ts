/**
 * 所有权写计划仲裁（docs/Ownership-Invariants.md §1 契约 / §2 INV 不变量的纯函数实现）。
 *
 * 目标：把「每参数每帧唯一 winner」做成纯函数，先用单测锁死语义，再接进渲染循环。
 * 语义基准是可执行 spec `tools/ownership-spec/reference.mjs`（25 用例 + run.mjs 跨验），
 * 本文件与其逐行为对齐；参数族名单（口型/四肢/Hip）来自 spec 与
 * docs/Embodied-Behavior.md §3 参数所有权矩阵，模型差异不允许写进这里。
 *
 * feature flag：`M1_DEFAULT_ENABLED = false`——所有 M1 行为变化必须由调用方显式启用；
 * 本函数的 limbEnabled 语义是纯仲裁语义（缺省 true，见 CASE-23 显式传 false），
 * 运行路径默认关闭由 LimbController / 渲染层调用方尊重 M1_DEFAULT_ENABLED 实现。
 */
import { PRE_ONLY_PARAMS } from './motion-intent.ts';
import { SEMANTIC_SOURCE_RANK, type SemanticPriority, type SemanticSource, type WritePhase } from './motion-contract.ts';

/** M1 统一 feature flag：默认关闭 = 现行为（M1-a 回滚要求）。 */
export const M1_DEFAULT_ENABLED = false;

/** 口型禁区：任何通道、任何 owner 都不许写。与 core index.ts 的 LIPSYNC_PARAMS 同名单。 */
export const LIPSYNC_PARAM_SET: ReadonlySet<string> = new Set(['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm']);

/**
 * 四肢骨参数（23 个，默认 physics-owned；acquire 后 limb 可写）。
 * 名单来源：docs/Embodied-Behavior.md §3「四肢骨参数」行 = 可执行 spec 同一份。
 */
export const LIMB_BONE_PARAMS: ReadonlySet<string> = new Set([
  'RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2',
  'LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2',
  'ShoulderY', 'ShoulderZ',
  'HipAngleX', 'HipAngleX2', 'HipAngleY', 'HipAngleZ',
  'ParamHipAngleZ', 'ParamHipAngleZ2', 'LEGAngleZ2',
  'HipZ1', 'HipZ2', 'HipAngleYDOWN', 'HipAngleYUP',
]);

/** 同优先级下的 source 秩（越大越晚、越强）；physics 是最终兜底，秩 0。 */
export const WRITE_SOURCE_RANK: Record<WriteSource, number> = Object.freeze({
  physics: 0,
  ...SEMANTIC_SOURCE_RANK,
} as Record<WriteSource, number>);

export type WriteSource = 'physics' | SemanticSource;

export type RejectReason =
  | 'lipsync'          // 口型禁区：永不放行
  | 'not-owned'        // 非 owner 写他人参数
  | 'wrong-phase'      // 相位与参数族不匹配
  | 'invalid-value'    // 非有限数
  | 'unknown-param'
  | 'lower-priority';  // 同参数被更高优先级/更高 source 抢占

/** 与 docs/Ownership-Invariants.md §1 的 WriteIntent 形状一致（phase 可省略）。 */
export interface OwnershipWriteIntent {
  id: string;
  source: WriteSource;
  /** ActGate：BACKGROUND/NORMAL/FORCE。 */
  priority: SemanticPriority;
  /** 提供即权威；缺省用 ownership.phase → 参数族默认。 */
  phase?: WritePhase;
  params: Record<string, number>;
  /** 动作链 runId（limb/动作类）。 */
  runId?: string;
}

export interface OwnershipEntry {
  owner: WriteSource;
  runId?: string;
  expiresAt?: number;
  phase?: WritePhase;
}

export interface ResolveInput {
  now: number;
  intents: OwnershipWriteIntent[];
  ownership?: Record<string, OwnershipEntry>;
  /** 本帧物理输出（仅 physics-owned 参数采信）。 */
  physics?: Record<string, number>;
  /** 可选：模型参数范围。 */
  bounds?: Record<string, { min: number; max: number }>;
  /** 可选：不存在则视为未知参数。 */
  knownParams?: string[];
  /** limb 仲裁开关（纯函数语义缺省 true；运行路径由 M1_DEFAULT_ENABLED 门控）。 */
  limbEnabled?: boolean;
}

export interface WriteEntry {
  id: string;
  value: number;
  source: WriteSource;
  phase: WritePhase;
}

export interface RejectedWrite {
  id: string;
  source: WriteSource;
  reason: RejectReason;
}

export interface ResolveResult {
  /** 每个 id 至多一条（唯一 winner），按 id 稳定排序。 */
  writes: WriteEntry[];
  rejected: RejectedWrite[];
}

const VALID_SOURCES: ReadonlySet<string> = new Set(Object.keys(WRITE_SOURCE_RANK));
const VALID_PRIORITIES: ReadonlySet<number> = new Set([10, 50, 90]);

function isValidIntent(intent: unknown): intent is OwnershipWriteIntent {
  if (!intent || typeof intent !== 'object') return false;
  const it = intent as Partial<OwnershipWriteIntent>;
  return (
    typeof it.id === 'string' &&
    typeof it.source === 'string' &&
    VALID_SOURCES.has(it.source) &&
    typeof it.params === 'object' &&
    it.params !== null &&
    typeof it.priority === 'number' &&
    VALID_PRIORITIES.has(it.priority) &&
    (it.phase === undefined || it.phase === 'pre' || it.phase === 'post')
  );
}

/** 参数族默认相位：物理根输入（含 Hip 三兄弟）pre，其余 post（INV-7）。 */
function preferredPhase(id: string): WritePhase {
  return PRE_ONLY_PARAMS.has(id) ? 'pre' : 'post';
}

/** 未过期（未超时兜底）的 ownership 条目；过期视为已释放（INV-5）。 */
function activeOwnerOf(ownership: Record<string, OwnershipEntry>, id: string, now: number): OwnershipEntry | null {
  const entry = ownership[id];
  if (!entry || !entry.owner) return null;
  if (entry.expiresAt != null && Number(entry.expiresAt) <= now) return null;
  return entry;
}

/**
 * 每参数唯一 winner（确定性顺序见 docs/Embodied-Behavior.md §5）：
 * 1. 收集候选：每个 (paramId, source) 同帧只保留最后一条 intent（last-write-wins）；
 * 2. 过滤：lipsync → unknown-param → invalid-value → not-owned → wrong-phase；
 * 3. 相位：intent.phase → ownership.phase（仅独占时）→ 参数族默认；
 * 4. winner：priority desc → source 秩 desc → 同 source 后者；
 * 5. 钳制（可选 bounds）→ 按 id 稳定排序输出；
 * 6. physics 值仅在未被 intent 覆盖且未被 limb 独占时输出（physics-owned 兜底）。
 */
export function resolveWritePlan(input: ResolveInput): ResolveResult {
  const now = Number(input.now) || 0;
  const intents: OwnershipWriteIntent[] = Array.isArray(input.intents) ? input.intents : [];
  const ownership: Record<string, OwnershipEntry> =
    input.ownership && typeof input.ownership === 'object' ? input.ownership : {};
  const physics: Record<string, number> =
    input.physics && typeof input.physics === 'object' ? input.physics : {};
  const bounds: Record<string, { min: number; max: number }> | null =
    input.bounds && typeof input.bounds === 'object' ? input.bounds : null;
  const known: ReadonlySet<string> | null = Array.isArray(input.knownParams) ? new Set(input.knownParams) : null;
  const limbEnabled = input.limbEnabled !== false;

  const rejected: RejectedWrite[] = [];
  const reject = (id: string, source: WriteSource, reason: RejectReason) => rejected.push({ id, source, reason });

  // 1) 收集合法候选：每个 (id, source) 只保留最后一条 intent（同帧 last-write-wins）。
  const candidates = new Map<string, Map<WriteSource, { priority: number; value: number; order: number; phase: WritePhase }>>();
  let order = 0;
  for (const intent of intents) {
    if (!isValidIntent(intent)) continue;
    for (const [id, rawValue] of Object.entries(intent.params)) {
      order++;
      if (LIPSYNC_PARAM_SET.has(id)) {
        reject(id, intent.source, 'lipsync');            // INV-2
        continue;
      }
      if (known && !known.has(id)) {
        reject(id, intent.source, 'unknown-param');      // INV-10
        continue;
      }
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        reject(id, intent.source, 'invalid-value');      // INV-9
        continue;
      }
      const entry = limbEnabled ? activeOwnerOf(ownership, id, now) : null;
      const familyPhase = preferredPhase(id);
      const effectivePhase: WritePhase =
        intent.phase ?? (entry && entry.owner === 'limb' && entry.phase ? entry.phase : familyPhase);
      const isLimbParam = LIMB_BONE_PARAMS.has(id);
      const hasPhysicsValue = Object.prototype.hasOwnProperty.call(physics, id);

      if (entry && entry.owner === 'limb') {
        // 独占：只有 limb 能写；runId 必须匹配（R12）；相位按参数族（INV-7）。
        if (intent.source !== 'limb') {
          reject(id, intent.source, 'not-owned');        // INV-4
          continue;
        }
        if (entry.runId !== undefined && intent.runId !== entry.runId) {
          reject(id, intent.source, 'not-owned');        // CASE-10/24
          continue;
        }
        if (effectivePhase !== familyPhase) {
          reject(id, intent.source, 'wrong-phase');      // CASE-07/08
          continue;
        }
      } else if (intent.source === 'limb') {
        // 未 acquire 的 limb 写入一律拒绝（limb 只写四肢参数且必须先 acquire）。INV-3
        reject(id, intent.source, 'not-owned');
        continue;
      } else if (isLimbParam || hasPhysicsValue) {
        // 默认 physics-owned：其他 source 不得写物理输出/四肢参数。INV-3
        reject(id, intent.source, 'not-owned');
        continue;
      }
      // 非独占参数：相位同样按参数族（pre 只给根输入，其余 post）。INV-7
      if (effectivePhase !== familyPhase) {
        reject(id, intent.source, 'wrong-phase');
        continue;
      }
      if (!candidates.has(id)) candidates.set(id, new Map());
      candidates.get(id)!.set(intent.source as WriteSource, {
        priority: intent.priority,
        value: rawValue,
        order,
        phase: effectivePhase,
      });
    }
  }

  // 2) 逐参数选 winner：priority desc → source 秩 desc → 同 source 后者（order 大）。INV-1/6
  const writes: WriteEntry[] = [];
  const written = new Set<string>();
  for (const [id, bySource] of candidates) {
    let best: { source: WriteSource; rank: number; priority: number; value: number; order: number; phase: WritePhase } | null = null;
    for (const [source, cand] of bySource) {
      const rank = WRITE_SOURCE_RANK[source];
      if (
        !best ||
        cand.priority > best.priority ||
        (cand.priority === best.priority && rank > best.rank) ||
        (cand.priority === best.priority && rank === best.rank && cand.order > best.order)
      ) {
        best = { source, rank, priority: cand.priority, value: cand.value, order: cand.order, phase: cand.phase };
      }
    }
    if (!best) continue;
    let value = best.value;
    const b = bounds ? bounds[id] : undefined;
    if (b && Number.isFinite(Number(b.min)) && Number.isFinite(Number(b.max))) {
      value = Math.max(Number(b.min), Math.min(Number(b.max), value));   // INV-9
    }
    writes.push({ id, value, source: best.source, phase: best.phase || preferredPhase(id) });
    written.add(id);
  }

  // 3) 未被任何 intent 覆盖、且未被 limb 独占的 physics 值，按 physics-owned 输出（兜底）。INV-4/5
  for (const [id, value] of Object.entries(physics)) {
    if (written.has(id)) continue;
    if (LIPSYNC_PARAM_SET.has(id)) continue;
    if (limbEnabled && activeOwnerOf(ownership, id, now)) continue; // 独占期间物理让位
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    writes.push({ id, value, source: 'physics', phase: preferredPhase(id) });
  }

  // INV-8：输出按 id 稳定排序，与 intents 数组顺序无关。
  writes.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => (a.id + '|' + a.source + '|' + a.reason).localeCompare(b.id + '|' + b.source + '|' + b.reason));
  return { writes, rejected };
}
