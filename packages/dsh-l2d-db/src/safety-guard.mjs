/**
 * dsh-l2d · Safety Guard 参数注入策略（双层安全边界，2026-11-05 用户裁决落地）
 *
 * 裁决依据（用户）：
 *  - Hard Boundary（parameters.min_value/max_value，moc3 作者定义理论边界）：
 *    硬性安全限幅，**绝不突破**；
 *  - Soft Motion Envelope（parameters.soft_min/soft_max，w3-registry 实测摆幅）：
 *    动作生成推荐范围；**实测范围不一定覆盖模型所有合法动作，故不作为硬性限制**；
 *  - 注入时优先遵循 Soft Envelope，但绝不突破 Hard Boundary；
 *  - 无 Hard 边界证据的参数：拒绝注入（fail-closed），只允许只读监测。
 *
 * 本模块为纯逻辑（无 I/O），供：
 *  - Phase 3 运行时探针（tools/runtime-probe/safety-guard.mjs 的判定核心）；
 *  - Action Executor 注入前逐帧校验；
 *  - 单元测试（tools/ 或 packages 测试）。
 */

/**
 * 解析某参数行的注入窗口。
 * @param {{min_value: number|null, max_value: number|null, soft_min: number|null, soft_max: number|null}} paramRow
 * @returns {{ hard: [number, number] | null, soft: [number, number] | null }}
 */
export function resolveInjectionWindow(paramRow) {
  if (!paramRow) return { hard: null, soft: null };
  const hard = paramRow.min_value !== null && paramRow.max_value !== null
    ? [paramRow.min_value, paramRow.max_value]
    : null;
  const soft = paramRow.soft_min !== null && paramRow.soft_max !== null && paramRow.soft_min <= paramRow.soft_max
    ? [paramRow.soft_min, paramRow.soft_max]
    : null;
  return { hard, soft };
}

/**
 * 单值注入判定（双层边界核心）。
 *
 * 判定规则：
 *  1. 无 Hard 边界           → ok:false, code:'NO_HARD_BOUNDARY'（fail-closed，只读监测）
 *  2. v 突破 Hard（任一侧）   → ok:false, code:'HARD_BOUNDARY_VIOLATION'（绝不注入）
 *  3. Hard 内、超 Soft       → ok:true,  layer:'soft_exceeded'（非 strict 放行并记录；
 *                               strict 模式 clamp 到 Soft 最近边界，动作生成默认 strict）
 *  4. Soft 内                → ok:true,  layer:'soft'
 *  5. 无 Soft（仅 Hard）     → ok:true,  layer:'hard_only'
 *
 * @param {object} paramRow 参数行（含双层边界）
 * @param {number} value 期望注入值
 * @param {{ strict?: boolean }} opts strict=true 时超 Soft 值被 clamp 到 Soft 边界
 * @returns {{ ok: boolean, code: string, layer: string, value: number,
 *             suggestedValue: number|null, hard: [number,number]|null, soft: [number,number]|null }}
 */
export function checkInjection(paramRow, value, { strict = false } = {}) {
  const { hard, soft } = resolveInjectionWindow(paramRow);
  const base = { hard, soft, value };

  if (!hard) {
    return { ...base, ok: false, code: 'NO_HARD_BOUNDARY', layer: 'none', suggestedValue: null,
      message: '无 Hard 边界证据（min/max 缺失），拒绝注入（fail-closed）；如需注入先补证据' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ...base, ok: false, code: 'INVALID_VALUE', layer: 'none', suggestedValue: null,
      message: `注入值非法：${value}` };
  }
  if (value < hard[0] || value > hard[1]) {
    return { ...base, ok: false, code: 'HARD_BOUNDARY_VIOLATION', layer: 'hard_violation', suggestedValue: null,
      message: `值 ${value} 突破 Hard 边界 [${hard[0]}, ${hard[1]}]，绝不注入` };
  }
  if (soft && (value < soft[0] || value > soft[1])) {
    const suggested = value < soft[0] ? soft[0] : soft[1];
    if (strict) {
      return { ...base, ok: true, code: 'SOFT_CLAMPED', layer: 'soft_clamped', value: suggested, suggestedValue: suggested,
        message: `值 ${value} 超 Soft Envelope [${soft[0]}, ${soft[1]}]，strict 模式 clamp 至 ${suggested}（Hard 未突破）` };
    }
    return { ...base, ok: true, code: 'SOFT_EXCEEDED', layer: 'soft_exceeded', suggestedValue: suggested,
      message: `值 ${value} 在 Hard 内但超 Soft Envelope [${soft[0]}, ${soft[1]}]（放行，建议 ${suggested}）；记录供审计` };
  }
  if (soft) {
    return { ...base, ok: true, code: 'OK', layer: 'soft', suggestedValue: null };
  }
  return { ...base, ok: true, code: 'OK', layer: 'hard_only', suggestedValue: null,
    message: '无 Soft Envelope，仅 Hard 约束' };
}

/**
 * 动作通道批量校验（Action Executor 每步预检）。
 * @param {Array<{paramId: string, value: number}>} injections
 * @param {(paramId: string) => object} lookupParamRow 由调用方注入查询（避免本模块依赖 db）
 * @returns {{ ok: boolean, violations: Array, results: Array }} 任一 HARD 违规 → 整批拒绝（原子性）
 */
export function checkInjectionBatch(injections, lookupParamRow, opts = {}) {
  const results = [];
  const violations = [];
  for (const inj of injections) {
    const row = lookupParamRow(inj.paramId);
    const r = checkInjection(row, inj.value, opts);
    results.push({ paramId: inj.paramId, ...r });
    if (!r.ok) violations.push({ paramId: inj.paramId, code: r.code, message: r.message });
  }
  return { ok: violations.length === 0, violations, results };
}
