import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  SESSION_FILE_NAME,
  countFrames,
  decompressZstdFrames,
  listSessionFiles,
  readSessionEvents,
} from './session-log.mjs';

// 构造「多帧 zstd + JSONL」文件：每行一个 JSON，每帧独立压缩。
function writeSessionFile(file, rows, { frames = rows.length } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const chunks = [];
  const perFrame = Math.max(1, Math.ceil(rows.length / frames));
  for (let i = 0; i < rows.length; i += perFrame) {
    const text = rows.slice(i, i + perFrame).map((r) => JSON.stringify(r)).join('\n') + '\n';
    chunks.push(zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-sessionlog-'));
  tmpRoots.push(dir);
  return dir;
}

// 1) 多帧解压：两帧都要读到，不因帧边界丢行。
const rows = [
  { type: 'session', time: 1, data: {} },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'turn/end', time: 3, data: { reason: { kind: 'completed' } } },
];
const root = tmpDir();
const sessionFile = path.join(root, 'ws-1', 'sess-1', SESSION_FILE_NAME);
writeSessionFile(sessionFile, rows, { frames: 3 });
const buf = fs.readFileSync(sessionFile);
assert.equal(countFrames(buf), 3);
assert.equal(decompressZstdFrames(buf).length, 3);

const read = readSessionEvents(sessionFile);
assert.equal(read.ok, true);
assert.equal(read.events.length, 3);
assert.equal(read.events[1].type, 'user/message');
assert.equal(read.badLines, 0);

// 2) listSessionFiles：按 mtime 倒序，带 workspace/sessionId；缺失目录返回空数组。
const listRoot = tmpDir();
const fileA = path.join(listRoot, 'ws-A', 'sess-a', SESSION_FILE_NAME);
const fileB = path.join(listRoot, 'ws-B', 'sess-b', SESSION_FILE_NAME);
writeSessionFile(fileA, [{ type: 'session', time: 1 }], { frames: 1 });
writeSessionFile(fileB, [{ type: 'session', time: 1 }], { frames: 1 });
const now = Date.now() / 1000;
fs.utimesSync(fileA, now - 100, now - 100);
fs.utimesSync(fileB, now, now);
const prevEnv = process.env.DSH_L2D_SESSION_DIR;
process.env.DSH_L2D_SESSION_DIR = listRoot;
try {
  const files = listSessionFiles();
  assert.equal(files.length, 2);
  assert.equal(files[0].sessionId, 'sess-b'); // 更新的在前
  assert.equal(files[1].sessionId, 'sess-a');
  assert.equal(files[0].workspace, 'ws-B');
  assert.ok(fs.existsSync(files[0].file));
} finally {
  if (prevEnv === undefined) delete process.env.DSH_L2D_SESSION_DIR;
  else process.env.DSH_L2D_SESSION_DIR = prevEnv;
}

const missing = listSessionFiles({ homeDir: path.join(root, 'no-such-home') });
assert.deepEqual(missing, []);

// 3) 损坏帧只跳过自己：一个坏帧 + 一个好帧。
const mixedFile = path.join(root, 'ws-C', 'sess-c', SESSION_FILE_NAME);
fs.mkdirSync(path.dirname(mixedFile), { recursive: true });
const good = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', time: 5 }) + '\n'));
const broken = Buffer.concat([Buffer.from('28b52ffd', 'hex'), Buffer.from('not-a-real-frame')]);
fs.writeFileSync(mixedFile, Buffer.concat([broken, good]));
const mixed = readSessionEvents(mixedFile);
assert.equal(mixed.ok, true);
assert.equal(mixed.events.length, 1);
assert.equal(mixed.events[0].type, 'session');

// 4) 坏 JSON 行计数但不抛；空文件返回空事件。
const badJsonFile = path.join(root, 'ws-D', 'sess-d', SESSION_FILE_NAME);
fs.mkdirSync(path.dirname(badJsonFile), { recursive: true });
fs.writeFileSync(badJsonFile, zlib.zstdCompressSync(Buffer.from('{not json}\n{"type":"session"}\n')));
const badJson = readSessionEvents(badJsonFile);
assert.equal(badJson.ok, true);
assert.equal(badJson.events.length, 1);
assert.equal(badJson.badLines, 1);

const emptyFile = path.join(root, 'ws-E', 'sess-e', SESSION_FILE_NAME);
fs.mkdirSync(path.dirname(emptyFile), { recursive: true });
fs.writeFileSync(emptyFile, Buffer.alloc(0));
const empty = readSessionEvents(emptyFile);
assert.equal(empty.ok, true);
assert.deepEqual(empty.events, []);

// 5) 读失败 / 超限：落在返回值，不抛。
const failed = readSessionEvents(path.join(root, 'nope', SESSION_FILE_NAME));
assert.equal(failed.ok, false);
assert.equal(failed.error, 'ENOENT');
const tooLarge = readSessionEvents(sessionFile, { maxBytes: 8 });
assert.equal(tooLarge.ok, false);
assert.equal(tooLarge.error, 'too-large');

for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
console.log('session-log ok');
