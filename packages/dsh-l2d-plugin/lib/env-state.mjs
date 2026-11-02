/**
 * dsh-l2d · 环境交互态（用户在场/输入/挂机）的宿主侧落点
 *
 * overlay 的环境感知层把「用户交互态」用 `dsh-l2d:presence` 事件 + 原始信号
 * `window.__DSH_L2D_ENV__` 暴露给宿主；宿主把它收敛成一份小状态文件
 * `$DSH_HOME/l2d-env-state.json`（原子写、整份覆盖），规划层每次通知时读取。
 *
 * 约定：
 * - 只接受白名单字段，类型/范围不对就拒绝（不猜、不兜底）。
 * - 文件超过 30s 未更新视为过期 → 规划层按 unknown 处理，绝不拿旧值误导规划。
 * - 本模块纯读写 + 校验，不依赖 DSH 服务。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENV_STATE_FILE_NAME = 'l2d-env-state.json';
export const ENV_STATE_MAX_AGE_MS = 30 * 1000;
export const ENV_STATES = Object.freeze(['conversation', 'work', 'idle', 'away']);

const FIELD_TYPES = Object.freeze({
  state: 'string',
  away: 'boolean',
  idleMs: 'number',
  hidden: 'boolean',
  inputFocused: 'boolean',
  lastTypingAt: 'number',
});

export function envStatePath(homeDir) {
  const home = homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, ENV_STATE_FILE_NAME);
}

/**
 * 规范化 overlay 上报的 presence payload。
 * @param {object} raw
 * @param {{now?: number}} [options]
 * @returns {{ ok: boolean, payload: object, ignored: string[], error?: string }}
 */
export function normalizePresencePayload(raw, options = {}) {
  const now = Number(options.now) || Date.now();
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ignored = [];
  for (const key of Object.keys(input)) {
    if (!(key in FIELD_TYPES)) ignored.push(key.slice(0, 32));
  }

  if (typeof input.state !== 'string' || !ENV_STATES.includes(input.state)) {
    return { ok: false, payload: {}, ignored, error: 'invalid state: ' + String(input.state).slice(0, 24) };
  }
  const payload = { state: input.state };

  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    if (key === 'state') continue;
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== type) {
      return { ok: false, payload: {}, ignored, error: 'invalid ' + key };
    }
    if (type === 'number') {
      if (!Number.isFinite(value)) return { ok: false, payload: {}, ignored, error: 'invalid ' + key };
      if (key === 'idleMs') {
        if (value < 0 || value > 86400000) return { ok: false, payload: {}, ignored, error: 'idleMs out of range' };
        payload.idleMs = Math.round(value);
      } else if (key === 'lastTypingAt') {
        if (value < 0 || value > now + 60000) return { ok: false, payload: {}, ignored, error: 'lastTypingAt out of range' };
        payload.lastTypingAt = Math.round(value);
      }
    } else if (type === 'boolean') {
      payload[key] = value === true;
    }
  }

  // away 与 state 的一致性由 overlay 保证；这里不替它改写，只原样记录。
  if (payload.away === undefined) payload.away = payload.state === 'away';
  return { ok: true, payload, ignored };
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

/**
 * 落盘一份环境状态（整份覆盖，带 updatedAt）。
 * @param {object} payload 已通过 normalizePresencePayload 校验的 payload
 * @param {{homeDir?: string, now?: number}} [options]
 */
export function writeEnvState(payload, options = {}) {
  const now = Number(options.now) || Date.now();
  const state = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    state: payload.state,
    away: payload.away === true,
    idleMs: payload.idleMs ?? 0,
    hidden: payload.hidden === true,
    inputFocused: payload.inputFocused === true,
    lastTypingAt: payload.lastTypingAt ?? 0,
  };
  atomicWriteJson(envStatePath(options.homeDir), state);
  return state;
}

/**
 * 读取环境状态。过期/缺失/损坏都返回 available:false，state 回 'unknown'。
 * @returns {{ available: boolean, stale: boolean, ageMs: number|null, state: string, payload: object|null, file: string, reason?: string }}
 */
export function readEnvState(options = {}) {
  const now = Number(options.now) || Date.now();
  const file = envStatePath(options.homeDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { available: false, stale: false, ageMs: null, state: 'unknown', payload: null, file, reason };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, stale: false, ageMs: null, state: 'unknown', payload: null, file, reason: 'invalid-json' };
  }
  const updatedAtMs = Date.parse(parsed && parsed.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return { available: false, stale: false, ageMs: null, state: 'unknown', payload: null, file, reason: 'invalid-updatedAt' };
  }
  const ageMs = Math.max(0, now - updatedAtMs);
  if (ageMs > ENV_STATE_MAX_AGE_MS) {
    return { available: false, stale: true, ageMs, state: 'unknown', payload: null, file, reason: 'stale' };
  }
  const normalized = normalizePresencePayload(parsed, { now: updatedAtMs });
  if (!normalized.ok) {
    return { available: false, stale: false, ageMs, state: 'unknown', payload: null, file, reason: 'invalid-payload' };
  }
  return {
    available: true,
    stale: false,
    ageMs,
    state: normalized.payload.state,
    payload: normalized.payload,
    file,
  };
}

/** 规划 prompt 用的环境摘要（中文短句）。 */
export function envPromptBlock(env) {
  if (!env || !env.available) {
    const why = env && env.reason === 'stale' ? '过期' : env && env.reason === 'missing' ? '尚未上报' : '不可用';
    return '【用户交互态】unknown（' + why + '；不要据此猜测用户在做什么）';
  }
  const p = env.payload || {};
  const bits = ['状态 ' + p.state];
  if (p.away) bits.push('已离席');
  if (p.inputFocused) bits.push('正在输入');
  if (p.hidden) bits.push('窗口不可见');
  if (typeof p.idleMs === 'number') bits.push('空闲 ' + Math.round(p.idleMs / 1000) + 's');
  if (p.lastTypingAt) bits.push('最后输入 ' + Math.max(0, Math.round((Date.now() - p.lastTypingAt) / 1000)) + 's 前');
  return '【用户交互态】' + bits.join('，') + '（' + env.ageMs + 'ms 前上报）';
}
