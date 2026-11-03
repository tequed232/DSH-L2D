/**
 * E1 · 语义姿态 → 参数写入计划。
 *
 * 这一层只做三件事：
 *   1. 把归一化语义值（-1..1）解析成**具体参数写入**，参数 id 全部来自 CapabilityProfile，
 *      不在代码里写死任何模型参数名；
 *   2. 对 status 不可用的通道**显式降级**（skipped + reason），绝不"猜一个参数凑合写"；
 *   3. 标出 ownership：命中物理输出的写入必须先 own，否则会被 physics 覆盖。
 *
 * 它**不写参数**。真正的写入仍然走 ParamMixer / param-injector / ownership，
 * 这一层只产出"写什么、写到哪、什么相位、要不要 own"。
 */
import type { ModelMotionProfile, SemanticControlCapability } from './motion-contract.ts';

export interface SemanticWrite {
  channel: string;
  /** profile 里的 sourceId，可能是 `A+B` 形式的组合 */
  sourceId: string;
  params: { id: string; value: number }[];
  ownership: 'direct' | 'requires-own';
  /** 物理输出写 post（physics 之后胜出）；输入类写 pre */
  phase: 'pre' | 'post';
  status: 'supported' | 'approximate';
}

export interface SkippedChannel {
  channel: string;
  status: string;
  reason: string;
}

export interface PosturePlan {
  writes: SemanticWrite[];
  /** 需要先 own 的参数 id（去重） */
  owns: string[];
  skipped: SkippedChannel[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function findControl(profile: ModelMotionProfile | null | undefined, id: string): SemanticControlCapability | null {
  if (!profile || !Array.isArray(profile.controls)) return null;
  return profile.controls.find((c) => c.id === id) || null;
}

/**
 * 把一组语义通道值解析成写入计划。
 *
 * @param profile 模型能力画像（来自 tools/capability-scan）
 * @param values  通道 → 归一化值（-1..1）；不在 profile 里的通道会被 skipped
 */
export function planSemanticPosture(
  profile: ModelMotionProfile | null | undefined,
  values: Record<string, number>,
): PosturePlan {
  const plan: PosturePlan = { writes: [], owns: [], skipped: [] };

  for (const [channel, raw] of Object.entries(values || {})) {
    const control = findControl(profile, channel);
    if (!control) {
      plan.skipped.push({ channel, status: 'unknown', reason: 'profile 里没有这个通道，按 fail-closed 跳过' });
      continue;
    }
    if (control.status === 'unsupported' || control.status === 'unknown') {
      plan.skipped.push({
        channel,
        status: control.status,
        reason: control.reason || (control.status === 'unsupported' ? '模型不支持该能力' : '能力未知，禁止写入'),
      });
      continue;
    }
    if (!control.sourceId) {
      plan.skipped.push({ channel, status: control.status, reason: '能力已标记可用但没有 sourceId，适配器无法落地' });
      continue;
    }
    const value = clamp(Number(raw) || 0, control.min, control.max);
    const ids = control.sourceId.split('+').map((s) => s.trim()).filter(Boolean);
    // 组合通道：把同一个归一化值分给每个成员参数，由适配器按各自量程换算。
    // 这不追求解剖学精确，只保证「收缩方向一致、幅度可控」，并在 status 里标 approximate。
    const params = ids.map((id) => ({ id, value }));

    plan.writes.push({
      channel,
      sourceId: control.sourceId,
      params,
      ownership: control.ownership === 'requires-own' ? 'requires-own' : 'direct',
      phase: control.ownership === 'requires-own' ? 'post' : 'pre',
      status: control.status === 'approximate' ? 'approximate' : 'supported',
    });

    if (control.ownership === 'requires-own') {
      for (const id of ids) if (!plan.owns.includes(id)) plan.owns.push(id);
    }
  }

  return plan;
}

/** 便捷封装：只想知道某通道能不能写。 */
export function canExpress(profile: ModelMotionProfile | null | undefined, channel: string): boolean {
  const c = findControl(profile, channel);
  return !!c && (c.status === 'supported' || c.status === 'approximate') && !!c.sourceId;
}
