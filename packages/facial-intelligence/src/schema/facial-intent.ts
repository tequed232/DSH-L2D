/**
 * Facial Intent Schema —— LLM 与 Live2D 之间的统一协议（任务书 Part 3.1）。
 *
 * LLM 不感知模型真实参数 ID 与参数范围，只输出模型无关的语义控制值；
 * 语义值的合法域见 validator.ts 的逐项 clamp 规则。
 * 注意：本文件必须保持纯类型（node --experimental-strip-types 可直接剥离）。
 */

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'shy'
  | 'curious'
  | 'surprised'
  | 'confused'
  | 'focused'
  | 'tired'
  | 'playful';

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'smooth';

export interface EyeIntent {
  /** 0~1 */
  openness: number;
  /** 0~1 */
  squint: number;
  /** -1~1 */
  gazeX: number;
  /** -1~1 */
  gazeY: number;
  /** 0~1，可选：单眼开合覆盖 */
  leftOpenness?: number;
  /** 0~1，可选：单眼开合覆盖 */
  rightOpenness?: number;
}

export interface BrowIntent {
  /** -1~1 */
  leftRaise: number;
  /** -1~1 */
  rightRaise: number;
  /** -1~1 */
  leftFurrow: number;
  /** -1~1 */
  rightFurrow: number;
}

export interface MouthIntent {
  /** 0~1 */
  open: number;
  /** -1~1 */
  smile: number;
  /** -1~1 */
  form: number;
}

export interface HeadIntent {
  /** -1~1 */
  yaw: number;
  /** -1~1 */
  pitch: number;
  /** -1~1 */
  roll: number;
}

export interface FacialIntent {
  emotion: Emotion;

  /** 0~1，情绪强度 */
  intensity: number;

  face: {
    eyes: EyeIntent;
    brows: BrowIntent;
    mouth: MouthIntent;
    head: HeadIntent;
  };

  transition: {
    durationMs: number;
    easing: Easing;
  };

  holdMs: number;

  /**
   * 请求优先级。validator 会把它钳到 LIMITS.maxPriority 以内；
   * 注意：LLM 的 priority 不决定真正的系统权限，最终优先级由本地控制器分配。
   */
  priority: number;

  source: 'llm' | 'interaction' | 'tracking' | 'manual';
}

export interface FacialPlan {
  version: '1.0';

  dialogue?: string;

  intent: FacialIntent;

  voice?: {
    speed: number;
    tone: string;
    pitch: number;
  };

  behavior?: {
    motionId?: string;
    expressionId?: string;
  };
}
