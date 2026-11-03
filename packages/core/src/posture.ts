/**
 * E2 · l2d_posture 语义姿态执行入口（纯函数层）。
 *
 * 职责边界：
 *   1. 归一化工具输入（values 夹取、durationMs 缺省与限幅）；
 *   2. 基于 planSemanticPosture 产出可执行计划：分相位（direct → pre / requires-own → post）、
 *      收集 owns、显式 skipped、标 degraded（approximate 通道）；
 *   3. 把执行结果拼装成统一回执 {ok, applied, failed, owned, skipped, degraded, durationMs}。
 *
 * 它**不写参数、不碰 ownership 存储**。真正的 own / 写入仍由 overlay 侧
 * 复用 ParamMixer / param-ownership 既有机制完成；这里只产出"该怎么执行、回执长什么样"。
 */
import type { ModelMotionProfile } from './motion-contract.ts';
import { planSemanticPosture } from './semantic-binding.ts';
import type { PosturePlan, SemanticWrite, SkippedChannel } from './semantic-binding.ts';

/** 姿态保持时长上下限与缺省值（毫秒）。 */
export const POSTURE_DURATION_MIN_MS = 500;
export const POSTURE_DURATION_MAX_MS = 30000;
export const POSTURE_DURATION_DEFAULT_MS = 4000;

export interface PostureInput {
  /** 语义通道 → 归一化值（-1..1），越界会被夹取 */
  values: Record<string, number>;
  /** 保持时长，缺省 4000ms；own 的参数到期自动释放 */
  durationMs?: number;
  /**
   * true 时把**全部**写入参数（含 direct）都 own 住，防止其他通道覆盖；
   * false / 缺省时只 own 语义上必须 own 的参数（requires-own 不可关闭）。
   */
  own?: boolean;
  /** 淡入时长毫秒；超过 durationMs 会被夹到 durationMs */
  fadeMs?: number;
}

export interface NormalizedPostureInput {
  values: Record<string, number>;
  durationMs: number;
  own: boolean;
  fadeMs: number | undefined;
}

/** approximate 通道：值能写但表达是近似的，回执必须可见。 */
export interface DegradedChannel {
  channel: string;
  status: 'approximate';
  params: string[];
}

export interface PostureExecutionPlan {
  input: NormalizedPostureInput;
  /** planSemanticPosture 的原始产出 */
  plan: PosturePlan;
  /** direct 通道写入：physics 之前（输入层） */
  pre: SemanticWrite[];
  /** requires-own 通道写入：physics 之后（姿态骨/眼球），参数必须先 own */
  post: SemanticWrite[];
  /** 需要先 own 的参数 id（去重）；input.own === true 时含全部写入参数 */
  owns: string[];
  skipped: SkippedChannel[];
  degraded: DegradedChannel[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 归一化工具输入：不认识的东西不猜，数值越界夹取，durationMs 缺省 4000。 */
export function normalizePostureInput(input: PostureInput | null | undefined): NormalizedPostureInput {
  const src = input && typeof input === 'object' ? input : ({} as PostureInput);
  const values: Record<string, number> = {};
  for (const [channel, raw] of Object.entries(src.values || {})) {
    const num = Number(raw);
    values[channel] = Number.isFinite(num) ? clamp(num, -1, 1) : 0;
  }
  const rawDuration = Number(src.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0
    ? clamp(Math.round(rawDuration), POSTURE_DURATION_MIN_MS, POSTURE_DURATION_MAX_MS)
    : POSTURE_DURATION_DEFAULT_MS;
  const rawFade = Number(src.fadeMs);
  const fadeMs = Number.isFinite(rawFade) && rawFade >= 0 ? Math.min(Math.round(rawFade), durationMs) : undefined;
  return { values, durationMs, own: src.own === true, fadeMs };
}

/**
 * 把一次 l2d_posture 调用解析成完整执行计划。
 * 参数 id 全部来自 CapabilityProfile；不支持的通道进 skipped，绝不写别的参数凑数。
 */
export function planPostureExecution(
  profile: ModelMotionProfile | null | undefined,
  input: PostureInput | null | undefined,
): PostureExecutionPlan {
  const normalized = normalizePostureInput(input);
  const plan = planSemanticPosture(profile, normalized.values);
  const pre = plan.writes.filter((w) => w.ownership === 'direct');
  const post = plan.writes.filter((w) => w.ownership === 'requires-own');
  const owns = [...plan.owns];
  if (normalized.own) {
    for (const write of plan.writes) {
      for (const param of write.params) {
        if (!owns.includes(param.id)) owns.push(param.id);
      }
    }
  }
  const degraded: DegradedChannel[] = plan.writes
    .filter((w) => w.status === 'approximate')
    .map((w) => ({ channel: w.channel, status: 'approximate' as const, params: w.params.map((p) => p.id) }));
  return { input: normalized, plan, pre, post, owns, skipped: plan.skipped, degraded };
}

export interface PostureAppliedWrite {
  id: string;
  value: number;
  channel: string;
  phase: 'pre' | 'post';
}

export interface PostureFailedWrite {
  id: string;
  value: number;
  channel: string;
  reason: string;
}

export interface PostureReceipt {
  ok: boolean;
  applied: PostureAppliedWrite[];
  failed: PostureFailedWrite[];
  owned: string[];
  skipped: SkippedChannel[];
  degraded: DegradedChannel[];
  durationMs: number;
}

/**
 * 拼装回执。overlay 侧执行完把「写成功了的参数 id」和「失败的 {id, reason}」交回来，
 * 这里负责对账：计划里的每个参数要么进 applied、要么进 failed，不允许静默丢失。
 */
export function shapePostureReceipt(
  execution: PostureExecutionPlan,
  appliedParamIds: readonly string[],
  failures: readonly { id: string; reason: string }[] = [],
): PostureReceipt {
  const appliedSet = new Set(appliedParamIds);
  const failedReason = new Map(failures.map((f) => [f.id, String(f.reason || 'failed')]));
  const applied: PostureAppliedWrite[] = [];
  const failed: PostureFailedWrite[] = [];
  for (const write of execution.plan.writes) {
    for (const param of write.params) {
      if (appliedSet.has(param.id)) {
        appliedSet.delete(param.id);
        failedReason.delete(param.id);
        applied.push({ id: param.id, value: param.value, channel: write.channel, phase: write.phase });
      } else {
        failed.push({
          id: param.id,
          value: param.value,
          channel: write.channel,
          reason: failedReason.get(param.id) || 'no-result',
        });
        failedReason.delete(param.id);
      }
    }
  }
  return {
    ok: failed.length === 0,
    applied,
    failed,
    owned: execution.owns,
    skipped: execution.skipped,
    degraded: execution.degraded,
    durationMs: execution.input.durationMs,
  };
}
