/**
 * Facial Intelligence 桥（PR-01，feat/facial-intelligence）
 *
 * 任务书链路：LLM → Facial Intent → Facial Controller → ParamMixer → Cubism Adapter → Renderer。
 * 本文件是纯逻辑层：不 import Cubism，不直接写模型——每帧产出「语义 → 模型域参数值」帧，
 * 由 index.ts 在正确相位（头角 pre / 眼 post）经 ParamInjector 写入，复用全部既有守卫
 * （口型红线 / 物理输出只读 / 真实下标校验 / min-max 钳制 / Node Ownership）。
 *
 * mixer 键空间 = FaceParameters 键子集（angleX/Y/Z、eyeLOpen/ROpen、eyeBallX/Y）。
 * 嘴部不进 mixer：口型红线在 injector.set 不区分通道无条件拒绝，PR-01 无嘴部写路径
 * （差异报告 docs/facial-intelligence/DEVIATION-REPORT.md D1）。
 *
 * 各源每 tick 重提交（mixer source timeout 500ms 一帧级冗余）：
 * - manual(900)：持续覆盖到 releaseManual
 * - llm(700)：意图 holdMs 到期让位
 * - micro(200)：微表情目标（绝对值），主表情在位时被压下
 */

import {
  validateFacialPlan,
  createBindingFromScan,
  mapBipolarRange,
  mapUnitRange,
  ParamMixer,
  FacialController,
  MicroExpressionEngine,
  BlinkController,
  type FacialPlan,
  type ParameterBinding,
  type FacialSemantic,
  type CubismParameterAdapter,
  type BindingScanResult,
  type FaceParameterKey,
} from '../../../facial-intelligence/src/index.ts';

/** 来源优先级（任务书 Part 6 建议表；LLM 上限 700，本地分配） */
export const FACIAL_SOURCE_PRIORITY = {
  safety: 1000,
  manual: 900,
  tracking: 800,
  llm: 700,
  interaction: 600,
  micro: 200,
} as const;

/** 语义 → FaceParameters 键（mixer 键空间） */
const SEMANTIC_TO_KEY: Record<string, FaceParameterKey> = {
  'head.yaw': 'angleX',
  'head.pitch': 'angleY',
  'head.roll': 'angleZ',
  'eyes.leftOpen': 'eyeLOpen',
  'eyes.rightOpen': 'eyeROpen',
  'eyes.gazeX': 'eyeBallX',
  'eyes.gazeY': 'eyeBallY',
};

const SEMANTIC_DOMAIN: Record<string, 'unit' | 'bipolar'> = {
  'head.yaw': 'bipolar',
  'head.pitch': 'bipolar',
  'head.roll': 'bipolar',
  'eyes.leftOpen': 'unit',
  'eyes.rightOpen': 'unit',
  'eyes.gazeX': 'bipolar',
  'eyes.gazeY': 'bipolar',
};

const ALL_SEMANTICS = Object.keys(SEMANTIC_TO_KEY) as FacialSemantic[];

/** 意图语义取值（leftOpenness/rightOpenness 缺省回落 openness） */
function intentSemanticValue(plan: FacialPlan, semantic: FacialSemantic): number | null {
  const f = plan.intent.face;
  switch (semantic) {
    case 'head.yaw': return f.head.yaw;
    case 'head.pitch': return f.head.pitch;
    case 'head.roll': return f.head.roll;
    case 'eyes.leftOpen': return f.eyes.leftOpenness ?? f.eyes.openness;
    case 'eyes.rightOpen': return f.eyes.rightOpenness ?? f.eyes.openness;
    case 'eyes.gazeX': return f.eyes.gazeX;
    case 'eyes.gazeY': return f.eyes.gazeY;
    default: return null;
  }
}

/** 每帧输出：模型域参数值；字段缺省 = 本帧 FI 对该组无主张（不写，让位既有通道） */
export interface FacialFrame {
  headX?: number;
  headY?: number;
  headZ?: number;
  eyeL?: number;
  eyeR?: number;
  eyeGX?: number;
  eyeGY?: number;
  /** 本帧被更高优先级压下的写入数（诊断：同参数多源竞争） */
  suppressed: number;
  /** 本帧各键归属来源 */
  owners: Record<string, string>;
  /** 无映射/不支持语义（模型扫描后固定） */
  unsupported: string[];
}

interface ModelParamSpec {
  id: string;
  min: number;
  max: number;
  defaultValue: number;
}

interface ActiveIntent {
  plan: FacialPlan;
  expiresAt: number;
}

/** 模型参数表 → CubismParameterAdapter（供 createBindingFromScan 扫描） */
function makeScanAdapter(params: ModelParamSpec[]): CubismParameterAdapter & { fingerprint: string } {
  const byId = new Map(params.filter((p) => p.id && p.max > p.min).map((p) => [p.id, p]));
  const fingerprint = params.length ? 'model-' + params.length + '-' + (params[0]?.id ?? '') : '';
  return {
    fingerprint,
    getModelFingerprint(): string {
      return fingerprint;
    },
    hasParameter(id: string): boolean {
      return byId.has(id);
    },
    getParameterValue(id: string): number | null {
      const p = byId.get(id);
      return p ? p.defaultValue : null;
    },
    getParameterRange(id: string): { min: number; max: number; defaultValue: number } | null {
      const p = byId.get(id);
      return p ? { min: p.min, max: p.max, defaultValue: p.defaultValue } : null;
    },
    setParameterValue(): boolean {
      return false; // 扫描用适配器不承担写入；真实写入走 injector
    },
  };
}

