import type { CubismModel } from '@framework/model/cubismmodel';
import type { CubismIdHandle } from '@framework/id/cubismid';
import { CubismFramework } from '@framework/live2dcubismframework';
import { ParamOwnership, DEFAULT_OWN_DURATION_MS, selectOwnableIds } from './param-ownership.ts';
import { LIPSYNC_PARAMS } from '../../../core/src/index.ts';

export type InjectionMode = 'set' | 'add';

interface StickyValue {
  value: number;
  weight: number;
  mode: InjectionMode;
  /** 仅 Agent 独占参数使用：指定写入相位（pre/post），优先于 mode 的默认相位。 */
  ownedPhase?: 'pre' | 'post';
}

export interface InjectionDiagnostics {
  calls: number;
  writes: number;
  skipped: number;
  sticky: number;
  locked: number;
  owned: number;
  modes: { set: number; add: number };
  phaseWrites: { pre: number; post: number };
  applySeen: { pre: number; post: number; preNonEmpty: number; postNonEmpty: number };
  debug: { modeMismatch: number; lastPhase: string; lastMode: string; firstId: string };
}

/** 口型红线：任何通道（含 own、keyframes、set_parameters）都永不放行。 */
const MOUTH_PARAMS = new Set<string>(LIPSYNC_PARAMS);

const ADDITIVE_INPUTS = new Set([
  'AngleX',
  'AngleY',
  'AngleZ',
  'PositionX',
  'PositionY',
  'PositionZ',
  'LeanInput',
  'Movement1',
  'Movement2',
  'Movement3',
]);

/** 未拿到 physics3.json 时的保守兜底；拿到后会使用模型的真实输出表。 */
// 仅用于 physics3.json 尚未加载完的启动窗口；加载完成后以模型真实输出表为准。
// 已按 509 参数 × physics3 输出表核对：不含 ShoulderX/ShoulderYy（可写输入），
// 补齐 HipAngleX2/ParamHipAngleZ/ParamHipAngleZ2/HipAngleYDOWN/HipAngleYUP。
const FALLBACK_PHYSICS_OUTPUT = /^(?:ParamAngle[XYZ]|ParamBodyAngle[XYZ]|ParamBodyAngleRX|HipAngle[XYZ]|HipAngleX2|HipAngleYUP|HipAngleYDOWN|ParamHipAngleZ2?|HipZ[12]|LEGs*AngleZ2|ShoulderY|ShoulderZ|RArm|LArm|RForearm|LForearm|RWrist|LWrist|RHand|LHand|RHand2|LHand2)$/;

/**
 * 取参数的**真实**下标；模型里不存在时返回 -1。
 *
 * 真机缺陷修复（choreo 复现：真机 l2d_set_parameters 写 ParamArmRA / ParamNotExistXYZ
 * 都回报 applied）。
 * 根因：Cubism 5 的 CubismModel.getParameterIndex 对模型里不存在的参数**不返回 -1**，
 * 而是把 id 登记进 _notExistParameterId 并返回一个 ≥ getParameterCount() 的合成下标，
 * 之后 min/max 读到 undefined、写值落进 _notExistParameterValues，全程不抛错 ——
 * 所有只判 `index < 0` 的写入路径都会把不存在的参数静默 applied。
 * 真机复现步骤：真机调 l2d_set_parameters { values: { ParamNotExistXYZ: 1 } }，
 * 修复前回执 applied 含 ParamNotExistXYZ；修复后应进 failed 且 reason=not-exist。
 * 本模型真实手臂参数是 Param36/39/40/41/42/43 与 59~62（见 motion-director 的 poseParams）。
 */
export function parameterIndexOf(model: CubismModel, id: string): number {
  try {
    const handle = CubismFramework.getIdManager().getId(id);
    const index = model.getParameterIndex(handle);
    return index >= 0 && index < model.getParameterCount() ? index : -1;
  } catch {
    return -1;
  }
}

/**
 * 外部参数的唯一写入入口。
 *
 * Cubism 每帧都会从 savedParameters 恢复基底，所以一次性 set 无法持久。
 * 这里保存调用者的目标值，并在 saveParameters 之后、物理更新之前逐帧重放。
 */
