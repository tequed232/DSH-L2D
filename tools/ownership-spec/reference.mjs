/**
 * Ownership spec 参考实现（仅作契约演示/测试基准，不进入渲染运行路径）。
 *
 * 实现者（L2D调试员）在 `packages/renderer/src/app/write-plan.ts` 实现同语义；
 * `tools/ownership-spec/run.mjs` 会用 `cases.mjs` 跑这份参考实现与你的实现。
 *
 * 语义见 docs/Ownership-Invariants.md 与 docs/Embodied-Behavior.md。
 */

/** 口型禁区：任何通道、任何 owner 都不许写。 */
export const LIPSYNC = new Set(['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm']);

/** 四肢骨参数（默认 physics-owned；acquire 后 limb 可写）。 */
export const LIMB_PARAMS = new Set([
  'RArm', 'RForearm', 'RWrist', 'RHand', 'RHand2',
  'LArm', 'LForearm', 'LWrist', 'LHand', 'LHand2',
  'ShoulderY', 'ShoulderZ',
  'HipAngleX', 'HipAngleX2', 'HipAngleY', 'HipAngleZ',
  'ParamHipAngleZ', 'ParamHipAngleZ2', 'LEGAngleZ2',
  'HipZ1', 'HipZ2', 'HipAngleYDOWN', 'HipAngleYUP',
]);

/** Hip 三兄弟：被次级物理消费（chained），只允许 pre 相位（配合 producer-yield）。 */
export const HIP_CHAINED = new Set(['HipAngleX', 'HipAngleY', 'HipAngleZ']);

/** 物理根输入：必须 pre 相位。 */
export const PRE_ONLY = new Set([
  'AngleX', 'AngleY', 'AngleZ',
  'PositionX', 'PositionY', 'PositionZ',
  'LeanInput', 'Movement1', 'Movement2', 'Movement3',
  ...HIP_CHAINED,
]);

/** 同优先级下的 source 秩（越大越晚、越强）。 */
export const SOURCE_RANK = {
  physics: 0,
  continuous: 1,
  ambient: 1,
  motion: 2,
  keyframes: 3,
  pose: 4,
  gaze: 5,
  limb: 6,
};

const VALID_SOURCES = new Set(Object.keys(SOURCE_RANK));

function isValidIntent(intent) {
  return Boolean(
    intent &&
      typeof intent === 'object' &&
      typeof intent.id === 'string' &&
      typeof intent.source === 'string' &&
      VALID_SOURCES.has(intent.source) &&
      typeof intent.params === 'object' &&
      intent.params !== null &&
      (intent.priority === 10 || intent.priority === 50 || intent.priority === 90) &&
      (intent.phase === 'pre' || intent.phase === 'post'),
  );
}

function preferredPhase(id) {
  return PRE_ONLY.has(id) ? 'pre' : 'post';
}

function activeOwnerOf(ownership, id, now) {
  const entry = ownership[id];
  if (!entry || !entry.owner) return null;
  if (entry.expiresAt != null && Number(entry.expiresAt) <= now) return null;
  return entry;
}

/**
 * 每参数唯一 winner。
 * @param {{now:number, intents:Array, ownership?:object, physics?:object,
 *          bounds?:object, knownParams?:string[], limbEnabled?:boolean}} input
 */
