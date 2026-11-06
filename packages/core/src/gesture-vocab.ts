/**
 * 动作语义词表（M1-d2，docs/REFERENCE-WHALEL2D-ARCHITECTURE.md §3.1 / §5.3）。
 *
 * WHALEL2D Body.cs 的 Words 表对照：每个持续型动作归入一个命名通道（gaze/tilt/turn/…），
 * 同通道后词替换前词、跨通道并存（Body.cs:198）。本仓不引入新机制——GestureSegment 的
 * params 参数域（gesture-timeline.ts:168-176「参数 id 重叠即冲突」）就是通道的泛化：
 * **每词一个参数域**，同域词经现有冲突判定自然产生"同通道替换、跨通道并存"。
 * 不做 WHALE 式跨通道求和（本仓仲裁是赢家通吃，求和会破坏 INV-1 唯一 winner）。
 *
 * 设计约束：
 * - 纯数据 + 纯函数，零运行路径接线（flag 无关，flag 关时本文件无任何行为差异）；
 * - 词是"owner 评审过的行为"（WHALE 同款）：词条改动必须配 gesture-vocab.test.ts 断言；
 * - 种子词参数 id 从模型能力画像 safeParams 选（overlay pokeCapabilities 清单的子集），
 *   词表扩充由 owner 评审后追加，参数 id 必须在 GESTURE_PARAM_WHITELIST 内（fail-closed）。
 * - 本文件是 core 侧唯一新增参数名的文件（gesture-timeline 能力驱动铁律不破：时间线
 *   机制仍然零参数名，词表是调用方给定的数据）。
 */
import type { GestureSegment } from './gesture-timeline.ts';
import type { OwnershipWriteIntent } from './write-plan.ts';
import { DEFAULT_GESTURE_PRIORITY } from './gesture-timeline.ts';
import type { SemanticPriority } from './motion-contract.ts';

/** 词表参数白名单：校验器 fail-closed 用。扩充词条时先扩这份名单（owner 评审）。 */
export const GESTURE_PARAM_WHITELIST: ReadonlySet<string> = new Set([
  'ParamEyeBallX',
  'ParamEyeBallY',
  'AngleZ',
  'RArm',
  'LArm',
  'AngleX',
  'AngleY',
  'AngleZ',
  'PositionX',
]);

/** 词类别：hold = 命名通道持续参数（WHALE Hold/Channel）；move = 一次性时间曲线（WHALE Move）。 */
export type GestureWordKind = 'hold' | 'move';

/**
 * 动作词（WHALEL2D §3.1 Word 的本仓投影）。
 * - hold 词：params 即通道占位（参数 id → 持续值，值只构成冲突域与写值方向）；
 * - move 词：keys 首尾必须归零（Body.cs:20 注释同款约束），params 与 keys 参数集一致。
 */
export interface GestureWord {
  /** 词稳定标识（cue 名，如 'gaze.left'）。 */
  id: string;
  /** 语义标签（面向 Agent 提示词的中文词面）。 */
  label: string;
  /** 通道名：同通道词共享参数域（文档化用途；冲突判定只看 params 重叠）。 */
  channel: string;
  kind: GestureWordKind;
  /** 参数域：参数 id → hold 值。非空且 id 全部在白名单内（校验器保证）。 */
  params: Record<string, number>;
  /** 单词时长（ms，>0）。move 词 = keys 覆盖时长；hold 词 = 建议持有时长。 */
  durationMs: number;
  /** ActGate 档位；缺省 NORMAL（台词伴生动作不打断 Agent 链，由 admitGesture 双查兜底）。 */
  priority?: SemanticPriority;
  /** move 词键帧（[[t_ms, value], ...]，按时间递增，首尾值为 0）。hold 词省略。 */
  keys?: Array<[number, number]>;
}

/**
 * 种子词表（5 词，缺省方案；词表扩充由 owner 评审后追加）。
 * 每词一个参数域：gaze 词只声明 ParamEyeBallX、tilt 词只声明 AngleZ（本仓模型无 FaceAngleZ——WHALE/VTS 侧名，见 M1-f 词表更正）、
 * wave 词只声明 RArm —— 参数域重叠即冲突 ⇒ 同通道替换、跨通道并存。
 */
export const GESTURE_VOCAB: readonly GestureWord[] = [
  {
    id: 'gaze.left',
    label: '看左边',
    channel: 'gaze',
    kind: 'hold',
    params: { ParamEyeBallX: -1 },
    durationMs: 1200,
    priority: 10,
  },
  {
    id: 'gaze.right',
    label: '看右边',
    channel: 'gaze',
    kind: 'hold',
    params: { ParamEyeBallX: 1 },
    durationMs: 1200,
    priority: 10,
  },
  {
    id: 'tilt.left',
    label: '歪头（左）',
    channel: 'tilt',
    kind: 'hold',
    params: { AngleZ: -8 },
    durationMs: 1500,
    priority: 10,
  },
  {
    id: 'tilt.right',
    label: '歪头（右）',
    channel: 'tilt',
    kind: 'hold',
    params: { AngleZ: 8 },
    durationMs: 1500,
    priority: 10,
  },
  {
    id: 'wave.right',
    label: '抬右手挥手',
    channel: 'wave',
    kind: 'move',
    params: { RArm: 1 },
    durationMs: 600,
    priority: 10,
    keys: [
      [0, 0],
      [180, 1],
      [420, 1],
      [600, 0],
    ],
  },
];

