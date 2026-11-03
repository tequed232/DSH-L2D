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

/**
 * W3 语义约束在画像里的落地字段（扫描器 tools/capability-scan/w3-controls.mjs 产出）：
 *   - `kind`：W3 条目类型（motion-pair / motion-loop / pose / gaze / body / expression）；
 *   - `conflicts`：与本通道互斥的其它通道 id（`ext.` 前缀，可含 `x.*` 通配），
 *     由登记表按「成对动作只看姿态骨、共用光效/待机参数不参与冲突」「眼睛族互斥」
 *     「gaze 与前倾同写 LeanInput」派生。
 * 字段是画像的新增内容（schema 只加不改），契约接口不感知。
 */
interface W3ControlFields {
  kind?: string;
  conflicts?: readonly string[];
}
type ResolvedControl = SemanticControlCapability & W3ControlFields;

function normalizeExtId(id: string): string {
  return id.startsWith('ext.') ? id : 'ext.' + id;
}

function findControl(profile: ModelMotionProfile | null | undefined, id: string): ResolvedControl | null {
  if (!profile || !Array.isArray(profile.controls)) return null;
  const exact = profile.controls.find((c) => c && c.id === id);
  if (exact) return exact as ResolvedControl;
  // W3 通道在画像里带 ext. 前缀；允许用清单原始 id（gesture.grass）查询
  if (!id.startsWith('ext.')) {
    const ext = profile.controls.find((c) => c && c.id === 'ext.' + id);
    if (ext) return ext as ResolvedControl;
  }
  return null;
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

/**
 * 语义约束上下文（W3「语义约束」节）。
 * - `active`：当前已打开/持有的通道 id（`gesture.grass` 或 `ext.gesture.grass` 均可）；
 * - `motionPlaying`：是否有动作正在播放（姿势类通道要求「动作未播放」，
 *   setPose 在 motion-playing 时返回 false）。
 */
export interface ExpressionContext {
  active?: readonly string[];
  motionPlaying?: boolean;
}

/**
 * 便捷封装：某通道现在能不能表达。
 *
 * 画像层判定（status/sourceId）之外，叠加 W3 语义约束：
 *   1. 姿势类（pose）要求动作未播放；
 *   2. 画像 conflicts 里声明的互斥通道处于激活态 → 不可表达
 *      （成对动作不能同时 open、眼睛族 key3-6 表情互斥、gaze 与前倾同写 LeanInput）。
 * 约束全部来自画像数据，不硬编码任何通道/参数名。
 */
export function canExpress(
  profile: ModelMotionProfile | null | undefined,
  channel: string,
  context?: ExpressionContext,
): boolean {
  const c = findControl(profile, channel);
  if (!c || !(c.status === 'supported' || c.status === 'approximate') || !c.sourceId) return false;
  if (context?.motionPlaying && c.kind === 'pose') return false;
  const active = context?.active;
  if (active && active.length && Array.isArray(c.conflicts) && c.conflicts.length) {
    for (const raw of active) {
      if (!raw) continue;
      const id = normalizeExtId(raw);
      for (const conflict of c.conflicts) {
        if (conflict === id || (conflict.endsWith('.*') && id.startsWith(conflict.slice(0, -1)))) return false;
      }
    }
  }
  return true;
}