export function resolveWritePlan(input = {}) {
  const now = Number(input.now) || Date.now();
  const intents = Array.isArray(input.intents) ? input.intents : [];
  const ownership = input.ownership && typeof input.ownership === 'object' ? input.ownership : {};
  const physics = input.physics && typeof input.physics === 'object' ? input.physics : {};
  const bounds = input.bounds && typeof input.bounds === 'object' ? input.bounds : null;
  const known = Array.isArray(input.knownParams) ? new Set(input.knownParams) : null;
  const limbEnabled = input.limbEnabled !== false;

  const rejected = [];
  const reject = (id, source, reason) => rejected.push({ id, source, reason });

  // 1) 收集合法候选：每个 (id, source) 只保留最后一条 intent（同帧 last-write-wins）。
  const candidates = new Map(); // id -> Map<source, {priority, value, order}>
  let order = 0;
  for (const intent of intents) {
    if (!isValidIntent(intent)) continue;
    for (const [id, rawValue] of Object.entries(intent.params)) {
      order++;
      if (LIPSYNC.has(id)) {
        reject(id, intent.source, 'lipsync');
        continue;
      }
      if (known && !known.has(id)) {
        reject(id, intent.source, 'unknown-param');
        continue;
      }
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        reject(id, intent.source, 'invalid-value');
        continue;
      }
      const entry = limbEnabled ? activeOwnerOf(ownership, id, now) : null;
      const isLimbParam = LIMB_PARAMS.has(id);
      const hasPhysicsValue = Object.prototype.hasOwnProperty.call(physics, id);

      if (entry && entry.owner === 'limb') {
        // 独占：只有 limb 能写；相位按参数族；runId 必须匹配。
        if (intent.source !== 'limb') {
          reject(id, intent.source, 'not-owned');
          continue;
        }
        if (entry.runId !== undefined && intent.runId !== entry.runId) {
          reject(id, intent.source, 'not-owned');
          continue;
        }
        if (intent.phase !== preferredPhase(id)) {
          reject(id, intent.source, 'wrong-phase');
          continue;
        }
      } else if (intent.source === 'limb') {
        // 未 acquire 的 limb 写入一律拒绝（limb 只写自己的参数且必须先 acquire）。
        reject(id, intent.source, 'not-owned');
        continue;
      } else if (isLimbParam || hasPhysicsValue) {
        // 默认 physics-owned：其他 source 不得写物理输出/四肢参数。
        reject(id, intent.source, 'not-owned');
        continue;
      }
      // 非物理参数：相位固定（pre 只给根输入，其余 post）。
      if (intent.phase !== preferredPhase(id)) {
        reject(id, intent.source, 'wrong-phase');
        continue;
      }
      if (!candidates.has(id)) candidates.set(id, new Map());
      candidates.get(id).set(intent.source, {
        priority: intent.priority,
        value: rawValue,
        order,
      });
    }
  }

  // 2) 逐参数选 winner：priority desc → source 秩 desc → 同 source 后者（order 大）。
  const writes = [];
  const written = new Set();
  for (const [id, bySource] of candidates) {
    let best = null;
    for (const [source, cand] of bySource) {
      const rank = SOURCE_RANK[source];
      if (
        !best ||
        cand.priority > best.priority ||
        (cand.priority === best.priority && rank > best.rank) ||
        (cand.priority === best.priority && rank === best.rank && cand.order > best.order)
      ) {
        best = { source, rank, priority: cand.priority, value: cand.value, order: cand.order };
      }
    }
    if (!best) continue;
    let value = best.value;
    const b = bounds ? bounds[id] : null;
    if (b && Number.isFinite(Number(b.min)) && Number.isFinite(Number(b.max))) {
      value = Math.max(Number(b.min), Math.min(Number(b.max), value));
    }
    writes.push({ id, value, source: best.source, phase: preferredPhase(id) });
    written.add(id);
  }

  // 3) 未被任何 intent 覆盖、且未被 limb 独占的 physics 值，按 physics-owned 输出。
  for (const [id, value] of Object.entries(physics)) {
    if (written.has(id)) continue;
    if (LIPSYNC.has(id)) continue;
    if (limbEnabled && activeOwnerOf(ownership, id, now)) continue; // 独占期间物理让位
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    writes.push({ id, value, source: 'physics', phase: preferredPhase(id) });
  }

  writes.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => (a.id + '|' + a.source + '|' + a.reason).localeCompare(b.id + '|' + b.source + '|' + b.reason));
  return { writes, rejected };
}
