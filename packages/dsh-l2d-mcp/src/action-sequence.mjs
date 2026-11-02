import { DEFAULT_GATE, STEP_KINDS, estimateLifeMs, validateStep } from '../../dsh-l2d-plugin/lib/choreography.mjs';
export const MAX_SEGMENTS = 3;
export const MAX_STEPS_PER_SEGMENT = 8;
export const MAX_BUBBLE_LENGTH = 40;

export function validateActionSequence(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['sequence 必须是对象'] };
  if (!Array.isArray(input.segments) || input.segments.length === 0) return { ok: false, errors: ['segments 不能为空'] };
  if (input.segments.length > MAX_SEGMENTS) errors.push(`segments 最多 ${MAX_SEGMENTS} 段`);
  input.segments.slice(0, MAX_SEGMENTS).forEach((segment, segmentIndex) => {
    const at = `segments[${segmentIndex}]`;
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) { errors.push(`${at} 必须是对象`); return; }
    for (const key of Object.keys(segment)) if (!['chain', 'priority', 'bubble'].includes(key)) errors.push(`${at} 未知字段 ${key}`);
    if (!['BACKGROUND', 'NORMAL', 'FORCE'].includes(segment.priority || 'NORMAL')) errors.push(`${at}.priority 非法`);
    if (segment.bubble !== undefined && (typeof segment.bubble !== 'string' || segment.bubble.length > MAX_BUBBLE_LENGTH)) errors.push(`${at}.bubble 最多 ${MAX_BUBBLE_LENGTH} 字符`);
    if (!Array.isArray(segment.chain) || segment.chain.length === 0) { errors.push(`${at}.chain 不能为空`); return; }
    if (segment.chain.length > MAX_STEPS_PER_SEGMENT) errors.push(`${at}.chain 最多 ${MAX_STEPS_PER_SEGMENT} 步`);
    segment.chain.slice(0, MAX_STEPS_PER_SEGMENT).forEach((step, stepIndex) => {
      if (step && !STEP_KINDS.includes(step.kind)) { errors.push(`${at}.chain[${stepIndex}] kind 不受支持`); return; }
      const result = validateStep(step, stepIndex);
      errors.push(...result.errors.map((message) => `${at}: ${message}`));
    });
    const lifeMs = estimateLifeMs(segment.chain);
    if (lifeMs > DEFAULT_GATE.maxLifeMs) errors.push(`${at} 估算时长 ${lifeMs}ms 超过上限 ${DEFAULT_GATE.maxLifeMs}ms`);
  });
  return { ok: errors.length === 0, errors };
}

export async function executeActionSequence(input, execute) {
  const validation = validateActionSequence(input);
  if (!validation.ok) return { ok: false, status: 'rejected', reason: 'invalid-sequence', errors: validation.errors, receipts: [], replanRequired: false };
  const receipts = [];
  for (let index = 0; index < input.segments.length; index += 1) {
    const segment = input.segments[index];
    let receipt;
    try {
      receipt = await execute({ chain: segment.chain, priority: segment.priority || 'NORMAL', ...(segment.bubble ? { bubble: segment.bubble } : {}) });
    } catch (error) {
      receipt = { ok: false, reason: 'execution-error', detail: String(error?.message || error) };
    }
    receipts.push({ segment: index, receipt });
    if (!receipt || receipt.accepted !== true || receipt.outcome !== 'completed') {
      const reason = receipt?.reason || receipt?.outcome || 'execution-incomplete';
      return {
        ok: false, status: 'stopped', reason, receipts, completedSegments: index,
        remainingSegments: input.segments.length - index - 1,
        replanRequired: ['conflict', 'priority-blocked', 'interrupted', 'pending'].includes(reason) ||
          receipt?.outcome === 'interrupted' || receipt?.outcome === 'pending',
      };
    }
  }
  return { ok: true, status: 'completed', receipts, completedSegments: receipts.length, remainingSegments: 0, replanRequired: false };
}
