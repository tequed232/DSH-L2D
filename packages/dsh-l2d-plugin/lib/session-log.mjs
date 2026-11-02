/**
 * dsh-l2d · 会话日志读取（宿主只读，不写不锁）
 *
 * DSH 的 `session.v4.jsonl.zstd` 是「多帧 zstd + JSONL」：
 * 每帧独立压缩，直接整文件解密只会得到第一帧。这里按 zstd 魔数切帧逐段解压。
 *
 * 从 index.js 抽出，供 W1（快照/分析器/工具）复用同一份读取逻辑，
 * 避免两套解压/扫描实现漂移。所有函数不修改文件、不接触 DSH 进程状态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd';
export const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex');

/** DSH home（可被 DSH_HOME 覆盖）。 */
export function dshHome(homeDir) {
  return homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 会话根目录（可被 DSH_L2D_SESSION_DIR 覆盖，测试用）。 */
export function sessionRoot(homeDir) {
  return process.env.DSH_L2D_SESSION_DIR || path.join(dshHome(homeDir), 'sessions');
}

/**
 * 按 zstd 魔数切帧逐段解压，返回 JSONL 文本行（不解析 JSON）。
 * 单帧损坏只跳过该帧，不拖垮整份读取。
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function decompressZstdFrames(buffer) {
  const lines = [];
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return lines;
  let pos = 0;
  while (pos < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, pos);
    if (start < 0) break;
    let end = buffer.indexOf(ZSTD_MAGIC, start + 1);
    if (end < 0) end = buffer.length;
    try {
      const text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
      for (const line of text.split(/\n/)) {
        if (line.trim()) lines.push(line);
      }
    } catch {
      // 单帧损坏：跳过，继续下一帧
    }
    pos = end;
  }
  return lines;
}

/**
 * 读一个会话文件并解析为事件数组。
 * 任何 IO/解析失败都落在返回值里，不抛（调用方决定降级策略）。
 *
 * @param {string} file
 * @param {{maxBytes?: number, fsImpl?: typeof fs}} [options]
 * @returns {{ok: boolean, events: object[], bytes: number, frames: number, badLines: number, error?: string}}
 */
export function readSessionEvents(file, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 64 * 1024 * 1024;
  let buffer;
  try {
    buffer = fsImpl.readFileSync(file);
  } catch (err) {
    return { ok: false, events: [], bytes: 0, frames: 0, badLines: 0, error: err && err.code ? err.code : 'read-failed' };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, events: [], bytes: buffer.length, frames: 0, badLines: 0, error: 'too-large' };
  }
  const lines = decompressZstdFrames(buffer);
  const events = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { ok: true, events, bytes: buffer.length, frames: countFrames(buffer), badLines };
}

/** 统计帧数（诊断用）。 */
export function countFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const at = buffer.indexOf(ZSTD_MAGIC, pos);
    if (at < 0) break;
    count++;
    pos = at + 1;
  }
  return count;
}

/**
 * 列出所有会话日志，按 mtime 倒序（最新在前）。
 * @param {{homeDir?: string, fsImpl?: typeof fs}} [options]
 * @returns {Array<{file: string, mtimeMs: number, size: number, workspace: string, sessionId: string}>}
 */
export function listSessionFiles(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const base = sessionRoot(options.homeDir);
  const files = [];
  let dirs = [];
  try {
    dirs = fsImpl.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return files;
  }
  for (const dir of dirs) {
    const dirPath = path.join(base, dir.name);
    let entries = [];
    try {
      entries = fsImpl.readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dirPath, entry.name, SESSION_FILE_NAME);
      try {
        const stat = fsImpl.statSync(file);
        files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size, workspace: dir.name, sessionId: entry.name });
      } catch {
        continue;
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}
