/**
 * Dynamic Agent action planner contract.
 *
 * The model proposes intent; this module is the deterministic trust boundary.
 * It accepts only the four high-level action kinds already supported by the
 * choreography validator. Raw Cubism parameters/keyframes are deliberately
 * excluded from autonomous plans.
 */
import { estimateLifeMs, validateStep } from './choreography.mjs';

export const MAX_AGENT_PLAN_STEPS = 6;
export const MAX_AGENT_PLAN_LIFE_MS = 10000;
export const MAX_AGENT_PLAN_SEGMENTS = 3;

const POSES = new Set(['rest', 'finger', 'grass', 'chest']);
const STEP_KINDS = new Set(['expression', 'motion', 'pose', 'look']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Validate and copy an LLM proposal. Never repairs unknown names into a
 * different action: a malformed proposal is rejected and can be replanned.
 */
export function validateAgentPlan(raw, capabilities = {}) {
  const errors = [];
  if (!isObject(raw)) return { ok: false, errors: ['plan must be an object'] };
  if (!Array.isArray(raw.chain) || raw.chain.length === 0) {
    return { ok: false, errors: ['chain must contain at least one step'] };
  }
  if (raw.chain.length > MAX_AGENT_PLAN_STEPS) {
    errors.push(`chain exceeds ${MAX_AGENT_PLAN_STEPS} steps`);
  }

  const expressions = new Set(Array.isArray(capabilities.expressions) ? capabilities.expressions : []);
  const motions = new Set((Array.isArray(capabilities.motions) ? capabilities.motions : []).filter((name) => name !== 'Idle'));
  const chain = [];

  for (const [index, input] of raw.chain.slice(0, MAX_AGENT_PLAN_STEPS).entries()) {
    if (!isObject(input) || !STEP_KINDS.has(input.kind)) {
      errors.push(`chain[${index}] has unsupported kind`);
      continue;
    }
    const step = { ...input };
    if (step.kind === 'expression' && step.clear !== true && !expressions.has(step.name)) {
      errors.push(`chain[${index}] expression is not in model capabilities`);
      continue;
    }
    if (step.kind === 'motion' && !motions.has(step.name)) {
      errors.push(`chain[${index}] motion is not in model capabilities`);
      continue;
    }
    if (step.kind === 'pose') {
      if (!isObject(step.pose) || Object.keys(step.pose).length === 0 ||
          Object.keys(step.pose).some((side) => !['left', 'right'].includes(side) || !POSES.has(step.pose[side]))) {
        errors.push(`chain[${index}] pose is invalid`);
        continue;
      }
    }
    const result = validateStep(step, index);
    if (result.errors.length) {
      errors.push(...result.errors);
      continue;
    }
    chain.push(step);
  }

  if (chain.length !== raw.chain.length) errors.push('one or more steps were rejected');
  if (chain.length && estimateLifeMs(chain) > MAX_AGENT_PLAN_LIFE_MS) {
    errors.push(`estimated chain life exceeds ${MAX_AGENT_PLAN_LIFE_MS}ms`);
  }
  if (raw.bubble !== undefined && typeof raw.bubble !== 'string') errors.push('bubble must be a string');
  if (raw.continue !== undefined && typeof raw.continue !== 'boolean') errors.push('continue must be a boolean');
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    chain,
    bubble: boundedText(raw.bubble, 40),
    continue: raw.continue === true,
    rationale: boundedText(raw.rationale, 120),
  };
}

/**
 * Build bounded context for a single planning turn.
 *
 * Positioning: this is a local autonomous reactor, not a conversational planner.
 * It may see the plugin event (workspace state) and the previous execution receipt,
 * but never session transcripts, tool names or error text — persona/planning duties
 * belong to higher layers.
 */
export function buildAgentPlanContext(input = {}) {
  const receipt = isObject(input.receipt) ? input.receipt : null;
  return {
    state: boundedText(input.state, 32),
    segment: Math.max(1, Math.min(MAX_AGENT_PLAN_SEGMENTS, Number(input.segment) || 1)),
    previousRationale: boundedText(input.previousRationale, 120),
    receipt: receipt ? {
      outcome: boundedText(receipt.outcome || receipt.status || receipt.reason, 40),
      reason: boundedText(receipt.reason || receipt.error, 120),
      notes: Array.isArray(receipt.notes) ? receipt.notes.slice(0, 4).map((x) => boundedText(String(x), 80)) : [],
    } : null,
  };
}