export class ParamInjector {
  private sticky = new Map<string, StickyValue>();
  private locked = new Set<string>();
  /** Agent 独占参数：允许写物理输出，且只在 post 相位写入（Physics600 之后）。 */
  private ownership = new ParamOwnership();
  private physicsOutputs = new Set<string>();
  private calls = 0;
  private writes = 0;
  private skipped = 0;
  private modeCounts = { set: 0, add: 0 };
  private phaseWrites = { pre: 0, post: 0 };
  private applySeen = { pre: 0, post: 0, preNonEmpty: 0, postNonEmpty: 0 };
  private debug = { modeMismatch: 0, lastPhase: '', lastMode: '', firstId: '' };

  public setPhysicsOutputs(ids: Iterable<string>): void {
    this.physicsOutputs = new Set(ids);
  }

  public isPhysicsOutput(id: string): boolean {
    return this.physicsOutputs.size > 0
      ? this.physicsOutputs.has(id)
      : FALLBACK_PHYSICS_OUTPUT.test(id);
  }

  public modeFor(id: string): InjectionMode {
    return ADDITIVE_INPUTS.has(id) ? 'add' : 'set';
  }

  /** 参数是否被 Agent 独占（到期即视为释放）。 */
  public isAgentOwned(id: string): boolean {
    return this.ownership.isOwned(id);
  }

  /** 认领参数；到期自动释放，避免永久脱离物理。返回实际登记的 id。 */
  public own(ids: Iterable<string>, durationMs: number = DEFAULT_OWN_DURATION_MS, phase: 'pre' | 'post' = 'post'): string[] {
    // 只有物理输出需要「物理默认 + Agent 覆盖」；非物理参数保持普通写入（add/set 语义不变）。
    // 口型参数不允许被任何通道认领。筛选逻辑抽成纯函数，便于单测。
    const candidates = Array.from(ids).filter((raw) => {
      const id = typeof raw === 'string' ? raw.trim() : '';
      return !!id && !MOUTH_PARAMS.has(id);
    });
    const filtered = selectOwnableIds(candidates, (id) => this.isPhysicsOutput(id));
    const accepted = this.ownership.own(filtered, { durationMs, phase });
    // 相位可能变化（pre↔post）：清掉旧 sticky，下一帧按新相位重写，避免一帧写错位置
    for (const id of accepted) this.sticky.delete(id);
    return accepted;
  }

  /** 主动释放：同时清掉 sticky，让下一帧物理自然接管。 */
  public release(ids: Iterable<string>): string[] {
    const released = this.ownership.release(ids);
    for (const id of released) this.sticky.delete(id);
    return released;
  }

  public releaseAll(): string[] {
    const released = this.ownership.releaseAll();
    for (const id of released) this.sticky.delete(id);
    return released;
  }

  public getAgentOwned(): string[] {
    return this.ownership.list();
  }

  /**
   * [M1-b] 当前被 Agent 独占且相位为 pre 的参数 id（PhysicsGate.pre 的让位集合数据源）。
   * pre 相位按契约只有物理根输入类（M1-b 实际为 HipAngleX/Y/Z）；flag 关时 PhysicsGate
   * 不会调用本方法。snapshot 自带到期清理（INV-5）。
   */
  public getPreOwnedIds(): string[] {
    return this.ownership
      .snapshot()
      .filter((e) => e.phase === 'pre')
      .map((e) => e.id);
  }

