/**
 * GALLERY-BRIDGE 验收（裁决书 §3/§4）。
 * 覆盖：gallery_scores v10 repo（幂等/来源优先级/top 查询/情绪过滤）、
 * prompt_templates seed、mcp-tools l2d_gallery_top（护栏：clamp 3 / >2MB 跳过 /
 * 空集提示不退化随机）、matcher 命中附图（score>60）。
 * 直跑：node --experimental-sqlite packages/mcp-bridge/tests/gallery-bridge.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import { SCHEMA_VERSION } from '../../dsh-l2d-db/src/schema.mjs';
import {
  upsertGalleryScore, countGalleryScores, listTopGalleryItems, seedMotionDirectorTemplate,
} from '../../dsh-l2d-db/src/gallery-repo.mjs';
import { createGallerySource } from '../gallery-source.mjs';
import { registerLive2DTools } from '../mcp-tools.mjs';
import { matchIntent } from '../action-matcher.mjs';

let passed = 0;
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-bridge-'));
const db = openDb({ path: path.join(tmp, 'gallery.sqlite') });

/** gallery_items + labels + scores fixture（102x1 PNG 头构造真实魔数）。 */
function seedItem(id, fileName, sourceClass) {
  db.prepare(
    `INSERT OR IGNORE INTO gallery_items (id, file_name, real_format, ext, source_class, review_state)
     VALUES (?, ?, 'png', '.png', ?, 'labeled')`
  ).run(id, fileName, sourceClass);
}
function seedLabel(itemId, field, value) {
  db.prepare(
    `INSERT OR IGNORE INTO gallery_labels (item_id, field, value, evidence_level)
     VALUES (?, ?, ?, 'inferred')`
  ).run(itemId, field, value);
}
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
function writePng(dir, name, repeat = 1) {
  const buf = Buffer.concat(Array.from({ length: repeat }, () => PNG_1PX));
  fs.writeFileSync(path.join(dir, name), buf);
}

console.log('GALLERY-BRIDGE（裁决书 §3/§4）');

ok('迁移 v10：gallery_scores DDL 与裁决书一致，SCHEMA_VERSION=10', () => {
  assert.equal(SCHEMA_VERSION, 10);
  const cols = db.prepare("SELECT name FROM pragma_table_info('gallery_scores')").all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['breakdown_json', 'item_id', 'score', 'scored_at', 'scorer']);
});

ok('repo 幂等 upsert + 来源优先级：vision/blend 优先于 rule-engine（重导入不降级）', () => {
  seedItem(1, 'happy_fan.png', 'fan_art');
  const r1 = upsertGalleryScore(db, { itemId: 1, score: 72, breakdown: { rule: 60, vision: 80 }, scorer: 'vision-agent-v1' });
  assert.equal(r1.applied, true);
  const r2 = upsertGalleryScore(db, { itemId: 1, score: 40, breakdown: { rule: 40 }, scorer: 'rule-engine-v1' });
  assert.equal(r2.applied, false, 'rule-engine 重导入不覆盖 vision 行');
  assert.equal(db.prepare('SELECT score FROM gallery_scores WHERE item_id=1').get().score, 72);
  const r3 = upsertGalleryScore(db, { itemId: 1, score: 85, breakdown: { blended: true }, scorer: 'blend-v1' });
  assert.equal(r3.applied, true, 'blend 可覆盖 vision');
  assert.throws(() => upsertGalleryScore(db, { itemId: 1, score: 120, breakdown: {}, scorer: 'rule-engine-v1' }), /0,100/);
  assert.throws(() => upsertGalleryScore(db, { itemId: 1, score: 50, breakdown: {}, scorer: 'bogus' }), /scorer/);
});

ok('repo top 查询：score 降序、limit clamp 至 3、emotion 过滤（expression/motion_cue）', () => {
  seedItem(2, 'angry_gif.gif', 'gif_reference');
  seedItem(3, 'smile_art.png', 'fan_art');
  seedItem(4, 'plain_photo.png', 'photo');
  seedLabel(2, 'expression', 'angry');
  seedLabel(3, 'motion_cue', 'happy_jump');
  upsertGalleryScore(db, { itemId: 2, score: 66, breakdown: {}, scorer: 'rule-engine-v1' });
  upsertGalleryScore(db, { itemId: 3, score: 61, breakdown: {}, scorer: 'rule-engine-v1' });
  upsertGalleryScore(db, { itemId: 4, score: 30, breakdown: {}, scorer: 'rule-engine-v1' });
  const all = listTopGalleryItems(db, {});
  assert.deepEqual(all.map((r) => r.itemId), [1, 2, 3], 'score 降序：85(1) > 66(2) > 61(3)，30(4) 出 top3');
  assert.equal(listTopGalleryItems(db, { limit: 99 }).length, 3, 'limit clamp 3');
  const angry = listTopGalleryItems(db, { emotion: 'angry' });
  assert.deepEqual(angry.map((r) => r.itemId), [2]);
  const happy = listTopGalleryItems(db, { emotion: 'happy_jump' }); // motion_cue 精确匹配
  assert.deepEqual(happy.map((r) => r.itemId), [3]);
  assert.equal(listTopGalleryItems(db, { emotion: 'sad' }).length, 0);
});

ok('seed prompt_templates：motion-director-v1 幂等写入 active', () => {
  const r = seedMotionDirectorTemplate(db, '你是 DSH Live2D 动作指挥。');
  assert.equal(r.templateId, 'motion-director-v1');
  seedMotionDirectorTemplate(db, '你是 DSH Live2D 动作指挥。v1 更新');
  const row = db.prepare("SELECT body, status FROM prompt_templates WHERE template_id='motion-director-v1' AND version='1'").get();
  assert.equal(row.status, 'active');
  assert.match(row.body, /动作指挥/);
});

