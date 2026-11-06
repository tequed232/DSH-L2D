/**
 * score.mjs 回归（CODE-FIX-2：M2 / M3）。
 * 以子进程方式跑脚本（env 覆写 DB_PATH / DRAFT_PATH / GALLERY_DIR），
 * 不 mock 文件系统，验证真实 JSON 产物。
 * 直跑：node --experimental-sqlite tools/gallery-schema/score.test.mjs
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/score\.test\.mjs$/, 'score.mjs');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'score-reg-'));
const dbPath = path.join(tmp, 'scores.sqlite');
const draftPath = path.join(tmp, 'draft.json');
const galleryDir = path.join(tmp, 'gallery');
fs.mkdirSync(galleryDir, { recursive: true });

// 种子库：两个 item，无标签 → 规则分 base_score=0（photo prior=0，便于精确断言）
{
  const db = openDb({ path: dbPath });
  db.prepare(
    `INSERT INTO gallery_items (id, file_name, real_format, ext, source_class, review_state)
     VALUES (?, ?, 'png', '.png', 'photo', 'labeled')`
  ).run(1, 'a.png');
  db.prepare(
    `INSERT INTO gallery_items (id, file_name, real_format, ext, source_class, review_state)
     VALUES (?, ?, 'png', '.png', 'photo', 'labeled')`
  ).run(2, 'b.png');
  db.close();
}
fs.writeFileSync(path.join(galleryDir, 'a.png'), 'x');
fs.writeFileSync(path.join(galleryDir, 'b.png'), 'x');

function run() {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, DRAFT_PATH: draftPath, GALLERY_DIR: galleryDir },
  });
}

console.log('score.mjs 回归（M2 / M3）');

ok('M2 回归：vision 缺 body/clarity → 按纯规则分处理 + 计入 anomalies，不产 NaN 分', () => {
  fs.writeFileSync(draftPath, JSON.stringify({
    schema: 'gallery-scores-draft/v1', items: [
      { item_id: 1, file_name: 'a.png', source_class: 'photo', rule: {}, vision: { expression: 80, body: null, clarity: 70 } }, // body 缺失
      { item_id: 2, file_name: 'b.png', source_class: 'photo', rule: {}, vision: { expression: 50, body: 60, clarity: 70 } },  // 完整 → blend
    ], anomalies: [],
  }));
  const r = run();
  assert.equal(r.status, 0, `退出码 0（stderr: ${r.stderr}）`);
  const out = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const it1 = out.items.find((i) => i.item_id === 1);
  const it2 = out.items.find((i) => i.item_id === 2);
  assert.equal(it1.score, 0, '不完整 vision → 纯规则分 0（原实现 NaN → 导入侧静默丢分）');
  assert.equal(it1.scorer, 'rule-engine-v1');
  assert.ok(!out.items.some((i) => Number.isNaN(i.score)), '全表无 NaN 分');
  assert.ok(
    out.anomalies.some((a) => a.item_id === 1 && a.issue === 'vision_incomplete_fields_treated_as_rule'),
    '不完整条目计入 anomalies（可察觉，不静默）'
  );
  assert.equal(it2.score, 34.8, '完整 vision → blend：0.4*0 + 0.6*(0.4*50+0.4*60+0.2*70)=34.8');
  assert.equal(it2.scorer, 'blend-v1');
  assert.ok(!fs.existsSync(`${draftPath}.tmp`), '正常跑完无 .tmp 残留（M3 原子写）');
});

ok('M3 回归：draft 解析失败 → fail-fast 退出码 1，拒绝覆盖既有文件', () => {
  fs.writeFileSync(draftPath, '{broken json!!!', 'utf8'); // 模拟截断损坏
  const r = run();
  assert.equal(r.status, 1, 'fail-fast 非零退出（原实现 warn 后按空 draft 覆盖写回）');
  assert.equal(fs.readFileSync(draftPath, 'utf8'), '{broken json!!!', '损坏文件未被覆盖（原实现会全量规则分覆盖，视觉分明细永久丢失）');
  assert.match(r.stderr, /拒绝覆盖写/);
  assert.ok(!fs.existsSync(`${draftPath}.tmp`), 'fail-fast 路径不留 .tmp');
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项用例）`);
if (process.exitCode) process.exit(1);