  public set(model: CubismModel, id: string, value: number, weight = 1): boolean {
    this.calls++;
    if (!id || !Number.isFinite(value)) {
      this.skipped++;
      return false;
    }
    // 口型红线：不区分通道，直接拒绝
    if (MOUTH_PARAMS.has(id)) {
      this.skipped++;
      return false;
    }
    const ownedPhase = this.ownership.phaseOf(id);
    const owned = ownedPhase !== null;
    // 物理输出默认只读；被 Agent 独占后才允许写（相位由 ownership 决定）
    if (this.isPhysicsOutput(id) && !owned) {
      this.skipped++;
      return false;
    }
    try {
      const handle = CubismFramework.getIdManager().getId(id);
      // 必须用真实下标校验：getParameterIndex 对不存在的参数返回合成下标（见 parameterIndexOf 注释）
      const index = parameterIndexOf(model, id);
      if (index < 0) {
        this.skipped++;
        return false;
      }
      const min = model.getParameterMinimumValue(index);
      const max = model.getParameterMaximumValue(index);
      // 独占参数强制 set 语义；相位由 ownership 指定（四肢叶子 post，M1-b 的 Hip 类 pre）
      const mode = owned ? 'set' : this.modeFor(id);
      this.modeCounts[mode]++;
      this.sticky.set(id, {
        value: Math.max(min, Math.min(max, value)),
        weight: Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 1)),
        mode,
        ownedPhase: owned ? (ownedPhase as 'pre' | 'post') : undefined,
      });
      return true;
    } catch {
      this.skipped++;
      return false;
    }
  }

  public clear(ids?: Iterable<string>): void {
    if (!ids) {
      this.sticky.clear();
      return;
    }
    for (const id of ids) this.sticky.delete(id);
  }

  public lock(ids: Iterable<string>): void {
    for (const id of ids) this.locked.add(id);
  }

  public unlock(ids?: Iterable<string>): void {
    if (!ids) {
      this.locked.clear();
      return;
    }
    for (const id of ids) this.locked.delete(id);
  }

  public getLocked(): string[] {
    return Array.from(this.locked);
  }

  public snapshot(model: CubismModel, ids: Iterable<string>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const id of ids) {
      try {
        // 真实下标校验：不存在的参数（合成下标）不进快照
        if (parameterIndexOf(model, id) >= 0) {
          const handle = CubismFramework.getIdManager().getId(id);
          result[id] = model.getParameterValueById(handle);
        }
      } catch {
        /* 单个参数不存在不影响其它参数 */
      }
    }
    return result;
  }

  /**
   * 重放注入值。
   * pre：物理输入（Angle/Position 等），必须在物理更新前写入；
   * post：姿势/关键帧等 set 值，必须在 PoseUpdater 之后写入，否则会被覆盖。
   */
  public apply(model: CubismModel, phase: 'pre' | 'post' = 'pre'): void {
    this.applySeen[phase]++;
    // 到期的独占参数：清掉 sticky，物理下一帧自然接管
    const expired = this.ownership.expire();
    for (const id of expired) this.sticky.delete(id);
    if (this.sticky.size) {
      if (phase === 'pre') this.applySeen.preNonEmpty++;
      else this.applySeen.postNonEmpty++;
    }
    this.debug.lastPhase = phase;
    this.debug.firstId = this.sticky.keys().next().value || '';
    this.debug.lastMode = this.sticky.get(this.debug.firstId)?.mode || '';
    for (const [id, target] of this.sticky) {
      // 独占参数的相位以 ownership 现算为准（重复 own 改相位时不使用旧 sticky 相位）；
      // 其余沿用 pre=add / post=set。
      let ownedPhase = target.ownedPhase;
      if (ownedPhase) {
        const currentPhase = this.ownership.phaseOf(id);
        if (!currentPhase) {
          this.sticky.delete(id);
          continue;
        }
        ownedPhase = currentPhase;
      }
      const belongsHere = ownedPhase
        ? phase === ownedPhase
        : phase === 'pre'
          ? target.mode === 'add'
          : target.mode === 'set';
      if (!belongsHere) continue;
      if (this.locked.has(id)) {
        this.skipped++;
        continue;
      }
      try {
        const handle: CubismIdHandle = CubismFramework.getIdManager().getId(id);
        // 同 set()：合成下标不等于存在，必须用 parameterIndexOf 过滤（否则会写 NaN）
        const index = parameterIndexOf(model, id);
        if (index < 0) {
          this.skipped++;
          continue;
        }
        const current = model.getParameterValueById(handle);
        const value =
          target.mode === 'add' && !ownedPhase
            ? current + target.value * target.weight
            : current + (target.value - current) * target.weight;
        const min = model.getParameterMinimumValue(index);
        const max = model.getParameterMaximumValue(index);
        model.setParameterValueById(handle, Math.max(min, Math.min(max, value)), 1);
        this.writes++;
        this.phaseWrites[phase]++;
      } catch {
        this.skipped++;
      }
    }
  }

  public resetStats(): void {
    this.calls = 0;
    this.writes = 0;
    this.skipped = 0;
  }

  public diagnostics(): InjectionDiagnostics {
    return {
      calls: this.calls,
      writes: this.writes,
      skipped: this.skipped,
      sticky: this.sticky.size,
      locked: this.locked.size,
      owned: this.ownership.size(),
      modes: { ...this.modeCounts },
      phaseWrites: { ...this.phaseWrites },
      applySeen: { ...this.applySeen },
      debug: { ...this.debug },
    };
  }
}
