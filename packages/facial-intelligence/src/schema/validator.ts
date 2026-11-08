/**
 * Facial Plan 结构化输出与安全验证（任务书 Part 9）。
 *
 * LLM 输出不可信。本验证器 fail-closed：
 *   - 结构 / 版本 / 枚举 / 来源非法 → 拒绝（errors 非空，不产出 value）
 *   - 数值 NaN / Infinity → 拒绝（静默裁剪 NaN 会让下游不可诊断）
 *   - 语义值越界 → 按明确规则裁剪并记入 warnings（不拒绝整条计划）
 *   - durationMs / holdMs / priority 越界 → 裁剪并记入 warnings
 *   - 任何层级的 parameterId / script / tool 字段 → 拒绝（LLM 不得触达参数层与工具层）
 *
 * 注意：LLM 的 priority 不能决定真正的系统权限；clamp 到 maxPriority 只是
 * 限制它声明的数值，真正的仲裁优先级由本地 ParamMixer 的 SOURCE_PRIORITY 决定。
 */
import type { Easing, Emotion, FacialPlan } from './facial-intent.ts';

export const LIMITS = {
  minDurationMs: 80,
  maxDurationMs: 5000,

  minHoldMs: 0,
  maxHoldMs: 10000,

  minIntensity: 0,
  maxIntensity: 1,

  maxPriority: 700,
} as const;

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'shy',
  'curious',
  'surprised',
  'confused',
  'focused',
  'tired',
  'playful',
] as const;

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth'] as const;

export const INTENT_SOURCES = ['llm', 'interaction', 'tracking', 'manual'] as const;

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
  /** 越界但已按明确规则裁剪的警告；仅 valid=true 时可能非空 */
  warnings: string[];
}

const EMOTION_SET = new Set<string>(EMOTIONS);
const EASING_SET = new Set<string>(EASINGS);
const SOURCE_SET = new Set<string>(INTENT_SOURCES);

/** 白名单外的字段一律拒绝：LLM 只能提交结构化语义意图。 */
const TOP_LEVEL_KEYS = new Set(['version', 'dialogue', 'intent', 'voice', 'behavior']);
const INTENT_KEYS = new Set(['emotion', 'intensity', 'face', 'transition', 'holdMs', 'priority', 'source']);
const FACE_KEYS = new Set(['eyes', 'brows', 'mouth', 'head']);
const EYES_KEYS = new Set(['openness', 'squint', 'gazeX', 'gazeY', 'leftOpenness', 'rightOpenness']);
const BROWS_KEYS = new Set(['leftRaise', 'rightRaise', 'leftFurrow', 'rightFurrow']);
const MOUTH_KEYS = new Set(['open', 'smile', 'form']);
const HEAD_KEYS = new Set(['yaw', 'pitch', 'roll']);
const TRANSITION_KEYS = new Set(['durationMs', 'easing']);
const VOICE_KEYS = new Set(['speed', 'tone', 'pitch']);
const BEHAVIOR_KEYS = new Set(['motionId', 'expressionId']);

/**
 * 注入面禁区：参数 ID、脚本、工具调用、原型链污染键，大小写不敏感。
 * 命中即整条计划拒绝，不做裁剪。
 */
const FORBIDDEN_KEY_PATTERN =
  /^(parameterid|parameters|script|eval|function|tool|tools|mcp|constructor|prototype|__proto__|import|require)$/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** 提取有限数值；NaN / Infinity / 类型不符返回 null（由调用方决定拒绝）。 */
const finiteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** 数值域检查：非法 → errors；越界 → 裁剪 + warnings。返回裁剪后的值，拒绝时返回 null。 */
function checkRange(
  container: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  path: string,
  errors: string[],
  warnings: string[],
): number | null {
  const raw = finiteNumber(container[key]);
  if (raw === null) {
    errors.push(`${path}.${key}: 必须是有限数值`);
    return null;
  }
  if (raw < min || raw > max) {
    warnings.push(`${path}.${key}: ${raw} 超出 [${min}, ${max}]，已裁剪`);
    return clamp(raw, min, max);
  }
  return raw;
}

function checkEnum(
  container: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  path: string,
  errors: string[],
): string | null {
  const raw = container[key];
  if (typeof raw !== 'string' || !allowed.has(raw)) {
    errors.push(`${path}.${key}: 非法枚举值 "${String(raw)}"，允许 ${[...allowed].join('/')}`);
    return null;
  }
  return raw;
}

