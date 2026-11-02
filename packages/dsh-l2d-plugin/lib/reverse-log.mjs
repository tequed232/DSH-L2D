/**
 * dsh-l2d 反向桥 · 事件日志（模型 → 宿主）
 *
 * 职责：接收 /dsh-l2d/reverse/event 的已校验事件，维护内存环形缓冲，
 * 防抖原子落盘到 $DSH_HOME/l2d-reverse-state.json，并给 /ai/poll 提供
 * snapshot() 搭车数据（overlay 侧可并入 l2d_get_state，见提案）。
 *
 * 设计约束：
 * - 只存交互语义（类型 + 白名单字段），不存任何会话内容；
 * - 单写入者（宿主进程），tmp+rename 原子写，写失败只记 diag 不上抛；
 * - snapshot()/full() 返回纯 JSON 标量，内部对象绝不外漏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_EVENTS = 50; // 环形缓冲条数
const FLUSH_DEBOUNCE_MS = 500; // 落盘防抖
const PAYLOAD_LIMITS = { region: 32, action: 32, name: 64, group: 64, reason: 120 };
const PAYLOAD_NUMBERS = ['x', 'y', 'seconds', 'durationMs'];

export function createReverseLog(options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'l2d-reverse-state.json');
  const diag = options.diag || (() => {});

  const events = []; // [{type, payload, ts}]，新的在尾
  const counts = new Map(); // type -> 累计次数
  const lastAt = new Map(); // type -> 最后一次 ts
  let flushTimer = null;
  let disposed = false;

  function sanitizePayload(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, limit] of Object.entries(PAYLOAD_LIMITS)) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) out[key] = v.slice(0, limit);
    }
    for (const key of PAYLOAD_NUMBERS) {
      const v = raw[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.round(v * 100) / 100;
    }
    return out;
  }

  function flush(force = false) {
    if (!force && disposed) return;
    flushTimer = null;
    const body = {
      ok: true,
      updatedAt: new Date().toISOString(),
      counts: Object.fromEntries(counts),
      lastAt: Object.fromEntries(lastAt),
      recent: events.slice(-8),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      diag('reverse-log 落盘失败: ' + String(err && err.message));
    }
  }

  function scheduleFlush() {
    if (flushTimer || disposed) return;
    flushTimer = setTimeout(() => flush(false), FLUSH_DEBOUNCE_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  return {
    /** 记录一条已通过路由校验的事件 */
    record(type, payload) {
      const ev = { type, payload: sanitizePayload(payload), ts: Date.now() };
      events.push(ev);
      while (events.length > MAX_EVENTS) events.shift();
      counts.set(type, (counts.get(type) || 0) + 1);
      lastAt.set(type, ev.ts);
      scheduleFlush();
      return ev;
    },

    /** 给 /ai/poll 搭车的纯标量快照（体积敏感，recent 截短） */
    snapshot() {
      return {
        ok: true,
        counts: Object.fromEntries(counts),
        lastAt: Object.fromEntries(lastAt),
        recent: events.slice(-3),
      };
    },

    /** 完整快照（/dsh-l2d/reverse/state.json 与验收用） */
    full() {
      return {
        ok: true,
        file,
        updatedAt: new Date().toISOString(),
        counts: Object.fromEntries(counts),
        lastAt: Object.fromEntries(lastAt),
        recent: events.slice(-8),
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush(true); // 卸载前把内存里的最后一批写盘
    },
  };
}