export class FacialBridge {
  private mixer = new ParamMixer();
  private controller = new FacialController();
  private micro = new MicroExpressionEngine();
  private blink = new BlinkController();
  private bindings = new Map<FacialSemantic, ParameterBinding>();
  private unsupported: string[] = ALL_SEMANTICS.slice();
  private intents: ActiveIntent[] = [];
  /** 手动持续覆盖（语义域值；releaseManual 释放） */
  private manualValues = new Map<FacialSemantic, number>();
  /** 待设置的微表情（setEmotion 需要 nowMs，tick 时提交） */
  private pendingEmotion: { emotion: string; intensity: number } | null = null;
  private lastDiag = { writes: 0, rejected: 0, lastApplyAt: 0 };
  private lastFingerprint = '';
  /** 上一帧下发给控制器的目标（防每帧重置 duration 过渡） */
  private lastTargetsKey = '';

  /**
   * 模型加载后调用一次：真实参数扫描 → 语义映射（任务书「先扫描真实模型参数」）。
   * 不存在的语义（如眉毛）不生成映射、永不写入、进 unsupported 诊断，不伪造写入成功。
   */
  configure(modelParams: ModelParamSpec[]): BindingScanResult {
    this.mixer = new ParamMixer();
    this.controller = new FacialController();
    this.controller.hardReset();
    this.intents = [];
    this.manualValues.clear();
    const adapter = makeScanAdapter(modelParams);
    const scan = createBindingFromScan(adapter);
    this.bindings = new Map(scan.bindings.map((b) => [b.semantic as FacialSemantic, b]));
    this.unsupported = scan.unsupported.map((u) => u.semantic);
    this.lastFingerprint = scan.fingerprint;
    this.lastTargetsKey = '';
    return scan;
  }

  /** LLM FacialPlan 入口：Schema 验证 → 登记（hold 到期让位）。验证失败拒绝不写。 */
  applyPlan(json: unknown, now: number): { ok: boolean; errors: string[]; warnings: string[] } {
    const v = validateFacialPlan(json);
    if (!v.valid || !v.value) return { ok: false, errors: v.errors, warnings: v.warnings || [] };
    // 本地权限分配：LLM 声明的 priority 只是建议，统一按 llm 上限登记
    void v.value.intent.priority;
    this.intents.push({ plan: v.value, expiresAt: now + v.value.intent.holdMs });
    return { ok: true, errors: [], warnings: v.warnings || [] };
  }

  /** 手动覆盖（Parameter Inspector 拖动）：MANUAL=900，不被 LLM 盖 */
  setManual(semantic: FacialSemantic, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (!(semantic in SEMANTIC_TO_KEY)) return false;
    this.manualValues.set(semantic, value);
    return true;
  }

  releaseManual(): void {
    this.manualValues.clear();
    this.mixer.clearSource('manual');
  }

  /** 表情预览（Control Studio 测试按钮）：微表情 + 眨眼调制走同一 FI 链路 */
  setEmotion(emotion: string, intensity: number, now: number): void {
    this.pendingEmotion = { emotion, intensity };
    this.micro.setEmotion(emotion, intensity, now);
    this.blink.setEmotion(emotion);
  }

  reset(): void {
    this.intents = [];
    this.manualValues.clear();
    this.pendingEmotion = null;
    this.mixer.clearSource('llm');
    this.mixer.clearSource('manual');
    this.mixer.clearSource('micro');
    this.micro.clear();
    this.blink.setManualHold(false);
    this.controller.reset(); // 平滑回默认（不硬切）
    this.lastTargetsKey = '';
  }

  /** 手动/意图/微表情是否活跃（index.ts 决定让位与写入窗口） */
  hasAuthority(): boolean {
    return this.manualValues.size > 0 || this.intents.length > 0 || !!this.pendingEmotion;
  }

  manualActives(): FacialSemantic[] {
    return Array.from(this.manualValues.keys());
  }

  getDiag(): { writes: number; rejected: number; lastApplyAt: number; unsupported: string[]; fingerprint: string } {
    return {
      writes: this.lastDiag.writes,
      rejected: this.lastDiag.rejected,
      lastApplyAt: this.lastDiag.lastApplyAt,
      unsupported: this.unsupported.slice(),
      fingerprint: this.lastFingerprint,
    };
  }

  /** 记录 index.ts 实际写入结果（诊断回填，不做控制） */
  recordWriteResult(written: number, rejected: number, now: number): void {
    this.lastDiag.writes = written;
    this.lastDiag.rejected = rejected;
    this.lastDiag.lastApplyAt = now;
  }