function rejectUnknownKeys(
  container: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: string[],
): boolean {
  let ok = true;
  for (const key of Object.keys(container)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key}: 白名单外字段被拒绝`);
      ok = false;
    }
  }
  return ok;
}

function scanForbiddenKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) scanForbiddenKeys(value[i], `${path}[${i}]`, errors);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      errors.push(`${path}.${key}: 不允许的字段（参数 ID / 脚本 / 工具调用注入）`);
    } else {
      scanForbiddenKeys(child, `${path}.${key}`, errors);
    }
  }
}

function validateFacialIntent(raw: unknown, errors: string[], warnings: string[]): FacialPlan['intent'] | null {
  if (!isPlainObject(raw)) {
    errors.push('intent: 必须是对象');
    return null;
  }
  rejectUnknownKeys(raw, INTENT_KEYS, 'intent', errors);

  let ok = true;
  const emotion = checkEnum(raw, 'emotion', EMOTION_SET, 'intent', errors);
  if (emotion === null) ok = false;

  const intensity = checkRange(raw, 'intensity', LIMITS.minIntensity, LIMITS.maxIntensity, 'intent', errors, warnings);
  if (intensity === null) ok = false;

  const holdMs = checkRange(raw, 'holdMs', LIMITS.minHoldMs, LIMITS.maxHoldMs, 'intent', errors, warnings);
  if (holdMs === null) ok = false;

  const priority = checkRange(raw, 'priority', 0, LIMITS.maxPriority, 'intent', errors, warnings);
  if (priority === null) ok = false;

  const source = checkEnum(raw, 'source', SOURCE_SET, 'intent', errors);
  if (source === null) ok = false;

  // ---- transition
  let durationMs: number | null = null;
  let easing: string | null = null;
  const transition = raw.transition;
  if (!isPlainObject(transition)) {
    errors.push('intent.transition: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(transition, TRANSITION_KEYS, 'intent.transition', errors);
    durationMs = checkRange(
      transition,
      'durationMs',
      LIMITS.minDurationMs,
      LIMITS.maxDurationMs,
      'intent.transition',
      errors,
      warnings,
    );
    easing = checkEnum(transition, 'easing', EASING_SET, 'intent.transition', errors);
    if (durationMs === null || easing === null) ok = false;
  }

  // ---- face
  let face: FacialPlan['intent']['face'] | null = null;
  const faceRaw = raw.face;
  if (!isPlainObject(faceRaw)) {
    errors.push('intent.face: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(faceRaw, FACE_KEYS, 'intent.face', errors);
    face = buildFace(faceRaw, errors, warnings);
    if (face === null) ok = false;
  }

  if (!ok || face === null) return null;
  return {
    emotion: emotion as Emotion,
    intensity: intensity as number,
    face,
    transition: { durationMs: durationMs as number, easing: easing as Easing },
    holdMs: holdMs as number,
    priority: priority as number,
    source: source as FacialPlan['intent']['source'],
  };
}

function buildFace(
  faceRaw: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): FacialPlan['intent']['face'] | null {
  let ok = true;

  // ---- eyes
  const eyesRaw = faceRaw.eyes;
  let eyes: FacialPlan['intent']['face']['eyes'] | null = null;
  if (!isPlainObject(eyesRaw)) {
    errors.push('intent.face.eyes: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(eyesRaw, EYES_KEYS, 'intent.face.eyes', errors);
    const openness = checkRange(eyesRaw, 'openness', 0, 1, 'intent.face.eyes', errors, warnings);
    const squint = checkRange(eyesRaw, 'squint', 0, 1, 'intent.face.eyes', errors, warnings);
    const gazeX = checkRange(eyesRaw, 'gazeX', -1, 1, 'intent.face.eyes', errors, warnings);
    const gazeY = checkRange(eyesRaw, 'gazeY', -1, 1, 'intent.face.eyes', errors, warnings);
    let leftOpenness: number | undefined;
    let rightOpenness: number | undefined;
    if (eyesRaw.leftOpenness !== undefined) {
      leftOpenness = checkRange(eyesRaw, 'leftOpenness', 0, 1, 'intent.face.eyes', errors, warnings) ?? undefined;
    }
    if (eyesRaw.rightOpenness !== undefined) {
      rightOpenness = checkRange(eyesRaw, 'rightOpenness', 0, 1, 'intent.face.eyes', errors, warnings) ?? undefined;
    }
    if (openness === null || squint === null || gazeX === null || gazeY === null) ok = false;
    else {
      eyes = { openness, squint, gazeX, gazeY, leftOpenness, rightOpenness };
    }
  }

  // ---- brows
  const browsRaw = faceRaw.brows;
  let brows: FacialPlan['intent']['face']['brows'] | null = null;
  if (!isPlainObject(browsRaw)) {
    errors.push('intent.face.brows: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(browsRaw, BROWS_KEYS, 'intent.face.brows', errors);
    const leftRaise = checkRange(browsRaw, 'leftRaise', -1, 1, 'intent.face.brows', errors, warnings);
    const rightRaise = checkRange(browsRaw, 'rightRaise', -1, 1, 'intent.face.brows', errors, warnings);
    const leftFurrow = checkRange(browsRaw, 'leftFurrow', -1, 1, 'intent.face.brows', errors, warnings);
    const rightFurrow = checkRange(browsRaw, 'rightFurrow', -1, 1, 'intent.face.brows', errors, warnings);
    if (leftRaise === null || rightRaise === null || leftFurrow === null || rightFurrow === null) ok = false;
    else brows = { leftRaise, rightRaise, leftFurrow, rightFurrow };
  }

  // ---- mouth
  const mouthRaw = faceRaw.mouth;
  let mouth: FacialPlan['intent']['face']['mouth'] | null = null;
  if (!isPlainObject(mouthRaw)) {
    errors.push('intent.face.mouth: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(mouthRaw, MOUTH_KEYS, 'intent.face.mouth', errors);
    const open = checkRange(mouthRaw, 'open', 0, 1, 'intent.face.mouth', errors, warnings);
    const smile = checkRange(mouthRaw, 'smile', -1, 1, 'intent.face.mouth', errors, warnings);
    const form = checkRange(mouthRaw, 'form', -1, 1, 'intent.face.mouth', errors, warnings);
    if (open === null || smile === null || form === null) ok = false;
    else mouth = { open, smile, form };
  }

  // ---- head
  const headRaw = faceRaw.head;
  let head: FacialPlan['intent']['face']['head'] | null = null;
  if (!isPlainObject(headRaw)) {
    errors.push('intent.face.head: 必须是对象');
    ok = false;
  } else {
    rejectUnknownKeys(headRaw, HEAD_KEYS, 'intent.face.head', errors);
    const yaw = checkRange(headRaw, 'yaw', -1, 1, 'intent.face.head', errors, warnings);
    const pitch = checkRange(headRaw, 'pitch', -1, 1, 'intent.face.head', errors, warnings);
    const roll = checkRange(headRaw, 'roll', -1, 1, 'intent.face.head', errors, warnings);
    if (yaw === null || pitch === null || roll === null) ok = false;
    else head = { yaw, pitch, roll };
  }

  if (!ok || eyes === null || brows === null || mouth === null || head === null) return null;
  return { eyes, brows, mouth, head };
}

/** 验证一条 LLM 结构化输出。失败时 valid=false 且不产出 value（fail-closed）。 */
export function validateFacialPlan(input: unknown): ValidationResult<FacialPlan> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['顶层必须是 JSON 对象'], warnings };
  }

  // 注入面扫描必须先于结构解析：任何层级的禁区字段直接拒绝。
  scanForbiddenKeys(input, '', errors);

  rejectUnknownKeys(input, TOP_LEVEL_KEYS, '', errors);

  const version = input.version;
  if (version !== '1.0') {
    errors.push(`version: 不受支持的 Schema 版本 "${String(version)}"，仅支持 "1.0"`);
  }

  const intent = validateFacialIntent(input.intent, errors, warnings);

  // ---- 可选 dialogue
  let dialogue: string | undefined;
  if (input.dialogue !== undefined) {
    if (typeof input.dialogue !== 'string') errors.push('dialogue: 必须是字符串');
    else dialogue = input.dialogue;
  }

  // ---- 可选 voice（只做类型检查，不做语义裁剪：TTS 参数不进面部链路）
  let voice: FacialPlan['voice'];
  if (input.voice !== undefined) {
    const voiceRaw = input.voice;
    if (!isPlainObject(voiceRaw)) {
      errors.push('voice: 必须是对象');
    } else {
      rejectUnknownKeys(voiceRaw, VOICE_KEYS, 'voice', errors);
      const speed = finiteNumber(voiceRaw.speed);
      const tone = voiceRaw.tone;
      const pitch = finiteNumber(voiceRaw.pitch);
      if (speed === null) errors.push('voice.speed: 必须是有限数值');
      if (typeof tone !== 'string') errors.push('voice.tone: 必须是字符串');
      if (pitch === null) errors.push('voice.pitch: 必须是有限数值');
      if (speed !== null && typeof tone === 'string' && pitch !== null) {
        voice = { speed, tone, pitch };
      }
    }
  }

  // ---- 可选 behavior（只允许资源 ID 引用，不允许任意执行载荷）
  let behavior: FacialPlan['behavior'];
  if (input.behavior !== undefined) {
    const behaviorRaw = input.behavior;
    if (!isPlainObject(behaviorRaw)) {
      errors.push('behavior: 必须是对象');
    } else {
      rejectUnknownKeys(behaviorRaw, BEHAVIOR_KEYS, 'behavior', errors);
      behavior = {};
      if (behaviorRaw.motionId !== undefined) {
        if (typeof behaviorRaw.motionId !== 'string') errors.push('behavior.motionId: 必须是字符串');
        else behavior.motionId = behaviorRaw.motionId;
      }
      if (behaviorRaw.expressionId !== undefined) {
        if (typeof behaviorRaw.expressionId !== 'string') errors.push('behavior.expressionId: 必须是字符串');
        else behavior.expressionId = behaviorRaw.expressionId;
      }
    }
  }

  if (errors.length > 0 || intent === null) {
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    value: { version: '1.0', dialogue, intent, voice, behavior },
    errors,
    warnings,
  };
}

/** JSON 文本入口：解析失败与验证失败都收敛为同一错误格式。 */
export function parseFacialPlanJson(text: string): ValidationResult<FacialPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [`JSON 解析失败: ${message}`], warnings: [] };
  }
  return validateFacialPlan(parsed);
}