ok('gallery-source：读取真实 PNG → base64；缺失/穿越文件名 → fileMissing', async () => {
  const dir = path.join(tmp, 'gallery-dir');
  fs.mkdirSync(dir, { recursive: true });
  writePng(dir, 'happy_fan.png');   // item 1
  writePng(dir, 'smile_art.png');   // item 3
  const src = createGallerySource({ db, galleryDir: dir, fsImpl: fs });
  const rows = await src.top(undefined, 3);
  const fan = rows.find((r) => r.itemId === 3);
  assert.equal(fan.fileMissing, false);
  assert.equal(fan.mimeType, 'image/png');
  assert.ok(fan.base64.length > 0);
  const missing = rows.find((r) => r.itemId === 2); // angry_gif.gif 未写入目录
  assert.equal(missing.fileMissing, true);
  // 读取抛错也归为 fileMissing，不抛穿
  const failing = createGallerySource({ db, galleryDir: dir, fsImpl: { readFileSync: () => { throw new Error('io'); } } });
  const rows2 = await failing.top(undefined, 3);
  assert.equal(rows2.every((r) => r.fileMissing === true), true);
});

okAsync('mcp-tools l2d_gallery_top：护栏三件套（空集提示 / clamp 3 / >2MB 跳过）+ 未注入不注册', async () => {
  const captured = [];
  const fakeRegistry = { registerTool: (name, handler) => captured.push({ name, handler }) };
  const fakeDeps = { enqueue: () => {}, getStatus: () => {}, cancel: () => {}, workspace: { id: 'ws', controlSessionId: 'c' }, validateAction: () => true };
  registerLive2DTools(fakeRegistry, { ...fakeDeps });
  assert.deepEqual(captured.map((c) => c.name), ['l2d_action_enqueue', 'l2d_action_status', 'l2d_action_cancel'], 'gallery 未注入不注册 l2d_gallery_top');

  const names = [];
  const reg2 = { registerTool: (name, handler) => { names.push(name); captured.push({ name, handler }); } };
  const galleryDir = path.join(tmp, 'gallery-dir');
  const source = createGallerySource({ db, galleryDir, fsImpl: fs });
  registerLive2DTools(reg2, { ...fakeDeps, gallery: source });
  assert.ok(names.includes('l2d_gallery_top'));

  const top = captured.find((c) => c.name === 'l2d_gallery_top').handler;
  // 空集 → 「打分未完成」提示，不退化随机
  const none = await top({ emotion: 'sad', limit: 3 });
  assert.match(none.content[0].text, /打分未完成/);
  // 有数据：文本清单 + image content；文件缺失行只进文本；图片总数 ≤3
  const some = await top({ limit: 99 });
  const images = some.content.filter((c) => c.type === 'image');
  const text = some.content.find((c) => c.type === 'text').text;
  assert.ok(images.length >= 1 && images.length <= 3, 'limit clamp 3 + 图片硬上限');
  assert.match(text, /item_id=3 score=61 source=fan_art/);
  assert.match(text, /item_id=2.*文件缺失/);
  // >2MB 跳过：注入 oversized 行验证护栏
  const oversizedRows = [{
    itemId: 9, score: 90, sourceClass: 'fan_art', emotionSummary: '',
    base64: 'A'.repeat(Math.ceil(3 * 1024 * 1024 * 4 / 3)), mimeType: 'image/png', fileMissing: false, oversized: true,
  }];
  const regX = { registerTool: (name, handler) => captured.push({ name: name + '#x', handler }) };
  registerLive2DTools(regX, { ...fakeDeps, gallery: { top: async () => oversizedRows } });
  const hx = captured.filter((c) => c.name === 'l2d_gallery_top#x')[0].handler;
  const out = await hx({ limit: 3 });
  assert.equal(out.content.filter((c) => c.type === 'image').length, 0, '单图 >2MB 被跳过');
  assert.match(out.content.find((c) => c.type === 'text').text, /单图 >2MB/);
});

okAsync('matcher 命中附图（§4.2）：score>60 附 top-1；≤60 不附；无 gallery 注入行为不变', async () => {
  const intent = { modelId: 'm-cur', capabilityId: 'gesture.right_finger', status: 'waiting_input', emotion: 'angry' };
  const cand = { modelId: 'm-cur', actionId: 'act.a', motionId: 'm-1', chainId: 'ch', capabilityId: 'gesture.right_finger', statusTags: ['waiting_input'], emotions: [{ emotion: 'angry', expression: 'scowl', reviewState: 'approved' }] };
  const withGallery = await matchIntent(intent, [cand], { successRate: () => 1, gallery: { top: async () => [{ itemId: 2, score: 66, sourceClass: 'gif_reference', emotionSummary: 'angry', base64: 'aGk=', mimeType: 'image/gif', fileMissing: false, oversized: false }] } });
  assert.equal(withGallery.status, 'adopted');
  assert.equal(withGallery.attachment.itemId, 2);
  assert.equal(withGallery.attachment.base64, 'aGk=');
  const lowScore = await matchIntent(intent, [cand], { successRate: () => 1, gallery: { top: async () => [{ itemId: 4, score: 59, sourceClass: 'photo', emotionSummary: '', base64: null, mimeType: null, fileMissing: false, oversized: false }] } });
  assert.equal(lowScore.attachment, undefined, 'score≤60 不附（不空凑）');
  const noGallery = await matchIntent(intent, [cand], { successRate: () => 1 });
  assert.equal(noGallery.attachment, undefined, 'gallery 未注入 → 与 P12 行为完全一致');
  // P12 回归：matcher 原有验收不受附图改动影响（在 runner 的 test:supervisor 中复核）
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