  /** 语义域值 → 模型域（按扫描绑定） */
  private toModel(semantic: FacialSemantic, v: number): number | null {
    const b = this.bindings.get(semantic);
    if (!b) return null;
    return SEMANTIC_DOMAIN[semantic] === 'unit' ? mapUnitRange(v, b) : mapBipolarRange(v, b);
  }

  /**
   * 每帧产出模型域帧。nowMs 毫秒（performance.now 语义），dtMs 帧间隔毫秒。
   * mixer step 求值 → controller 平滑 → 眨眼乘数 → 仅本帧有主张的组产出字段。
   */
  tick(nowMs: number, dtMs: number): FacialFrame {
    // 1) 过期意图清理（holdMs 到期让位；source 超时由 mixer step 内兜底）
    this.intents = this.intents.filter((it) => it.expiresAt > nowMs);

    // 2) 逐源重提交（mixer source timeout 500ms，静止贡献必须每帧续期）
    //    微表情：绝对目标值（FaceParameters 域），micro(200) 低优先级
    const microOut = this.micro.update(nowMs);
    for (const [key, value] of Object.entries(microOut)) {
      if (key === 'mouthOpen' || key === 'mouthForm') continue; // 口型红线：微表情不产嘴部
      this.mixer.submitValue('micro', key, value, { priority: FACIAL_SOURCE_PRIORITY.micro, timestamp: nowMs });
    }
    //    手动：语义域 → mixer 键，重提交保持持续控制
    for (const [semantic, value] of this.manualValues) {
      const key = SEMANTIC_TO_KEY[semantic];
      if (!key) continue;
      const model = this.toModel(semantic, value);
      if (model === null) continue;
      this.mixer.submitValue('manual', key, model, { priority: FACIAL_SOURCE_PRIORITY.manual, timestamp: nowMs });
    }
    //    LLM 意图：语义域 → mixer 键，expiresAt = hold 剩余
    let newestIntent: ActiveIntent | null = null;
    for (const it of this.intents) {
      if (!newestIntent || it.expiresAt > newestIntent.expiresAt) newestIntent = it;
      for (const semantic of ALL_SEMANTICS) {
        const raw = intentSemanticValue(it.plan, semantic);
        if (raw === null || raw === undefined || !Number.isFinite(raw)) continue;
        const model = this.toModel(semantic, raw);
        if (model === null) continue; // 无映射不写入不仲裁
        const key = SEMANTIC_TO_KEY[semantic];
        this.mixer.submitValue('llm', key, model, {
          priority: FACIAL_SOURCE_PRIORITY.llm,
          timestamp: nowMs,
          expiresAt: it.expiresAt,
          weight: Math.max(0.05, Math.min(1, it.plan.intent.intensity || 0.5)),
        });
      }
    }

    // 3) 仲裁求值（无基线：无主张的键不出现在 values/owners）
    const snapshot = this.mixer.step(nowMs, {});
    const owners = snapshot.owners;
    const owned = Object.keys(owners) as FaceParameterKey[];

    // 4) 控制器平滑：owner 键目标 + 微表情在无主键时仍平滑逼近
    //    目标未变化时不得重复 setTarget——durationMs 过渡每帧重置会导致进度永远卡在首帧
    const targets: Partial<Record<FaceParameterKey, number>> = {};
    for (const key of owned) {
      const v = snapshot.values[key];
      if (Number.isFinite(v)) (targets as Record<string, number>)[key] = v;
    }
    const targetsKey = JSON.stringify(targets);
    if (Object.keys(targets).length && targetsKey !== this.lastTargetsKey) {
      const tr = newestIntent
        ? { durationMs: newestIntent.plan.intent.transition.durationMs, easing: newestIntent.plan.intent.transition.easing }
        : undefined;
      this.controller.setTarget(targets, tr);
      this.lastTargetsKey = targetsKey;
    }
    const cur = this.controller.update(Math.max(0, dtMs) / 1000);

    // 5) 眨眼：手动眼意图活跃时让位
    const manualEye = this.manualValues.has('eyes.leftOpen') || this.manualValues.has('eyes.rightOpen');
    this.blink.setManualHold(manualEye);
    const blinkFrame = this.blink.update(nowMs);

    // 6) 组帧：仅本帧有主张的键产出字段（模型域）
    const frame: FacialFrame = {
      suppressed: snapshot.skippedWrites,
      owners,
      unsupported: this.unsupported.slice(),
    };
    if (owned.includes('angleX')) frame.headX = cur.angleX;
    if (owned.includes('angleY')) frame.headY = cur.angleY;
    if (owned.includes('angleZ')) frame.headZ = cur.angleZ;
    if (owned.includes('eyeLOpen')) frame.eyeL = Math.max(0, Math.min(1, cur.eyeLOpen * blinkFrame.eyeLOpen));
    if (owned.includes('eyeROpen')) frame.eyeR = Math.max(0, Math.min(1, cur.eyeROpen * blinkFrame.eyeROpen));
    if (owned.includes('eyeBallX')) frame.eyeGX = Math.max(-1, Math.min(1, cur.eyeBallX));
    if (owned.includes('eyeBallY')) frame.eyeGY = Math.max(-1, Math.min(1, cur.eyeBallY));
    return frame;
  }
}
