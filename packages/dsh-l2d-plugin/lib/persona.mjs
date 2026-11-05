/**
 * dsh-l2d · L1 人设层（Persona）
 *
 * 纯数据模块：schema、默认值、校验/规范化、原子读写、merge patch、reset。
 * 不依赖 DSH 服务、不依赖浏览器；规划层（workspace-agent）与路由层（index.js）
 * 都只通过这里的函数读写，保证「修改立即生效、处处同一份事实」。
 *
 * 持久化位置：`$DSH_HOME/l2d-persona.json`（默认 ~/.dsh/l2d-persona.json）。
 * 写入策略：同目录临时文件 + rename，权限 0600；读取失败绝不抛错（回默认值），
 * 因为人设是「偏好」而不是「事实」，坏了也不能拖垮角色。
 *
 * 字段（第一阶段，全部可选、可局部更新）：
 *   traits           性格关键词，0~8 个短词（如 温柔 / 傲娇 / 认真）
 *   expression       情绪表达：style（gentle/lively/reserved/tsundere/calm）+ intensity 0~1
 *   proactivity      主动程度 0~1（0 只回应，1 乐于主动发起）
 *   intimacy         亲密程度 0~1
 *   workAttitude     工作态度：supportive/neutral/strict/playful
 *   motionPreference 动作偏好：style（subtle/balanced/expressive）+ avoid 回避的动作组名
 *   idleHabit        待机习惯：style（quiet/normal/chatty）+ lookAround 是否东张西望
 *   description      自由描述（用户原话，<= 500 字）
 *   updatedAt        ISO 时间戳（每次写入刷新）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PERSONA_VERSION = 1;
export const PERSONA_FILE_NAME = 'l2d-persona.json';
export const PERSONA_DESCRIPTION_MAX = 500;

export const PERSONA_ENUMS = Object.freeze({
  expressionStyle: Object.freeze(['gentle', 'lively', 'reserved', 'tsundere', 'calm']),
  workAttitude: Object.freeze(['supportive', 'neutral', 'strict', 'playful']),
  motionStyle: Object.freeze(['subtle', 'balanced', 'expressive']),
  idleStyle: Object.freeze(['quiet', 'normal', 'chatty']),
});

/** 默认人设：中性、克制、可被一句话整体覆盖。 */
export const DEFAULT_PERSONA = Object.freeze({
  version: PERSONA_VERSION,
  traits: Object.freeze([]),
  expression: Object.freeze({ style: 'gentle', intensity: 0.5 }),
  proactivity: 0.4,
  intimacy: 0.4,
  workAttitude: 'supportive',
  motionPreference: Object.freeze({ style: 'balanced', avoid: Object.freeze([]) }),
  idleHabit: Object.freeze({ style: 'normal', lookAround: true }),
  description: '',
  updatedAt: null,
});

function deepFreezeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp01(value, fallback) {
  // 空字符串/纯空白不是合法数值（Number('')===0 会把 0~1 钳位值静默压到 0），走 fallback。
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function pickEnum(value, list, fallback) {
  return typeof value === 'string' && list.includes(value) ? value : fallback;
}

function normalizeStringList(value, { maxItems, maxLen }) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 把任意输入规范化为完整人设。
 * - 缺失/非法字段回默认值；数值钳到 0~1；枚举回默认值；字符串去空白、截断。
 * - 未知字段一律丢弃（人设是封闭 schema，不给规划 prompt 带不可控内容）。
 * - updatedAt 只在输入里是合法 ISO 字符串时保留，其余置 null（由写入方刷新）。
 */
export function normalizePersona(input) {
  const raw = asRecord(input);
  const expressionRaw = asRecord(raw.expression);
  const motionRaw = asRecord(raw.motionPreference);
  const idleRaw = asRecord(raw.idleHabit);

  const traits = normalizeStringList(raw.traits, { maxItems: 8, maxLen: 16 });
  const avoid = normalizeStringList(motionRaw.avoid, { maxItems: 8, maxLen: 32 });
  const description =
    typeof raw.description === 'string' ? raw.description.replace(/\s+/g, ' ').trim().slice(0, PERSONA_DESCRIPTION_MAX) : '';

  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt.trim() && !Number.isNaN(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null;

  return {
    version: PERSONA_VERSION,
    traits,
    expression: {
      style: pickEnum(expressionRaw.style, PERSONA_ENUMS.expressionStyle, DEFAULT_PERSONA.expression.style),
      intensity: clamp01(expressionRaw.intensity, DEFAULT_PERSONA.expression.intensity),
    },
    proactivity: clamp01(raw.proactivity, DEFAULT_PERSONA.proactivity),
    intimacy: clamp01(raw.intimacy, DEFAULT_PERSONA.intimacy),
    workAttitude: pickEnum(raw.workAttitude, PERSONA_ENUMS.workAttitude, DEFAULT_PERSONA.workAttitude),
    motionPreference: {
      style: pickEnum(motionRaw.style, PERSONA_ENUMS.motionStyle, DEFAULT_PERSONA.motionPreference.style),
      avoid,
    },
    idleHabit: {
      style: pickEnum(idleRaw.style, PERSONA_ENUMS.idleStyle, DEFAULT_PERSONA.idleHabit.style),
      lookAround: idleRaw.lookAround !== false,
    },
    description,
    updatedAt,
  };
}

/**
 * 合并一次局部修改（PUT / MCP set 都走这里）。
 * - 对象字段（expression / motionPreference / idleHabit）做浅合并，只认已知子字段；
 * - 数组与标量整体替换；
 * - 显式 null 表示「该字段回默认值」；
 * - 未知字段忽略。
 */
export function mergePersonaPatch(current, patch) {
  const base = normalizePersona(current);
  const p = asRecord(patch);
  const next = deepFreezeClone(base);

  if ('traits' in p) next.traits = p.traits === null ? [] : p.traits;
  if ('proactivity' in p) next.proactivity = p.proactivity === null ? DEFAULT_PERSONA.proactivity : p.proactivity;
  if ('intimacy' in p) next.intimacy = p.intimacy === null ? DEFAULT_PERSONA.intimacy : p.intimacy;
  if ('workAttitude' in p) next.workAttitude = p.workAttitude === null ? DEFAULT_PERSONA.workAttitude : p.workAttitude;
  if ('description' in p) next.description = p.description === null ? '' : p.description;
  if ('expression' in p) {
    if (p.expression === null) {
      next.expression = deepFreezeClone(DEFAULT_PERSONA.expression);
    } else {
      const e = asRecord(p.expression);
      if ('style' in e) next.expression.style = e.style === null ? DEFAULT_PERSONA.expression.style : e.style;
      if ('intensity' in e) next.expression.intensity = e.intensity === null ? DEFAULT_PERSONA.expression.intensity : e.intensity;
    }
  }
  if ('motionPreference' in p) {
    if (p.motionPreference === null) {
      next.motionPreference = deepFreezeClone(DEFAULT_PERSONA.motionPreference);
    } else {
      const m = asRecord(p.motionPreference);
      if ('style' in m) next.motionPreference.style = m.style === null ? DEFAULT_PERSONA.motionPreference.style : m.style;
      if ('avoid' in m) next.motionPreference.avoid = m.avoid === null ? [] : m.avoid;
    }
  }
  if ('idleHabit' in p) {
    if (p.idleHabit === null) {
      next.idleHabit = deepFreezeClone(DEFAULT_PERSONA.idleHabit);
    } else {
      const h = asRecord(p.idleHabit);
      if ('style' in h) next.idleHabit.style = h.style === null ? DEFAULT_PERSONA.idleHabit.style : h.style;
      if ('lookAround' in h) next.idleHabit.lookAround = h.lookAround === null ? DEFAULT_PERSONA.idleHabit.lookAround : h.lookAround;
    }
  }
  return normalizePersona(next);
}

export function personaPath(homeDir) {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, PERSONA_FILE_NAME);
}

const VALIDATED = Symbol('validated-persona');

/**
 * 读取人设。文件缺失/损坏都不抛错：回默认值，source 标明来源，便于诊断。
 * @returns {{ persona: object, source: 'file'|'default', file: string, error?: string }}
 */
export function readPersonaState(options = {}) {
  const file = personaPath(options.homeDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { persona: normalizePersona(null), source: 'default', file };
    }
    return { persona: normalizePersona(null), source: 'default', file, error: String(err && err.message ? err.message : err) };
  }
  try {
    const parsed = JSON.parse(text);
    return { persona: normalizePersona(parsed), source: 'file', file };
  } catch (err) {
    return { persona: normalizePersona(null), source: 'default', file, error: 'invalid-json' };
  }
}

/** 只取人设对象。 */
export function readPersona(options = {}) {
  return readPersonaState(options).persona;
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const body = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function stamp(persona) {
  return { ...normalizePersona(persona), updatedAt: new Date().toISOString() };
}

/**
 * 应用一次局部修改并落盘，返回写入后的完整人设（含新 updatedAt）。
 * 规划层下一次读取即可看到新值 —— 不缓存，立即生效。
 */
export function writePersona(patch, options = {}) {
  const file = personaPath(options.homeDir);
  const current = readPersona({ homeDir: options.homeDir });
  const next = stamp(mergePersonaPatch(current, patch));
  atomicWriteJson(file, next);
  return next;
}

/** 重置为默认人设（写盘并刷新 updatedAt）。 */
export function resetPersona(options = {}) {
  const file = personaPath(options.homeDir);
  const next = stamp(DEFAULT_PERSONA);
  atomicWriteJson(file, next);
  return next;
}

/** 规划 prompt 用的人设摘要（中文短行，给 LLM 读，不放 JSON 噪音）。 */
export function personaPromptBlock(persona) {
  const p = normalizePersona(persona);
  const lines = [
    '【人设】' + (p.description ? p.description : '（未填写自由描述，按下述字段演绎）'),
    '- 性格关键词：' + (p.traits.length ? p.traits.join('、') : '未指定'),
    '- 情绪表达：' + p.expression.style + '（强度 ' + p.expression.intensity.toFixed(2) + '）',
    '- 主动程度：' + p.proactivity.toFixed(2) + '（0 只回应 / 1 乐于主动）',
    '- 亲密程度：' + p.intimacy.toFixed(2),
    '- 工作态度：' + p.workAttitude,
    '- 动作偏好：' + p.motionPreference.style + (p.motionPreference.avoid.length ? '，回避 ' + p.motionPreference.avoid.join('、') : ''),
    '- 待机习惯：' + p.idleHabit.style + (p.idleHabit.lookAround ? '，会东张西望' : '，安静不张望'),
  ];
  if (p.updatedAt) lines.push('- 更新时间：' + p.updatedAt);
  return lines.join('\n');
}
