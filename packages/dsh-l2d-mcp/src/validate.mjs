/**
 * MCP 工具参数白名单（M1 契约，见 docs/Embodied-Behavior.md §7）。
 *
 * 原则：能静态判定的错误在 MCP 层就拒绝，不把无效请求转发给渲染端；
 * 渲染端仍保留运行时校验（ownership / 物理输出表），这里是第一道闸。
 *
 * 覆盖：
 *  - 未索引表情名 / 动作组名（动作组以 choreography.mjs 的模型索引为准；Idle 不允许外部手动播）
 *  - 动作链每步的结构与取值范围（复用 choreography.validateStep）
 *  - 口型参数名（任何工具入参出现即拒绝）
 */
import {
  MODEL_EXPRESSIONS,
  MODEL_MOTION_GROUPS,
  validateStep,
} from '../../dsh-l2d-plugin/lib/choreography.mjs';
import { collectReservedParams } from '../../dsh-l2d-plugin/lib/param-guards.mjs';

export const ALLOWED_EXPRESSIONS = Object.freeze([...MODEL_EXPRESSIONS]);
export const PLAYABLE_MOTION_GROUPS = Object.freeze([...MODEL_MOTION_GROUPS]);

const EXPRESSION_SET = new Set(ALLOWED_EXPRESSIONS);
const MOTION_SET = new Set(PLAYABLE_MOTION_GROUPS);

/** @returns {{ok:true}|{ok:false, reason:string, name?:string, allowed:string[]}} */
export function validateExpressionName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, reason: 'empty-expression', allowed: ALLOWED_EXPRESSIONS };
  }
  if (!EXPRESSION_SET.has(name)) {
    return { ok: false, reason: 'unknown-expression', name, allowed: ALLOWED_EXPRESSIONS };
  }
  return { ok: true };
}

/**
 * 动作组白名单。Idle 只由引擎在动作队列空闲时自动重启，外部手动播会和引擎抢同一组，
 * 因此这里明确拒绝（不是遗漏）。
 */
export function validateMotionGroup(group) {
  if (typeof group !== 'string' || !group.trim()) {
    return { ok: false, reason: 'empty-motion-group', allowed: PLAYABLE_MOTION_GROUPS };
  }
  if (!MOTION_SET.has(group)) {
    return { ok: false, reason: 'unknown-motion-group', group, allowed: PLAYABLE_MOTION_GROUPS };
  }
  return { ok: true };
}

/**
 * 动作链校验：结构/名字/范围 + 口型守卫。
 * @param {Array} chain
 * @returns {{ok:boolean, errors:string[], reserved:string[]}}
 */
export function validateActChain(chain) {
  const errors = [];
  if (chain !== undefined && !Array.isArray(chain)) {
    return { ok: false, errors: ['chain 必须是数组'], reserved: [] };
  }
  const steps = Array.isArray(chain) ? chain : [];
  for (let i = 0; i < steps.length; i++) {
    const result = validateStep(steps[i], i);
    errors.push(...(result.errors || []));
  }
  const reserved = collectReservedParams(steps);
  if (reserved.length) errors.push('动作链不得包含口型参数：' + reserved.join(', '));
  return { ok: errors.length === 0, errors, reserved };
}

/** 任意工具入参的口型扫描（防御性，未来新增工具同样适用）。 */
export function findReservedParams(args) {
  return collectReservedParams(args);
}
