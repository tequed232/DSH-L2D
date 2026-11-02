import type { CubismModel } from '@framework/model/cubismmodel';
import type { ParamInjector } from './param-injector';
import { easeInOutCubic } from '../../../core/src/ease.ts';

/**
 * 四肢参数姿势层。
 *
 * 只使用实测安全的姿态参数（不在 physics3.json 输出表里）。
 * 数值来自对应 motion3.json 的终态，避免线性映射把手臂拧畸形。
 * 与动作互斥：动作播放期间 injector 会 lock 这批参数，结束后收养真实终态。
 */
export const POSE_IDS = [
  'Param36',
  'Param39',
  'Param40',
  'Param41',
  'Param42',
  'Param43',
  'Param59',
  'Param60',
  'Param61',
  'Param62',
] as const;

export type PoseSideName = 'rest' | 'finger' | 'grass' | 'chest';

type PoseValues = Record<string, number>;

const REST: PoseValues = {
  Param36: 0,
  Param39: 0,
  Param40: 0,
  Param41: 0,
  Param42: 0,
  Param43: 0,
  Param59: 0,
  Param60: 0,
  Param61: 0,
  Param62: 0,
};

const PRESETS: Record<PoseSideName, PoseValues> = {
  rest: REST,
  finger: {
    ...REST,
    Param36: 0,
    Param39: 0.322,
    Param40: 1,
    Param41: 0.702,
    Param42: 0,
    Param43: 0,
  },
  grass: {
    ...REST,
    Param36: 0.04,
    Param39: 0.2,
    Param41: -0.732,
    Param42: 0,
    Param43: 0,
  },
  chest: {
    ...REST,
    Param59: 0.476,
    Param60: 0.86,
    Param61: 0.002,
    Param62: 0.034,
  },
};

export interface PoseRequest {
  right?: PoseSideName;
  left?: PoseSideName;
}

function mergedPose(req: PoseRequest): PoseValues {
  const values: PoseValues = { ...REST };
  const right = req.right || 'rest';
  const left = req.left || 'rest';
  if (!PRESETS[right] || !PRESETS[left]) return values;
  for (const id of ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43']) {
    values[id] = PRESETS[right][id];
  }
  for (const id of ['Param59', 'Param60', 'Param61', 'Param62']) {
    values[id] = PRESETS[left][id];
  }
  return values;
}

function samePose(a: PoseValues, b: PoseValues): boolean {
  return POSE_IDS.every((id) => Math.abs((a[id] || 0) - (b[id] || 0)) < 0.001);
}

export interface PoseControllerOptions {
  /** 过渡时长（秒） */
  easeSec?: number;
  /** 停在非 rest 姿势这么久之后，自动缓回 rest。0 表示不自动回。 */
  idleReturnSec?: number;
}

export class PoseController {
  private current: PoseValues = { ...REST };
  private from: PoseValues = { ...REST };
  private target: PoseValues = { ...REST };
  private active = false;
  private elapsed = 0;
  private easeSec: number;
  private idleReturnSec: number;
  /** 只有 setPose 会武装自动回 rest；动作收养的终态要保持。 */
  private armed = false;
  private idleLeft = 0;

  constructor(opts: PoseControllerOptions = {}) {
    this.easeSec = opts.easeSec && opts.easeSec > 0 ? opts.easeSec : 0.48;
    this.idleReturnSec = opts.idleReturnSec === undefined ? 6 : Math.max(0, opts.idleReturnSec);
  }

  public setPose(req: PoseRequest): void {
    this.from = { ...this.current };
    this.target = mergedPose(req);
    this.elapsed = 0;
    this.idleLeft = 0;
    this.armed = true;
    this.active = !samePose(this.current, this.target);
    if (!this.active && this.armed && !samePose(this.target, REST) && this.idleReturnSec > 0) {
      this.idleLeft = this.idleReturnSec;
    }
  }

  /** 动作结束后把模型上的真实终态作为新的当前姿势。不自动回 rest。 */
  public adopt(values: PoseValues): void {
    const next: PoseValues = { ...REST };
    for (const id of POSE_IDS) {
      if (Number.isFinite(values[id])) next[id] = values[id];
    }
    this.hold(next);
  }

  /** Loop 动作在 duration 处回卷，终态直接采用动作曲线上实测到的终点。 */
  public adoptPreset(req: PoseRequest): void {
    this.hold(mergedPose(req));
  }

  public resetToRest(): void {
    this.from = { ...this.current };
    this.target = { ...REST };
    this.elapsed = 0;
    this.armed = false;
    this.idleLeft = 0;
    this.active = !samePose(this.current, this.target);
  }

  /** 每帧在注入窗口里推进缓动，数值只交给 ParamInjector。静止时不写。 */
  public update(model: CubismModel, dt: number, injector: ParamInjector): void {
    const step = Math.max(0, dt);
    if (!this.active) {
      if (this.armed && this.idleLeft > 0) {
        this.idleLeft -= step;
        if (this.idleLeft <= 0) this.resetToRest();
      }
      if (!this.active) return;
    }

    this.elapsed += step;
    const span = this.easeSec > 0 ? this.easeSec : 0.001;
    const t = Math.min(1, this.elapsed / span);
    const k = easeInOutCubic(t);
    for (const id of POSE_IDS) {
      const to = this.target[id] || 0;
      const from = this.from[id] || 0;
      const next = t >= 1 || Math.abs(to - from) < 0.0005 ? to : from + (to - from) * k;
      this.current[id] = next;
      injector.set(model, id, next, 1);
    }
    if (t >= 1) {
      this.active = false;
      if (this.armed && this.idleReturnSec > 0 && !samePose(this.target, REST)) {
        this.idleLeft = this.idleReturnSec;
      } else {
        this.armed = false;
        this.idleLeft = 0;
      }
    }
  }

  /** 动作终态直接站住，下一帧写一次后停笔，避免自动回 rest 拆掉成对动作。 */
  private hold(next: PoseValues): void {
    this.from = { ...next };
    this.current = { ...next };
    this.target = { ...next };
    this.elapsed = this.easeSec;
    this.armed = false;
    this.idleLeft = 0;
    this.active = true;
  }

  public describe(): { right: PoseSideName; left: PoseSideName; active: boolean } {
    // 只报告值域所属的姿势名；混合态（动作收养后的自定义值）报 custom。
    const guess = (ids: string[], values: PoseValues): PoseSideName => {
      for (const name of ['rest', 'finger', 'grass', 'chest'] as PoseSideName[]) {
        if (ids.every((id) => Math.abs((PRESETS[name][id] || 0) - (values[id] || 0)) < 0.01)) {
          return name;
        }
      }
      return 'custom' as PoseSideName;
    };
    return {
      right: guess(['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43'], this.target),
      left: guess(['Param59', 'Param60', 'Param61', 'Param62'], this.target),
      active: this.active,
    };
  }
}