export interface GestureWordIssue {
  wordId: string;
  detail: string;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 词表校验器（WHALEL2D §5.3 FishPet.Tests 式三条不可变约束的本仓版）：
 * 1. 每词 params 非空且参数 id 在白名单内；
 * 2. move 类键帧存在、首尾值为 0、keys 覆盖时长与 durationMs 一致；
 * 3. 时长随 scale 单调（见 scaleGestureWord；测试矩阵 M7 断言）。
 * 返回全部问题（空数组 = 通过）；不修改入参。
 */
export function validateGestureVocab(words: readonly GestureWord[] = GESTURE_VOCAB): GestureWordIssue[] {
  const issues: GestureWordIssue[] = [];
  const push = (wordId: string, detail: string) => issues.push({ wordId, detail });

  for (const w of words) {
    if (!w || typeof w !== 'object') {
      push('*', 'word must be an object');
      continue;
    }
    if (typeof w.id !== 'string' || !w.id) {
      push('*', 'id is required');
      continue;
    }
    if (!w.params || typeof w.params !== 'object' || Array.isArray(w.params)) {
      push(w.id, 'params must be an object');
      continue;
    }
    const keys = Object.keys(w.params);
    if (!keys.length) push(w.id, 'params must not be empty（每词至少一个参数域）');
    for (const [k, v] of Object.entries(w.params)) {
      if (!GESTURE_PARAM_WHITELIST.has(k)) push(w.id, 'param not in whitelist: ' + k);
      if (!isFiniteNumber(v)) push(w.id, 'params.' + k + ' must be a finite number');
    }
    if (!isFiniteNumber(w.durationMs) || w.durationMs <= 0) {
      push(w.id, 'durationMs must be a positive number');
    }
    if (w.priority !== undefined && w.priority !== 10 && w.priority !== 50 && w.priority !== 90) {
      push(w.id, 'priority must be 10/50/90');
    }
    if (w.kind === 'move') {
      const ks = w.keys;
      if (!Array.isArray(ks) || ks.length < 2) {
        push(w.id, 'move word requires >= 2 keys');
      } else {
        if (ks[0][1] !== 0) push(w.id, 'move word first key must be 0（首帧归零）');
        if (ks[ks.length - 1][1] !== 0) push(w.id, 'move word last key must be 0（尾帧归零，Body.cs:20 同款）');
        for (let i = 1; i < ks.length; i++) {
          if (ks[i][0] <= ks[i - 1][0]) push(w.id, 'move keys must be strictly increasing in time');
        }
        const span = ks[ks.length - 1][0];
        if (isFiniteNumber(w.durationMs) && span !== w.durationMs) {
          push(w.id, 'durationMs (' + w.durationMs + ') must equal keys span (' + span + ')');
        }
        const keyParams = Object.keys(w.params);
        if (keyParams.length !== 1) push(w.id, 'move word declares exactly one param（每词一个参数域）');
      }
    } else if (w.keys !== undefined) {
      push(w.id, 'hold word must not declare keys');
    }
  }
  return issues;
}

/** scale 钳制（WHALE 微/大 前缀同语义：0.25x ~ 4x）。 */
const clampScale = (scale: number): number => (Math.max(0.25, Math.min(4, scale)));

/**
 * 幅值/时长缩放（WHALE Scale/Pace 同型，Body.cs:25-26）：返回缩放后的词副本（不修改入参）。
 * scale >= 1 放大幅值并等比拉长时长；单调性由测试矩阵 M7 锁定（时长随 scale 严格递增）。
 */
export function scaleGestureWord(word: GestureWord, scale: number): GestureWord {
  const s = clampScale(Number(scale) || 1);
  const scaled: GestureWord = {
    ...word,
    params: Object.fromEntries(
      Object.entries(word.params).map(([k, v]) => [k, v * s]),
    ),
    durationMs: Math.max(1, Math.round(word.durationMs * s)),
  };
  if (word.keys) {
    scaled.keys = word.keys.map(([t, v]) => [Math.round(t * s), v * s] as [number, number]);
  }
  return scaled;
}

const VOCAB_ENTRY_PREFIX = 'vocab:';

/**
 * 词 → GestureSegment（gesture-timeline 入队形状）。
 * 段 id = 'vocab:' + word.id（确定性、可重放，同词重入队天然同通道替换）；
 * params 只进冲突域判定（值 = hold 方向 / move 峰值），不产生任何写路径。
 */
export function gestureWordSegment(word: GestureWord, scale = 1): GestureSegment {
  const scaled = scaleGestureWord(word, scale);
  const seg: GestureSegment = {
    id: VOCAB_ENTRY_PREFIX + word.id,
    group: 'vocab:' + word.channel,
    params: { ...scaled.params },
    durationMs: scaled.durationMs,
    priority: scaled.priority ?? DEFAULT_GESTURE_PRIORITY,
    source: 'motion',
  };
  return seg;
}

/**
 * 词 → 写意图（write-plan OwnershipWriteIntent 形状），供 M7 语义回归：
 * 给定 cue → resolveWritePlan 输出 writes 的参数 id 与符号方向精确断言
 * （不锁数值——数值随模型调，方向与结构不随）。
 */
export function gestureWordIntent(word: GestureWord, scale = 1): OwnershipWriteIntent {
  const scaled = scaleGestureWord(word, scale);
  return {
    id: VOCAB_ENTRY_PREFIX + word.id,
    source: 'motion',
    priority: scaled.priority ?? DEFAULT_GESTURE_PRIORITY,
    params: { ...scaled.params },
  };
}
