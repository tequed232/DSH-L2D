import { DEFAULT_GATE, STEP_KINDS, estimateLifeMs, validateStep } from '../../dsh-l2d-plugin/lib/choreography.mjs';

export const MAX_SEGMENTS = 15;
export const MAX_STEPS_PER_SEGMENT = 8;
export const MAX_BUBBLE_LENGTH = 40;
export const DEFAULT_QUEUE_WAIT_MS = 15000;
export const DEFAULT_QUEUE_RETRY_MS = 120;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pack adjacent compatible segments into one renderer call (max 8 steps).
 * This reduces MCP round-trips while preserving FIFO order and priority boundaries.
 */
export function coalesceActionSegments(segments) {
  const batches = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const priority = segment.priority || 'NORMAL';
    const bubble = segment.bubble || undefined;
    let batch = batches[batches.length - 1];
    const combinedChain = batch ? [...batch.chain, ...segment.chain] : segment.chain;
    if (!batch || batch.priority !== priority || batch.bubble !== bubble ||
        combinedChain.length > MAX_STEPS_PER_SEGMENT ||
        estimateLifeMs(combinedChain) > DEFAULT_GATE.maxLifeMs) {
      batch = { priority, ...(bubble ? { bubble } : {}), chain: [], sourceSegments: [] };
      batches.push(batch);
    }
    batch.chain.push(...segment.chain);
    batch.sourceSegments.push(index);
  }
  return batches;
}

const QUEUEABLE_REJECTIONS = new Set(['conflict', 'priority-blocked']);

/**
 * Execute a FIFO sequence. A transient admission rejection is queued locally and
 * retried without submitting later segments. Accepted-but-pending calls are never
 * replayed: doing so could duplicate a motion that is still running.
 */
export async function executeActionSequence(input, execute, options = {}) {
  const validation = validateActionSequence(input);
  if (!validation.ok) return { ok: false, status: 'rejected', reason: 'invalid-sequence', errors: validation.errors, receipts: [], replanRequired: false };
  const maxQueueWaitMs = Math.max(0, Number(options.maxQueueWaitMs ?? DEFAULT_QUEUE_WAIT_MS));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? DEFAULT_QUEUE_RETRY_MS));
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  const receipts = [];

  const batches = coalesceActionSegments(input.segments);
  let completedSegments = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const segment = batches[batchIndex];
    const queuedAt = now();
    let receipt;
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        receipt = await execute({
          chain: segment.chain,
          priority: segment.priority,
          ...(segment.bubble ? { bubble: segment.bubble } : {}),
        });
      } catch (error) {
        receipt = { ok: false, reason: 'execution-error', detail: String(error?.message || error) };
      }

      const reason = receipt?.reason || receipt?.outcome;
      const notAccepted = !receipt || receipt.accepted !== true;
      if (!notAccepted || !QUEUEABLE_REJECTIONS.has(reason)) break;
      const elapsed = now() - queuedAt;
      if (elapsed >= maxQueueWaitMs) break;
      await wait(Math.min(retryDelayMs, Math.max(0, maxQueueWaitMs - elapsed)));
    }

    receipts.push({ batch: batchIndex, sourceSegments: segment.sourceSegments, attempts, receipt });
    if (!receipt || receipt.accepted !== true || receipt.outcome !== 'completed') {
      const reason = receipt?.reason || receipt?.outcome || 'execution-incomplete';
      return {
        ok: false, status: 'stopped', reason, receipts, completedSegments,
        remainingSegments: input.segments.length - completedSegments,
        replanRequired: ['conflict', 'priority-blocked', 'interrupted', 'pending'].includes(reason) ||
          receipt?.outcome === 'interrupted' || receipt?.outcome === 'pending',
      };
    }
    completedSegments += segment.sourceSegments.length;
  }
  return { ok: true, status: 'completed', receipts, completedSegments, remainingSegments: 0, replanRequired: false };
}
