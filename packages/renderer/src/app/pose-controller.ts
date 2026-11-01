import type { CubismModel } from '@framework/model/cubismmodel';
import type { ParamInjector } from './param-injector';

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

export class PoseController {
  private current: PoseValues = { ...REST };
  private target: PoseValues = { ...REST };
  private active = false;

  public setPose(req: PoseRequest): void {
    this.target = mergedPose(req);
    this.active = !samePose(this.current, this.target);
  }

  /** 动作结束后把模型上的真实终态作为新的当前姿势（不做假设）。 */
  public adopt(values: PoseValues): void {
    const next: PoseValues = { ...REST };
    for (const id of POSE_IDS) {
      if (Number.isFinite(values[id])) next[id] = values[id];
    }
    this.current = next;
    this.target = next;
    this.active = true;
  }

  /** Loop 动作在 duration 处回卷，终态直接采用动作曲线上实测到的终点。 */
  public adoptPreset(req: PoseRequest): void {
    const next = mergedPose(req);
    this.current = next;
    this.target = next;
    this.active = true;
  }

  public resetToRest(): void {
    this.target = { ...REST };
    this.current = { ...REST };
    this.active = true;
  }

  /** 每帧在正确注入窗口前推进缓动；静止时不写任何参数。 */
  public update(model: CubismModel, dt: number, injector: ParamInjector): void {
    if (!this.active) return;
    const k = 1 - Math.exp(-Math.max(0, dt) / 0.14);
    let remaining = 0;
    for (const id of POSE_IDS) {
      const to = this.target[id] || 0;
      const from = this.current[id] || 0;
      const next = Math.abs(to - from) < 0.002 ? to : from + (to - from) * k;
      if (next !== from) this.current[id] = next;
      if (Math.abs(to - next) > 0.001) remaining++;
      injector.set(model, id, next, 1);
    }
    if (!remaining && samePose(this.current, this.target)) this.active = false;
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
