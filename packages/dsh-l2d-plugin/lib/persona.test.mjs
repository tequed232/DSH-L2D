import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PERSONA,
  mergePersonaPatch,
  normalizePersona,
  personaPath,
  personaPromptBlock,
  readPersona,
  readPersonaState,
  resetPersona,
  writePersona,
} from './persona.mjs';

// 1. 默认值：全字段齐全、traits 为空、数值在 0~1。
const def = normalizePersona(null);
assert.equal(def.version, 1);
assert.deepEqual(def.traits, []);
assert.equal(def.expression.style, 'gentle');
assert.equal(def.expression.intensity, 0.5);
assert.equal(def.proactivity, 0.4);
assert.equal(def.intimacy, 0.4);
assert.equal(def.workAttitude, 'supportive');
assert.equal(def.motionPreference.style, 'balanced');
assert.deepEqual(def.motionPreference.avoid, []);
assert.equal(def.idleHabit.style, 'normal');
assert.equal(def.idleHabit.lookAround, true);
assert.equal(def.description, '');
assert.equal(def.updatedAt, null);

// 2. 规范化：非法枚举回默认值、数值钳制、字符串截断、未知字段丢弃。
const dirty = normalizePersona({
  traits: [' 温柔 ', '傲娇', '', '温柔', 123, 'x'.repeat(40)],
  expression: { style: 'nope', intensity: 3 },
  proactivity: -2,
  intimacy: 5,
  workAttitude: 'weird',
  motionPreference: { style: 'expressive', avoid: ['竖手指打开', '竖手指打开', '  ', 'y'.repeat(80)] },
  idleHabit: { style: 'chatty', lookAround: false },
  description: '  一只   温柔但有点傲娇的蓝鲸女仆  ',
  updatedAt: 'not-a-date',
  unknownField: 'dropped',
  nestedUnknown: { a: 1 },
});
assert.deepEqual(dirty.traits, ['温柔', '傲娇', 'x'.repeat(16)]);
assert.equal(dirty.expression.style, 'gentle');
assert.equal(dirty.expression.intensity, 1);
assert.equal(dirty.proactivity, 0);
assert.equal(dirty.intimacy, 1);
assert.equal(dirty.workAttitude, 'supportive');
assert.equal(dirty.motionPreference.style, 'expressive');
assert.deepEqual(dirty.motionPreference.avoid, ['竖手指打开', 'y'.repeat(32)]);
assert.equal(dirty.idleHabit.style, 'chatty');
assert.equal(dirty.idleHabit.lookAround, false);
assert.equal(dirty.description, '一只 温柔但有点傲娇的蓝鲸女仆');
assert.equal(dirty.updatedAt, null);
assert.equal('unknownField' in dirty, false);

// 3. merge patch：局部更新只改指定字段；对象字段浅合并；null 回默认。
const base = normalizePersona({ traits: ['温柔'], expression: { style: 'gentle', intensity: 0.3 }, proactivity: 0.2 });
const merged = mergePersonaPatch(base, { expression: { intensity: 0.9 }, proactivity: 0.8 });
assert.equal(merged.expression.style, 'gentle', '未提供的子字段保留');
assert.equal(merged.expression.intensity, 0.9);
assert.equal(merged.proactivity, 0.8);
assert.deepEqual(merged.traits, ['温柔']);
assert.equal(merged.intimacy, 0.4);

const resetField = mergePersonaPatch(merged, { expression: null, traits: null });
assert.equal(resetField.expression.style, 'gentle');
assert.equal(resetField.expression.intensity, 0.5);
assert.deepEqual(resetField.traits, []);

// 4. 原子读写：缺失回默认；写入后立即读回；updatedAt 刷新；reset 回默认。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-'));
const missing = readPersonaState({ homeDir: home });
assert.equal(missing.source, 'default');
assert.equal(missing.persona.expression.style, 'gentle');

const written = writePersona({ traits: ['傲娇'], description: '蓝鲸女仆' }, { homeDir: home });
assert.ok(written.updatedAt, '写入必须刷新 updatedAt');
assert.equal(written.traits[0], '傲娇');
assert.ok(fs.existsSync(personaPath(home)));
assert.equal(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')).length, 0, '不能残留临时文件');

const readBack = readPersona({ homeDir: home });
assert.equal(readBack.description, '蓝鲸女仆');
assert.equal(readBack.updatedAt, written.updatedAt);

// 修改后下一次读取立即生效（无缓存）。
// updatedAt 精度是毫秒：两次写入可能落在同一毫秒，导致下面的 notEqual 偶发失败。
// 先等到时钟越过第一次写入的时间戳再写第二次（只改测试，不改业务语义）。
const firstWriteMs = Date.parse(written.updatedAt);
while (Date.now() <= firstWriteMs) {
  /* 自旋至多 1ms */
}
const second = writePersona({ proactivity: 0.95 }, { homeDir: home });
assert.equal(readPersona({ homeDir: home }).proactivity, 0.95);
assert.notEqual(second.updatedAt, written.updatedAt);

// 损坏文件：回默认值并标记 error，不抛错。
fs.writeFileSync(personaPath(home), '{ not json', 'utf8');
const broken = readPersonaState({ homeDir: home });
assert.equal(broken.source, 'default');
assert.equal(broken.error, 'invalid-json');

const reset = resetPersona({ homeDir: home });
assert.deepEqual(reset.traits, DEFAULT_PERSONA.traits);
assert.equal(reset.updatedAt !== null, true);
assert.deepEqual(readPersona({ homeDir: home }).traits, []);

// 5. prompt 摘要：包含自由描述、关键词与各维度。
const block = personaPromptBlock(written);
assert.ok(block.includes('蓝鲸女仆'));
assert.ok(block.includes('傲娇'));
assert.ok(block.includes('情绪表达'));
assert.ok(block.includes('动作偏好'));

// CODE-REVIEW-1 #16 回归：空字符串数值走 fallback，不得被 Number('')===0 静默压到 0。
{
  const p = normalizePersona({ proactivity: '', intimacy: '  ', expression: { intensity: '' } });
  assert.equal(p.proactivity, DEFAULT_PERSONA.proactivity, 'proactivity 空串应回默认');
  assert.equal(p.intimacy, DEFAULT_PERSONA.intimacy, 'intimacy 纯空白应回默认');
  assert.equal(p.expression.intensity, DEFAULT_PERSONA.expression.intensity, 'intensity 空串应回默认');
  // 合法字符串数字仍应生效
  const ok = normalizePersona({ proactivity: '0.9' });
  assert.equal(ok.proactivity, 0.9);
}

fs.rmSync(home, { recursive: true, force: true });
console.log('persona ok');
