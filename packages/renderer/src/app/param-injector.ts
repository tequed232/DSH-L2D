import type { CubismModel } from '@framework/model/cubismmodel';
import type { CubismIdHandle } from '@framework/id/cubismid';
import { CubismFramework } from '@framework/live2dcubismframework';

export type InjectionMode = 'set' | 'add';

interface StickyValue {
  value: number;
  weight: number;
  mode: InjectionMode;
}

export interface InjectionDiagnostics {
  calls: number;
  writes: number;
  skipped: number;
  sticky: number;
  locked: number;
  modes: { set: number; add: number };
  phaseWrites: { pre: number; post: number };
  applySeen: { pre: number; post: number; preNonEmpty: number; postNonEmpty: number };
  debug: { modeMismatch: number; lastPhase: string; lastMode: string; firstId: string };
}

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
const FALLBACK_PHYSICS_OUTPUT = /^(?:ParamAngle[XYZ]|ParamBodyAngle[XYZ]|HipAngle[XYZ]|LEG\s*AngleZ2|ShoulderY|RArm|LArm|RForearm|LForearm|RHand|LHand)$/;

/**
 * 外部参数的唯一写入入口。
 *
 * Cubism 每帧都会从 savedParameters 恢复基底，所以一次性 set 无法持久。
 * 这里保存调用者的目标值，并在 saveParameters 之后、物理更新之前逐帧重放。
 */
export class ParamInjector {
  private sticky = new Map<string, StickyValue>();
  private locked = new Set<string>();
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

  public set(model: CubismModel, id: string, value: number, weight = 1): boolean {
    this.calls++;
    if (!id || !Number.isFinite(value) || this.isPhysicsOutput(id)) {
      this.skipped++;
      return false;
    }
    try {
      const handle = CubismFramework.getIdManager().getId(id);
      const index = model.getParameterIndex(handle);
      if (index < 0) {
        this.skipped++;
        return false;
      }
      const min = model.getParameterMinimumValue(index);
      const max = model.getParameterMaximumValue(index);
      const mode = this.modeFor(id);
      this.modeCounts[mode]++;
      this.sticky.set(id, {
        value: Math.max(min, Math.min(max, value)),
        weight: Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 1)),
        mode,
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
        const handle = CubismFramework.getIdManager().getId(id);
        if (model.getParameterIndex(handle) >= 0) {
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
    if (this.sticky.size) {
      if (phase === 'pre') this.applySeen.preNonEmpty++;
      else this.applySeen.postNonEmpty++;
    }
    this.debug.lastPhase = phase;
    this.debug.firstId = this.sticky.keys().next().value || '';
    this.debug.lastMode = this.sticky.get(this.debug.firstId)?.mode || '';
    for (const [id, target] of this.sticky) {
      // pre 相位只放行 add 型物理输入；post 相位只放行 set 型姿势/关键帧。
      const belongsHere = phase === 'pre' ? target.mode === 'add' : target.mode === 'set';
      if (!belongsHere) continue;
      if (this.locked.has(id)) {
        this.skipped++;
        continue;
      }
      try {
        const handle: CubismIdHandle = CubismFramework.getIdManager().getId(id);
        const index = model.getParameterIndex(handle);
        if (index < 0) {
          this.skipped++;
          continue;
        }
        const current = model.getParameterValueById(handle);
        const value =
          target.mode === 'add'
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
      modes: { ...this.modeCounts },
      phaseWrites: { ...this.phaseWrites },
      applySeen: { ...this.applySeen },
      debug: { ...this.debug },
    };
  }
}
