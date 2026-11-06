/**
 * Action Plan 编译（纯函数）：动作链 + 语义通道 → 运行时关键帧轨道。
 *
 * 从 tools/runtime-probe/run-action.mjs L57-112 原样抽出（零语义改动），便于
 * 单测与上游调用缓存（action-cache.mjs）复用。职责：
 *  1. 语义轨道名 → snake_case 通道名，经 Model Adapter 解析出的通道映射取参数；
 *  2. 归一化通道值空间 [-1,1] → 按每个参数的 Hard 范围（SQLite parameters 注册表）
 *     线性缩放：v → min + ((v·weight)+1)/2 × (max−min)；权重乘在归一化值上（缩放前）；
 *  3. Safety Guard：全部轨道极值预检（原子性，任一硬违规 → 整批拒绝）；
 *  4. 无通道映射 / 无 Hard 范围证据的轨道 → 如实 SKIP 留痕，不猜测。
 *
 * 纯函数约定：不碰 db、不碰 DOM、不 console、不 process.exit——guard 违规以
 * guardViolation 返回，由调用方决定回执与退出码。
 */

import { checkInjectionBatch } from './safety-guard.mjs';

/** camelCase 轨道名 → snake_case 通道名（tailSway ↔ tail_sway） */
export function trackToChannel(track) {
  return track.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * 编译动作链为运行时计划。
 * @param chain 解析后的动作链 JSON（含 steps）
 * @param channels Model Adapter resolveMotionParams 输出的通道映射（channel → entries）
 * @param paramRanges (paramId) => 参数行（含 min_value/max_value）| null
 * @returns {{ plans: Array, skips: Array, guardViolation: {step,track,violations}|null }}
 */
export function compileActionPlan(chain, channels, paramRanges) {
  const skips = [];
  const plans = []; // { track, channel, entries:[{paramId, weight, keys:[[t,v]]}] }
  for (const step of chain.steps ?? []) {
    if (step.kind === 'expression') {
      skips.push({ step: step.step_index, kind: 'expression', semantic: step.params?.semantic, reason: '表情语义无 adapter 通道/无 Expression 绑定——如实跳过，不猜测' });
      continue;
    }
    if (step.kind !== 'keyframes') { skips.push({ step: step.step_index, kind: step.kind, reason: '未知 step kind' }); continue; }
    const track = step.params?.track;
    const chName = trackToChannel(track ?? '');
    const entries = channels[chName];
    if (!entries) { skips.push({ step: step.step_index, kind: 'keyframes', track, reason: `无通道映射 ${chName}（adapter 未绑定）——如实跳过` }); continue; }
    const keys = (step.params?.keys ?? []).map((k) => [k.t, k.value]);
    if (!keys.length) { skips.push({ step: step.step_index, track, reason: '空 keys' }); continue; }
    // Parameter Resolver：通道值空间为归一化 [-1,1]（MOTION-DATA-SCHEMA 约定），
    // 按每个参数的 Hard 范围（SQLite 注册表）线性缩放：v → min + (v+1)/2 × (max-min)。
    // 权重乘在归一化值上（缩放前），保证多段级联幅值按权重衰减。
    const entriesResolved = entries.map((e) => {
      const row = paramRanges(e.paramId);
      if (!row || row.min_value === null || row.max_value === null) return null;
      return {
        param: e.paramId,
        weight: e.weight ?? 1,
        min: row.min_value,
        max: row.max_value,
        keys: keys.map(([t, v]) => {
          const nv = Math.max(-1, Math.min(1, v * (e.weight ?? 1)));
          return [t, row.min_value + ((nv + 1) / 2) * (row.max_value - row.min_value)];
        }),
      };
    });
    if (entriesResolved.some((e) => e === null)) {
      skips.push({ step: step.step_index, track, reason: '通道内参数无 Hard 范围证据——guard fail-closed，跳过' });
      continue;
    }
    const extremes = keys.map(([, v]) => v);
    const batch = entries.map((e) => {
      const row = paramRanges(e.paramId);
      const nv = Math.max(-1, Math.min(1, Math.max(...extremes) * (e.weight ?? 1)));
      return { paramId: e.paramId, value: row.min_value + ((nv + 1) / 2) * (row.max_value - row.min_value) };
    });
    const guardResult = checkInjectionBatch(batch, paramRanges, { strict: true });
    if (!guardResult.ok) {
      return { plans, skips, guardViolation: { step: step.step_index, track, violations: guardResult.violations } };
    }
    plans.push({
      step: step.step_index, track, channel: chName,
      tracks: entriesResolved.map((e) => ({ param: e.param, keys: e.keys })),
      durationMs: step.duration_ms ?? Math.max(...keys.map(([t]) => t)),
    });
  }
  return { plans, skips, guardViolation: null };
}
