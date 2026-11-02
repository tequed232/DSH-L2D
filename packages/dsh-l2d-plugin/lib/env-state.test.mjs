import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENV_STATE_MAX_AGE_MS,
  envPromptBlock,
  envStatePath,
  normalizePresencePayload,
  readEnvState,
  writeEnvState,
} from './env-state.mjs';

// 1. payload 白名单 + 类型/范围校验。
const ok = normalizePresencePayload({ state: 'conversation', away: false, inputFocused: true, idleMs: 1200, lastTypingAt: Date.now() - 1000, hidden: false });
assert.equal(ok.ok, true);
assert.equal(ok.payload.state, 'conversation');
assert.equal(ok.payload.inputFocused, true);
assert.equal(ok.payload.idleMs, 1200);

const badState = normalizePresencePayload({ state: 'dancing' });
assert.equal(badState.ok, false);
assert.ok(badState.error.includes('state'));

const badType = normalizePresencePayload({ state: 'idle', idleMs: '1200' });
assert.equal(badType.ok, false);

const badRange = normalizePresencePayload({ state: 'idle', idleMs: -5 });
assert.equal(badRange.ok, false);
const futureTyping = normalizePresencePayload({ state: 'work', lastTypingAt: Date.now() + 3600000 });
assert.equal(futureTyping.ok, false);

const extra = normalizePresencePayload({ state: 'idle', evil: '<script>', away: true });
assert.equal(extra.ok, true);
assert.deepEqual(extra.ignored, ['evil']);
assert.equal(extra.payload.away, true);

// 2. 落盘 / 读回 / 过期。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-'));
const now = Date.now();
writeEnvState({ state: 'conversation', away: false, idleMs: 900, inputFocused: true }, { homeDir: home, now });
assert.ok(fs.existsSync(envStatePath(home)));
const fresh = readEnvState({ homeDir: home, now: now + 1000 });
assert.equal(fresh.available, true);
assert.equal(fresh.state, 'conversation');
assert.equal(fresh.payload.inputFocused, true);
assert.equal(fresh.ageMs, 1000);
assert.equal(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')).length, 0);

const stale = readEnvState({ homeDir: home, now: now + ENV_STATE_MAX_AGE_MS + 1 });
assert.equal(stale.available, false);
assert.equal(stale.stale, true);
assert.equal(stale.state, 'unknown');
assert.ok(envPromptBlock(stale).includes('unknown'));

// 3. 缺失 / 损坏不抛错。
const missing = readEnvState({ homeDir: path.join(home, 'nope'), now });
assert.equal(missing.available, false);
assert.equal(missing.reason, 'missing');

fs.writeFileSync(envStatePath(home), '{oops');
assert.equal(readEnvState({ homeDir: home, now }).available, false);

// 4. prompt 摘要：fresh 带状态与输入态；stale 明确 unknown。
writeEnvState({ state: 'work', idleMs: 3000, inputFocused: false }, { homeDir: home, now });
const block = envPromptBlock(readEnvState({ homeDir: home, now: now + 500 }));
assert.ok(block.includes('work'));
assert.ok(block.includes('空闲 3s'));

fs.rmSync(home, { recursive: true, force: true });
console.log('env-state ok');
